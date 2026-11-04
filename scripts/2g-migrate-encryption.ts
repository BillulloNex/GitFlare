/**
 * Phase 2g — Re-encrypt github_mirrors.github_token_encrypted to `v1:` format.
 *
 * Stored values today come in three shapes:
 *   - `v1:…`       already migrated (HKDF(ENCRYPTION_KEY) → AES-256-GCM) — skipped
 *   - legacy       REST-created mirrors: base64(iv||ciphertext), PBKDF2(SESSION_SECRET)
 *   - plaintext    MCP-created mirrors from before Phase 1c stored the raw PAT
 *
 * Plaintext is accepted ONLY here (never at runtime), and only when the value
 * looks like a GitHub token. Anything that is neither decryptable nor a
 * recognisable token is reported and left untouched; the script then exits 1.
 *
 * ROLLOUT ORDER (see IMPLEMENTATION_PLAN.md 2g):
 *   1. `wrangler secret put ENCRYPTION_KEY` (generate with `openssl rand -base64 32`)
 *   2. Deploy the Phase 2 Worker (runtime reads v1 + legacy).
 *   3. Run this script (dry run, then --apply).
 *   4. Once `--verify` reports every row as v1, SESSION_SECRET's legacy-decrypt
 *      role can be retired in a follow-up.
 *
 * Usage (Node ≥ 22.18 runs .ts directly; on older 22.x add --experimental-strip-types):
 *
 *   export ENCRYPTION_KEY=…   # same value as the Worker secret
 *   export SESSION_SECRET=…   # same value as the Worker secret
 *   node scripts/2g-migrate-encryption.ts            # dry run: report only
 *   node scripts/2g-migrate-encryption.ts --apply    # write updates to D1
 *   node scripts/2g-migrate-encryption.ts --verify   # confirm all rows are v1
 *
 * Options:
 *   --local          target the local D1 (default: --remote)
 *   --db <name>      database name (default: gitflare-db)
 *
 * --local          also accepts --persist-to <dir> (passed through to wrangler)
 *
 * ENCRYPTION_KEY / SESSION_SECRET are read from the environment and never
 * written to disk or logged. The generated UPDATE file holds the new `v1:`
 * values plus each row's current stored value (used as a compare-and-swap
 * guard, so for plaintext rows that is the PAT already sitting in D1). It is
 * created 0600 in a private temp dir and deleted immediately after use.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.ts';

type Mode = 'dry-run' | 'apply' | 'verify';
type Row = { id: string; github_token_encrypted: string };
type Outcome =
	| { id: string; kind: 'v1' }
	| { id: string; kind: 'legacy' | 'plaintext'; newValue: string; oldValue: string }
	| { id: string; kind: 'error'; reason: string };

const args = process.argv.slice(2);
const mode: Mode = args.includes('--apply') ? 'apply' : args.includes('--verify') ? 'verify' : 'dry-run';
const target = args.includes('--local') ? '--local' : '--remote';
const dbIndex = args.indexOf('--db');
const dbName = dbIndex >= 0 ? args[dbIndex + 1] : 'gitflare-db';
const persistIndex = args.indexOf('--persist-to');
const persistArgs = target === '--local' && persistIndex >= 0 ? ['--persist-to', args[persistIndex + 1]] : [];

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET ?? '';

/** GitHub token formats: classic, fine-grained, OAuth, user-to-server, server-to-server, refresh. */
const GITHUB_TOKEN_RE = /^(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

function wrangler(extra: string[]): string {
	return execFileSync('npx', ['wrangler', 'd1', 'execute', dbName, target, ...persistArgs, ...extra], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		maxBuffer: 64 * 1024 * 1024,
	});
}

