/**
 * Phase 3b — Backfill `repo_members` so existing repos have an owner before
 * the Phase 3a access middleware ships. RUN THIS BEFORE DEPLOYING PHASE 3,
 * otherwise non-admin users lose write access to repos they created, and
 * every private repo becomes visible only to global admins.
 *
 * For each repository:
 *   1. Find the earliest `audit_log` row with action='repo.create' for it.
 *   2. actor is a `users.id`                       → that user becomes `admin`
 *   3. actor is an `api_keys.id` with a `user_id`  → that key's user becomes `admin`
 *   4. otherwise (key without user_id e.g. bootstrap, deleted key, 'system',
 *      or no audit row at all e.g. MCP-created repos)
 *                                                  → every ADMIN_EMAILS user becomes `admin`
 *   5. ADMIN_EMAILS unset/unmatched and no creator  → warn, repo left without members
 *                                                    (flagged for manual review)
 *
 * ADMIN_EMAILS users must already have a `users` row (i.e. have signed in at
 * least once). Unmatched emails are logged as warnings.
 *
 * Writes use `INSERT OR IGNORE`, so the script is idempotent and never
 * changes an existing membership's role.
 *
 * Usage (Node ≥ 22.18 runs .ts directly; on older 22.x add --experimental-strip-types):
 *
 *   export ADMIN_EMAILS=alice@example.com,bob@example.com   # same as the Worker var
 *   node scripts/3b-backfill-members.ts            # dry run: report only
 *   node scripts/3b-backfill-members.ts --apply    # write inserts to D1
 *
 * Options:
 *   --local          target the local D1 (default: --remote)
 *   --db <name>      database name (default: gitflare-db)
 *   --persist-to <dir>  with --local, passed through to wrangler
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Repo = { id: string; name: string };
type AuditRow = { repo_id: string; actor: string; created_at: string };
type User = { id: string; email: string };
type Key = { id: string; user_id: string | null };
type Member = { repo_id: string; user_id: string };

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const target = args.includes('--local') ? '--local' : '--remote';
const dbIndex = args.indexOf('--db');
const dbName = dbIndex >= 0 ? args[dbIndex + 1] : 'gitflare-db';
const persistIndex = args.indexOf('--persist-to');
const persistArgs = target === '--local' && persistIndex >= 0 ? ['--persist-to', args[persistIndex + 1]] : [];

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
	.split(',')
	.map((e) => e.trim().toLowerCase())
	.filter(Boolean);

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

function main(): void {
	console.log(`[3b] mode=${apply ? 'apply' : 'dry-run'} db=${dbName} target=${target}`);

	const repos = query<Repo>('SELECT id, name FROM repositories ORDER BY created_at');
	const audits = query<AuditRow>(
		"SELECT repo_id, actor, created_at FROM audit_log WHERE action = 'repo.create' AND repo_id IS NOT NULL ORDER BY created_at ASC"
	);
	const users = query<User>('SELECT id, email FROM users');
	const keys = query<Key>('SELECT id, user_id FROM api_keys');
	const existing = query<Member>('SELECT repo_id, user_id FROM repo_members');

	const usersById = new Map(users.map((u) => [u.id, u]));
	const usersByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
	const keysById = new Map(keys.map((k) => [k.id, k]));
	const existingSet = new Set(existing.map((m) => `${m.repo_id}\u0000${m.user_id}`));

	// Earliest repo.create per repo.
	const creatorActor = new Map<string, string>();
	for (const a of audits) {
		if (!creatorActor.has(a.repo_id)) creatorActor.set(a.repo_id, a.actor);
	}

	// Resolve ADMIN_EMAILS → users once.
	const adminUsers: User[] = [];
	for (const email of ADMIN_EMAILS) {
		const u = usersByEmail.get(email);
		if (u) adminUsers.push(u);
		else console.warn(`[3b] WARNING: ADMIN_EMAILS entry ${email} has no users row (sign in once, then re-run)`);
	}
	if (ADMIN_EMAILS.length === 0) {
		console.warn('[3b] WARNING: ADMIN_EMAILS is not set — repos without a resolvable creator will get no members');
	}

	console.log(`[3b] ${repos.length} repo(s), ${audits.length} repo.create audit row(s), ${users.length} user(s)`);

	const inserts: { repoId: string; userId: string }[] = [];
	const unowned: string[] = [];

	for (const repo of repos) {
		const actor = creatorActor.get(repo.id);
		let owners: User[] = [];
		let source: string;

		if (actor && usersById.has(actor)) {
			owners = [usersById.get(actor)!];
			source = 'creator (session user)';
		} else if (actor && keysById.get(actor)?.user_id && usersById.has(keysById.get(actor)!.user_id!)) {
			owners = [usersById.get(keysById.get(actor)!.user_id!)!];
			source = 'creator (API key owner)';
		} else {
			owners = adminUsers;
			source = !actor
				? 'no repo.create audit row → ADMIN_EMAILS'
				: actor === 'system'
					? "actor 'system' → ADMIN_EMAILS"
					: keysById.has(actor)
						? 'key without user_id → ADMIN_EMAILS'
						: 'unknown/deleted actor → ADMIN_EMAILS';
		}

		if (owners.length === 0) {
			unowned.push(repo.name);
			console.warn(`  ${repo.name}  SKIPPED — ${source}, but no admin users resolved (needs manual review)`);
			continue;
		}

		for (const owner of owners) {
			const already = existingSet.has(`${repo.id}\u0000${owner.id}`);
			console.log(`  ${repo.name}  → ${owner.email} admin  [${source}]${already ? ' (already a member — unchanged)' : ''}`);
			if (!already) inserts.push({ repoId: repo.id, userId: owner.id });
		}
	}

	console.log(`[3b] ${inserts.length} membership(s) to insert, ${unowned.length} repo(s) without an owner`);

	if (!apply) {
		console.log('[3b] dry run: nothing written. Re-run with --apply.');
	} else if (inserts.length > 0) {
		const now = new Date().toISOString();
		const sql = inserts
			.map(
				(i) =>
					`INSERT OR IGNORE INTO repo_members (repo_id, user_id, role, created_at) ` +
					`VALUES (${sqlString(i.repoId)}, ${sqlString(i.userId)}, 'admin', ${sqlString(now)});`
			)
			.join('\n');
		const dir = mkdtempSync(join(tmpdir(), 'gitflare-3b-'));
		const file = join(dir, 'members.sql');
		try {
			writeFileSync(file, sql + '\n', { mode: 0o600 });
			wrangler(['--file', file, '--yes']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		console.log(`[3b] applied ${inserts.length} insert(s).`);
	} else {
		console.log('[3b] nothing to insert.');
	}

	if (unowned.length > 0) {
		console.error(`[3b] ${unowned.length} repo(s) have no members — review manually: ${unowned.join(', ')}`);
		process.exit(1);
	}
}

try {
	main();
} catch (err) {
	console.error(`[3b] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
