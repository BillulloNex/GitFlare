import { describe, expect, it } from 'vitest';
import { looksLikeLfsToken, mintLfsToken, scopeAllows, verifyLfsToken } from '../src/lib/lfs-token.ts';

const KEY = 'test-encryption-key';

describe('LFS tokens', () => {
	it('round-trips claims', async () => {
		const token = await mintLfsToken(KEY, { repoId: 'repo-1', scope: 'write', ttlSeconds: 600, now: 1_700_000_000_000 });
		expect(looksLikeLfsToken(token)).toBe(true);
		expect(token.split('.').length).toBe(5);
		const claims = await verifyLfsToken(KEY, token, 1_700_000_000_000);
		expect(claims).toEqual({ repoId: 'repo-1', scope: 'write', exp: 1_700_000_600 });
	});

	it('expires', async () => {
		const token = await mintLfsToken(KEY, { repoId: 'repo-1', scope: 'read', ttlSeconds: 60, now: 1_700_000_000_000 });
		expect(await verifyLfsToken(KEY, token, 1_700_000_000_000 + 61_000)).toBeNull();
	});

	it('rejects tampering and the wrong key', async () => {
		const token = await mintLfsToken(KEY, { repoId: 'repo-1', scope: 'read', ttlSeconds: 600 });
		const [p, repo, scope, exp, sig] = token.split('.');
		expect(await verifyLfsToken(KEY, [p, repo, 'write', exp, sig].join('.'))).toBeNull();
		expect(await verifyLfsToken(KEY, [p, 'repo-2', scope, exp, sig].join('.'))).toBeNull();
		expect(await verifyLfsToken(KEY, [p, repo, scope, String(Number(exp) + 100), sig].join('.'))).toBeNull();
		expect(await verifyLfsToken('other-key', token)).toBeNull();
		expect(await verifyLfsToken(KEY, 'lfs1.garbage')).toBeNull();
		expect(await verifyLfsToken(KEY, [p, repo, scope, exp, '!!!'].join('.'))).toBeNull();
	});

	it('refuses repo ids that would break the format', async () => {
		await expect(mintLfsToken(KEY, { repoId: 'a.b', scope: 'read', ttlSeconds: 1 })).rejects.toThrow();
		await expect(mintLfsToken('', { repoId: 'a', scope: 'read', ttlSeconds: 1 })).rejects.toThrow();
	});

	it('write implies read', () => {
		expect(scopeAllows('write', 'read')).toBe(true);
		expect(scopeAllows('write', 'write')).toBe(true);
		expect(scopeAllows('read', 'read')).toBe(true);
		expect(scopeAllows('read', 'write')).toBe(false);
	});
});
