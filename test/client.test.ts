import { describe, expect, it } from 'vitest';
import { GitFlareClient } from '../packages/gitflare-client/src/client.ts';
import { GitFlareError } from '../packages/gitflare-client/src/types.ts';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

/** Client wired to a fake fetch that returns `status`/`payload` and records each request. */
function setup(payload: unknown, status = 200, opts: { apiKey?: string; headers?: Record<string, string> } = {}) {
	const calls: Call[] = [];
	const client = new GitFlareClient({
		baseUrl: 'https://git.example.com/',
		apiKey: opts.apiKey ?? 'gf_test_key',
		headers: opts.headers,
		fetch: async (url, init) => {
			calls.push({
				url,
				method: init?.method ?? 'GET',
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
			return new Response(text, { status, statusText: status === 200 ? 'OK' : 'Error' });
		},
	});
	return { client, calls };
}

describe('client response unwrapping', () => {
	it('unwraps { data } envelopes', async () => {
		const runs = [{ id: 'r1', status: 'passed' }];
		const { client } = setup({ data: runs });
		expect(await client.ci.runs('repo')).toEqual(runs);
	});

	it('unwraps named envelopes: repos, keys, mirror', async () => {
		expect(await setup({ repos: [{ name: 'a' }] }).client.repos.list()).toEqual([{ name: 'a' }]);
		expect(await setup({ keys: [{ id: 'k' }] }).client.keys.list()).toEqual([{ id: 'k' }]);
		expect(await setup({ mirror: { github_repo: 'o/r' } }).client.mirrors.get('repo')).toEqual({ github_repo: 'o/r' });
	});

	it('keeps a present-but-null envelope value (no mirror configured)', async () => {
		expect(await setup({ mirror: null }).client.mirrors.get('repo')).toBeNull();
	});

	it('keeps falsy data values such as empty arrays', async () => {
		expect(await setup({ data: [] }).client.commits.list('repo')).toEqual([]);
	});

	it('throws GitFlareError when the envelope key is missing', async () => {
		const { client } = setup({ runs: [] });
		const err = await client.ci.runs('repo').catch((e) => e);
		expect(err).toBeInstanceOf(GitFlareError);
		expect(err.message).toMatch(/missing "data"/);
		expect(err.body).toEqual({ runs: [] });
	});

	it('throws GitFlareError for a non-object JSON body', async () => {
		await expect(setup(null).client.ci.runs('repo')).rejects.toBeInstanceOf(GitFlareError);
		await expect(setup('[1,2]').client.repos.list()).rejects.toBeInstanceOf(GitFlareError);
	});

	it('returns non-enveloped endpoints as-is', async () => {
		const created = { id: 'x', name: 'new', clone_url: 'https://git.example.com/git/new' };
		expect(await setup(created).client.repos.create({ name: 'new' })).toEqual(created);
	});
});

describe('client errors', () => {
	it('surfaces the server error message and status', async () => {
		const err = await setup({ error: 'Run is already passed' }, 409).client.ci.cancel('repo', 'r1').catch((e) => e);
		expect(err).toBeInstanceOf(GitFlareError);
		expect(err.status).toBe(409);
		expect(err.message).toBe('GitFlare API error 409: Run is already passed');
	});

	it('appends string details', async () => {
		const err = await setup({ error: 'Bad input', details: 'name required' }, 400).client.repos.list().catch((e) => e);
		expect(err.message).toBe('GitFlare API error 400: Bad input: name required');
	});

	it('keeps a plain-text error body', async () => {
		const err = await setup('upstream exploded', 502).client.repos.list().catch((e) => e);
		expect(err.status).toBe(502);
		expect(err.message).toBe('GitFlare API error 502: upstream exploded');
	});
});

describe('client requests', () => {
	it('builds URLs with encoded segments, query params and bearer auth', async () => {
		const { client, calls } = setup({ data: [] });
		await client.commits.list('my repo', 'feature/x', 5);
		expect(calls[0].url).toBe('https://git.example.com/api/repos/my%20repo/commits?branch=feature%2Fx&limit=5');
		expect(calls[0].method).toBe('GET');
		expect(calls[0].headers.Authorization).toBe('Bearer gf_test_key');
	});

	it('sends `branch` (not `ref`) for commits and omits unset params', async () => {
		const { client, calls } = setup({ data: [] });
		await client.commits.list('r');
		expect(calls[0].url).toBe('https://git.example.com/api/repos/r/commits?limit=20');
	});

	it('POSTs JSON for the cancel endpoint', async () => {
		const { client, calls } = setup({ success: true, data: { id: 'r1', status: 'cancelled', runner: { notified: true } } });
		expect(await client.ci.cancel('repo', 'r1')).toEqual({ id: 'r1', status: 'cancelled', runner: { notified: true } });
		expect(calls[0]).toMatchObject({
			url: 'https://git.example.com/api/repos/repo/ci/runs/r1/cancel',
			method: 'POST',
			body: {},
		});
		expect(calls[0].headers['Content-Type']).toBe('application/json');
	});

	it('lets explicit headers override the API key header', async () => {
		const { client, calls } = setup({ repos: [] }, 200, { apiKey: '', headers: { Authorization: 'Bearer forwarded' } });
		await client.repos.list();
		expect(calls[0].headers.Authorization).toBe('Bearer forwarded');
	});

	it('does not send credentials to the public health endpoint', async () => {
		const { client, calls } = setup({ status: 'ok' });
		await client.health();
		expect(calls[0].headers.Authorization).toBeUndefined();
	});

	it('ci.logs flattens job steps with their global ordinal', async () => {
		const detail = {
			id: 'r1',
			jobs: [
				{ name: 'build', steps: [{ id: 's1', name: 'install', status: 'passed', exit_code: 0, logs: [] }] },
				{ name: 'test', steps: [{ id: 's2', name: 'unit', status: 'failed', exit_code: 1, logs: [] }] },
			],
			raw_steps: [
				{ id: 's1', step_index: 0, global_ordinal: 0 },
				{ id: 's2', step_index: 0, global_ordinal: 1 },
			],
			deployment: null,
		};
		const { client } = setup({ data: detail });
		const logs = await client.ci.logs('repo', 'r1');
		expect(logs.map((l) => [l.index, l.job_name, l.name])).toEqual([
			[0, 'build', 'install'],
			[1, 'test', 'unit'],
		]);
	});
});
