import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { CIPipelineConfig } from '../src/env.ts';
import { parseCIConfig } from '../src/lib/ci-parser.ts';
import { selectCompute } from '../src/lib/compute-router.ts';
import { buildGithubWorkflow, type ComputeConnection } from '../src/lib/github-ci.ts';
import { mintMergeToken, verifyMergeToken } from '../src/lib/merge-token.ts';
import { appJwt } from '../src/lib/github-app.ts';
import { generateKeyPairSync, createVerify, createSign } from 'node:crypto';
import type { Env } from '../src/env.ts';
import { verifyGitHubOidc } from '../src/lib/github-oidc.ts';

const config = (runsOn: string | string[]): CIPipelineConfig => ({ name: 'CI', 'runs-on': runsOn, jobs: { test: { steps: [{ run: 'echo ok' }] } } });
const org: ComputeConnection = { id: 'conn', installation_id: 42, account_login: 'Acme', account_type: 'Organization', allow_private: 1, blacksmith_enabled: 1 };

describe('GitHub and Blacksmith CI routing', () => {
	it('keeps existing configs on the runner', () => {
		expect(selectCompute(config('runner'), [org], true).backend).toBe('runner');
		expect(selectCompute({ name: 'CI', jobs: { test: { steps: [] } } }, [org], true).backend).toBe('runner');
	});
	it('routes a private job to its owner connection only when allowed', () => {
		expect(selectCompute(config('blacksmith:Acme'), [org], true).backend).toBe('blacksmith');
		expect(selectCompute(config(['blacksmith', 'runner']), [{ ...org, allow_private: 0 }], true).backend).toBe('runner');
		expect(() => selectCompute(config('blacksmith'), [{ ...org, blacksmith_enabled: 0 }], true)).toThrow('No CI compute');
	});
	it('rejects unsupported mixed job backends and malformed selectors', () => {
		expect(() => selectCompute({ name: 'CI', jobs: { a: { 'runs-on': 'runner', steps: [] }, b: { 'runs-on': 'github', steps: [] } } }, [org], false))
			.toThrow('different runs-on');
		expect(() => parseCIConfig('name: CI\nruns-on: blacksmith; rm -rf /\njobs:\n  test:\n    steps: []\n')).toThrow('runs-on');
	});
});

describe('GitHub dispatch workflow', () => {
	it('contains runnable CI and merge scripts with OIDC permissions', () => {
		const yaml = buildGithubWorkflow('https://git.example.com');
		const doc = parse(yaml) as any;
		expect(doc.on.repository_dispatch.types).toEqual(['gitflare-ci', 'gitflare-merge']);
		expect(doc.permissions['id-token']).toBe('write');
		for (const job of [doc.jobs.ci, doc.jobs.merge]) {
			expect(job['runs-on']).toBe('${{ github.event.client_payload.runner_label }}');
			expect(job.env.GITFLARE_URL).toBe('https://git.example.com');
			const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
			expect(() => new AsyncFunction('require', 'context', 'core', job.steps[0].with.script)).not.toThrow();
		}
	});
});

describe('merge token', () => {
	it('rejects tampering and wrong signing keys', async () => {
		const claims = { repoId: '11111111-1111-1111-1111-111111111111', ticketId: '22222222-2222-2222-2222-222222222222', attemptId: '33333333-3333-3333-3333-333333333333' };
		const token = await mintMergeToken('test-secret', claims);
		expect(await verifyMergeToken('test-secret', token)).toMatchObject(claims);
		expect(await verifyMergeToken('wrong-secret', token)).toBeNull();
		expect(await verifyMergeToken('test-secret', token.replace('22222222', 'aaaaaaaa'))).toBeNull();
	});
});

describe('GitHub App signing', () => {
	it('signs a JWT with GitHub PKCS#1 private keys', async () => {
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const jwt = await appJwt({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem } as Env);
		const [header, payload, signature] = jwt.split('.');
		const verify = createVerify('RSA-SHA256');
		verify.update(`${header}.${payload}`);
		expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
	});
});

describe('GitHub OIDC verification', () => {
	it('requires the exact trusted workflow commit', async () => {
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const repository = 'Acme/gf-example-12345678';
		const workflowSha = 'a'.repeat(40);
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
		const payload = Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', aud: 'gitflare',
			repository, event_name: 'repository_dispatch', workflow_ref: `${repository}/.github/workflows/gitflare.yml@refs/heads/gitflare-control`,
			workflow_sha: workflowSha, run_id: '12345', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
		const sign = createSign('RSA-SHA256');
		sign.update(`${header}.${payload}`);
		const token = `${header}.${payload}.${sign.sign(privateKey).toString('base64url')}`;
		const jwk = publicKey.export({ format: 'jwk' });
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test' }] }), { status: 200 }));
		try {
			expect((await verifyGitHubOidc(token, repository, workflowSha)).run_id).toBe('12345');
			await expect(verifyGitHubOidc(token, repository, 'b'.repeat(40))).rejects.toThrow('claims');
		} finally { vi.unstubAllGlobals(); }
	});
});