function query<T>(sql: string): T[] {
	const out = wrangler(['--json', '--command', sql]);
	const parsed = JSON.parse(out) as Array<{ results: T[]; success: boolean }>;
	if (!parsed.every((r) => r.success)) throw new Error(`D1 query failed: ${sql}`);
	return parsed.flatMap((r) => r.results);
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

async function classify(row: Row): Promise<Outcome> {
	const stored = row.github_token_encrypted;

	if (stored.startsWith('v1:')) {
		try {
			await decryptSecret(stored, ENCRYPTION_KEY);
			return { id: row.id, kind: 'v1' };
		} catch {
			return { id: row.id, kind: 'error', reason: 'v1 value does not decrypt with this ENCRYPTION_KEY' };
		}
	}

	// Legacy AES-GCM (REST-created). decryptSecret throws if base64 or the GCM tag check fails.
	try {
		const plaintext = await decryptSecret(stored, ENCRYPTION_KEY, SESSION_SECRET);
		return { id: row.id, kind: 'legacy', oldValue: stored, newValue: await encryptSecret(plaintext, ENCRYPTION_KEY) };
	} catch {
		// fall through to plaintext check
	}

	// Plaintext (MCP-created before Phase 1c). Migration-only fallback.
	if (GITHUB_TOKEN_RE.test(stored)) {
		return { id: row.id, kind: 'plaintext', oldValue: stored, newValue: await encryptSecret(stored, ENCRYPTION_KEY) };
	}

	return { id: row.id, kind: 'error', reason: 'not v1, not legacy AES-GCM under this SESSION_SECRET, not a GitHub token' };
}

async function main(): Promise<void> {
	if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set in the environment');
	if (mode !== 'verify' && !SESSION_SECRET) throw new Error('SESSION_SECRET must be set in the environment');

	console.log(`[2g] mode=${mode} db=${dbName} target=${target}`);
	const rows = query<Row>('SELECT id, github_token_encrypted FROM github_mirrors ORDER BY id');
	console.log(`[2g] ${rows.length} mirror row(s)`);

	const outcomes: Outcome[] = [];
	for (const row of rows) outcomes.push(await classify(row));

	const counts: Record<string, number> = { v1: 0, legacy: 0, plaintext: 0, error: 0 };
	for (const o of outcomes) {
		counts[o.kind]++;
		// Never print secret material — ids and classification only.
		const detail = o.kind === 'error' ? ` (${o.reason})` : '';
		console.log(`  ${o.id}  ${o.kind}${detail}`);
	}
	console.log(`[2g] v1=${counts.v1} legacy=${counts.legacy} plaintext=${counts.plaintext} error=${counts.error}`);

	if (mode === 'verify') {
		const notV1 = outcomes.length - counts.v1;
		if (notV1 > 0) {
			console.error(`[2g] VERIFY FAILED: ${notV1} row(s) are not decryptable v1 values`);
			process.exit(1);
		}
		console.log('[2g] VERIFY OK: every mirror token is v1 and decrypts with ENCRYPTION_KEY');
		return;
	}

	const updates = outcomes.filter((o): o is Extract<Outcome, { newValue: string }> => 'newValue' in o);
	if (mode === 'dry-run') {
		console.log(`[2g] dry run: ${updates.length} row(s) would be re-encrypted. Re-run with --apply.`);
	} else if (updates.length > 0) {
		// Compare-and-swap on the old value, so a token rotated via the API
		// between our SELECT and this UPDATE is not overwritten.
		const sql = updates
			.map(
				(u) =>
					`UPDATE github_mirrors SET github_token_encrypted = ${sqlString(u.newValue)}, updated_at = datetime('now') ` +
					`WHERE id = ${sqlString(u.id)} AND github_token_encrypted = ${sqlString(u.oldValue)};`
			)
			.join('\n');
		const dir = mkdtempSync(join(tmpdir(), 'gitflare-2g-'));
		const file = join(dir, 'updates.sql');
		try {
			writeFileSync(file, sql + '\n', { mode: 0o600 });
			wrangler(['--file', file, '--yes']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		console.log(`[2g] applied ${updates.length} update(s). Run with --verify to confirm.`);
	} else {
		console.log('[2g] nothing to update.');
	}

	if (counts.error > 0) {
		console.error(`[2g] ${counts.error} row(s) could not be migrated — inspect them manually.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[2g] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
