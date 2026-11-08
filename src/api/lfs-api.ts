/**
 * Git LFS management API under /api/repos/:repo/lfs (session cookie or API
 * key; repoAccess middleware enforces read for GET and write otherwise).
 * This is what the dashboard, the CLI and the MCP tools use. The git-lfs
 * client itself talks to src/api/lfs.ts under /git.
 *
 *   GET  /:repo/lfs                 stats, policy, tracked patterns, endpoint
 *   GET  /:repo/lfs/objects         paginated object list
 *   GET  /:repo/lfs/objects/:oid    download (302 to presigned R2 URL, or stream)
 *                                   ?proxy=1 streams through the Worker
 *                                   ?inline=1 + a video filename serves it for playback (Range, video Content-Type)
 *   POST /:repo/lfs/token           mint a short-lived LFS bearer token
 */
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { RepoVariables } from '../middleware/repo-access.ts';
import { getArtifactFileContent } from '../lib/artifact-reader.ts';
import { isValidOid, lfsObjectKey, lfsTrackedPatterns } from '../lib/lfs.ts';
import { lfsRepoStats } from '../lib/lfs-storage.ts';
import { mintLfsToken } from '../lib/lfs-token.ts';
import { mediaHeaders, parseByteRange, videoContentType } from '../lib/media.ts';
import { presignConfig, presignDownload } from '../lib/r2-presign.ts';
import { lfsDocsUrl, lfsMaxObjectBytes, lfsTransferMode, lfsUrlTtlSeconds, publicOrigin } from './lfs.ts';

const app = new Hono<{ Bindings: Env; Variables: RepoVariables }>();

/** Everything a client needs to decide how to handle large files in a repo. */
export async function lfsSummary(env: Env, origin: string, repo: RepoVariables['repoRecord']) {
	const [stats, gitattributes] = await Promise.all([
		lfsRepoStats(env.DB, repo.id),
		getArtifactFileContent(env, repo.name, '.gitattributes', repo.default_branch || 'main'),
	]);
	return {
		enabled: repo.lfs_enabled !== 0,
		transfer_mode: lfsTransferMode(env),
		max_object_bytes: lfsMaxObjectBytes(env, repo),
		object_count: stats.object_count,
		total_bytes: stats.total_bytes,
		pending_count: stats.pending_count,
		tracked_patterns: gitattributes ? lfsTrackedPatterns(gitattributes) : [],
		endpoint: `${origin}/git/${encodeURIComponent(repo.name)}.git/info/lfs`,
		docs_url: lfsDocsUrl(env, origin),
		note: 'Files over 32 MB must be committed through Git LFS (git lfs track "<pattern>"); GitFlare rejects oversized blobs with a fix recipe.',
	};
}

app.get('/:repo/lfs', async (c) => {
	const repo = c.get('repoRecord');
	return c.json({ data: await lfsSummary(c.env, publicOrigin(c.env, c.req.url), repo) });
});

app.get('/:repo/lfs/objects', async (c) => {
	const repo = c.get('repoRecord');
	const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
	const { results } = await c.env.DB.prepare(
		'SELECT oid, size, state, created_at FROM lfs_objects WHERE repo_id = ? ORDER BY created_at DESC, oid LIMIT ? OFFSET ?'
	)
		.bind(repo.id, limit + 1, offset)
		.all<{ oid: string; size: number; state: string; created_at: string }>();
	const hasMore = results.length > limit;
	return c.json({ data: results.slice(0, limit), limit, offset, has_more: hasMore });
});

app.get('/:repo/lfs/objects/:oid', async (c) => {
	const repo = c.get('repoRecord');
	const oid = c.req.param('oid');
	if (!isValidOid(oid)) return c.json({ error: 'oid must be a lowercase hex sha256' }, 400);
	const filename = (c.req.query('filename') || oid).split('/').pop() || oid;
	const key = lfsObjectKey(repo.id, oid);
	// inline=1 only changes the response for allowlisted video extensions.
	const videoType = c.req.query('inline') === '1' ? videoContentType(filename) : null;

	// ?proxy=1 streams through the Worker even in presigned mode: the dashboard's
	// 3D viewer and video player need same-origin bytes (and Range, for video).
	const presign = c.req.query('proxy') === '1' ? null : presignConfig(c.env);
	if (presign) {
		const head = await c.env.STORAGE.head(key);
		if (!head) return c.json({ error: 'Object not found' }, 404);
		const url = await presignDownload(
			presign,
			key,
			lfsUrlTtlSeconds(c.env),
			filename,
			videoType ? { disposition: 'inline', contentType: videoType } : undefined
		);
		return c.redirect(url, 302);
	}
	return streamStoredObject(c.env.STORAGE, key, c.req.raw, filename, videoType);
});

/** Stream an R2 object. A Range header returns 206 so a <video> element can seek without pulling the whole file. */
async function streamStoredObject(
	bucket: Env['STORAGE'],
	key: string,
	request: Request,
	filename: string,
	videoType: string | null
): Promise<Response> {
	const headersFor = (extra?: Record<string, string>) => {
		const headers = videoType
			? mediaHeaders({
					contentType: videoType,
					filename,
					disposition: 'inline',
					cacheControl: 'private, no-transform',
					sandbox: true,
				})
			: mediaHeaders({
					contentType: 'application/octet-stream',
					filename,
					disposition: 'attachment',
					cacheControl: 'private, no-transform',
				});
		if (extra) for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		return headers;
	};

	const rangeHeader = request.headers.get('Range');
	if (!rangeHeader) {
		const object = await bucket.get(key);
		if (!object) return new Response(JSON.stringify({ error: 'Object not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
		const headers = headersFor();
		headers.set('Content-Length', String(object.size));
		return new Response(object.body, { status: 200, headers });
	}

	const head = await bucket.head(key);
	if (!head) return new Response(JSON.stringify({ error: 'Object not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
	const range = parseByteRange(rangeHeader, head.size);
	if (range === 'invalid' || !range) {
		return new Response(null, { status: 416, headers: headersFor({ 'Content-Range': `bytes */${head.size}` }) });
	}
	const object = await bucket.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
	if (!object) return new Response(JSON.stringify({ error: 'Object not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
	const headers = headersFor({
		'Content-Length': String(range.end - range.start + 1),
		'Content-Range': `bytes ${range.start}-${range.end}/${head.size}`,
	});
	return new Response(object.body, { status: 206, headers });
}

/**
 * Mint a bearer token for scripts that need LFS without an API key (same
 * minting path the CI dispatcher uses). POST needs write access on the repo
 * (repoAccess), so `write` tokens are only issued to writers.
 */
app.post('/:repo/lfs/token', async (c) => {
	const repo = c.get('repoRecord');
	let body: { scope?: unknown; ttl_seconds?: unknown } = {};
	try {
		body = (await c.req.json()) ?? {};
	} catch {
		/* empty body is fine */
	}
	const scope = body.scope === 'write' ? 'write' : 'read';
	const ttl = Math.min(Math.max(Number(body.ttl_seconds) || 900, 60), 24 * 3600);
	const token = await mintLfsToken(c.env.ENCRYPTION_KEY, { repoId: repo.id, scope, ttlSeconds: ttl });
	const origin = publicOrigin(c.env, c.req.url);
	return c.json({
		data: {
			token,
			scope,
			expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
			endpoint: `${origin}/git/${encodeURIComponent(repo.name)}.git/info/lfs`,
			usage: 'git -c lfs.url=<endpoint> -c "http.<endpoint>.extraHeader=Authorization: Bearer <token>" lfs pull',
		},
	});
});

export default app;
