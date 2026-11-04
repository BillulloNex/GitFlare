/**
 * B1.2 — Re-encrypt deploy_targets.coolify_api_key_encrypted to `v1:` format.
 *
 * Despite the column name, values written before B1 are PLAINTEXT (deploy.ts
 * and MCP deploy_add stored the raw key). Stored values come in three shapes:
 *   - `v1:…`     already migrated (HKDF(ENCRYPTION_KEY) → AES-256-GCM) — skipped
 *   - legacy     base64(iv||ciphertext), PBKDF2(SESSION_SECRET) — none expected, handled anyway
 *   - plaintext  everything else (migration-only fallback)
 *
 * ROLLOUT (two-step deploy, IMPLEMENTATION_PLAN.md B1.2):
 *   1. Deploy B1. The consumer uses the TOLERANT reader
 *      (src/lib/deploy-targets.ts readCoolifyApiKey: v1 → legacy → plaintext)
 *      and every new write is `v1:`.
 *   2. Run this script: dry run, then --apply, then --verify.
 *   3. Once --verify passes, switch readCoolifyApiKey to strict decryptSecret
 *      (delete the legacy/plaintext fallbacks) and deploy again.
 *
 * Usage (Node ≥ 22.18 runs .ts directly; on older 22.x add --experimental-strip-types):
 *
 *   export ENCRYPTION_KEY=…   # same value as the Worker secret
 *   export SESSION_SECRET=…   # same value as the Worker secret
 *   node scripts/b1-migrate-coolify-keys.ts            # dry run: report only
 *   node scripts/b1-migrate-coolify-keys.ts --apply    # write updates to D1
 *   node scripts/b1-migrate-coolify-keys.ts --verify   # confirm all rows are v1
 *
 * Options: --local, --db <name>, --persist-to <dir> (with --local)
 *
 * Secrets are read from the environment and never logged. The UPDATE file
 * (new ciphertext + current value as compare-and-swap guard) is written 0600
 * to a private temp dir and deleted immediately after use.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret, legacyDecryptToken } from '../src/lib/crypto.ts';

type Mode = 'dry-run' | 'apply' | 'verify';
type Row = { id: string; coolify_api_key_encrypted: string };
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
	const stored = row.coolify_api_key_encrypted;

	if (stored.startsWith('v1:')) {
		try {
			await decryptSecret(stored, ENCRYPTION_KEY);
			return { id: row.id, kind: 'v1' };
		} catch {
			return { id: row.id, kind: 'error', reason: 'v1 value does not decrypt with this ENCRYPTION_KEY' };
		}
	}

	if (SESSION_SECRET) {
		try {
			const plaintext = await legacyDecryptToken(stored, SESSION_SECRET);
			return { id: row.id, kind: 'legacy', oldValue: stored, newValue: await encryptSecret(plaintext, ENCRYPTION_KEY) };
		} catch {
			// not legacy ciphertext
		}
	}

	// Plaintext (pre-B1 writes). Coolify keys are opaque tokens; reject anything
	// that obviously isn't one (whitespace, control chars, absurd length).
	if (/^[\x21-\x7e]{8,512}$/.test(stored)) {
		return { id: row.id, kind: 'plaintext', oldValue: stored, newValue: await encryptSecret(stored, ENCRYPTION_KEY) };
	}

	return { id: row.id, kind: 'error', reason: 'not v1, not legacy AES-GCM, and does not look like an API token' };
}

async function main(): Promise<void> {
	if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set in the environment');

	console.log(`[b1] mode=${mode} db=${dbName} target=${target}`);
	const rows = query<Row>(
		"SELECT id, coolify_api_key_encrypted FROM deploy_targets WHERE coolify_api_key_encrypted IS NOT NULL AND coolify_api_key_encrypted != '' ORDER BY id"
	);
	console.log(`[b1] ${rows.length} deploy target(s) with a stored Coolify key`);

	const outcomes: Outcome[] = [];
	for (const row of rows) outcomes.push(await classify(row));

	const counts: Record<string, number> = { v1: 0, legacy: 0, plaintext: 0, error: 0 };
	for (const o of outcomes) {
		counts[o.kind]++;
		const detail = o.kind === 'error' ? ` (${o.reason})` : '';
		console.log(`  ${o.id}  ${o.kind}${detail}`);
	}
	console.log(`[b1] v1=${counts.v1} legacy=${counts.legacy} plaintext=${counts.plaintext} error=${counts.error}`);

	if (mode === 'verify') {
		const notV1 = outcomes.length - counts.v1;
		if (notV1 > 0) {
			console.error(`[b1] VERIFY FAILED: ${notV1} row(s) are not decryptable v1 values`);
			process.exit(1);
		}
		console.log('[b1] VERIFY OK: every Coolify key is v1 — safe to switch readCoolifyApiKey to strict decryptSecret');
		return;
	}

	const updates = outcomes.filter((o): o is Extract<Outcome, { newValue: string }> => 'newValue' in o);
	if (mode === 'dry-run') {
		console.log(`[b1] dry run: ${updates.length} row(s) would be re-encrypted. Re-run with --apply.`);
	} else if (updates.length > 0) {
		const sql = updates
			.map(
				(u) =>
					`UPDATE deploy_targets SET coolify_api_key_encrypted = ${sqlString(u.newValue)}, updated_at = datetime('now') ` +
					`WHERE id = ${sqlString(u.id)} AND coolify_api_key_encrypted = ${sqlString(u.oldValue)};`
			)
			.join('\n');
		const dir = mkdtempSync(join(tmpdir(), 'gitflare-b1-'));
		const file = join(dir, 'updates.sql');
		try {
			writeFileSync(file, sql + '\n', { mode: 0o600 });
			wrangler(['--file', file, '--yes']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		console.log(`[b1] applied ${updates.length} update(s). Run with --verify to confirm.`);
	} else {
		console.log('[b1] nothing to update.');
	}

	if (counts.error > 0) {
		console.error(`[b1] ${counts.error} row(s) could not be migrated — inspect them manually.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[b1] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
