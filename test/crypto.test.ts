import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashKey, legacyEncryptToken } from '../src/lib/crypto.ts';

const KEY = 'test-encryption-key-0123456789abcdef';
const OTHER_KEY = 'a-different-encryption-key';
const SESSION_SECRET = 'legacy-session-secret';

/** Flip one bit of the base64 payload after `v1:` and re-encode. */
function tamper(ciphertext: string, byteIndex: number): string {
	const raw = Uint8Array.from(atob(ciphertext.slice(3)), (c) => c.charCodeAt(0));
	raw[byteIndex] ^= 0x01;
	return 'v1:' + btoa(String.fromCharCode(...raw));
}

describe('encryptSecret / decryptSecret', () => {
	it.each([
		['ascii', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'],
		['empty string', ''],
		['unicode', 'pässwörd 🔐 秘密'],
		['long', 'x'.repeat(10_000)],
		['json', JSON.stringify({ token: 'abc', nested: { a: [1, 2, 3] } })],
	])('round-trips %s', async (_label, plaintext) => {
		const ciphertext = await encryptSecret(plaintext, KEY);
		expect(await decryptSecret(ciphertext, KEY)).toBe(plaintext);
	});

	it('produces v1:-prefixed base64 of iv(12) + ciphertext + tag(16)', async () => {
		const ciphertext = await encryptSecret('hello', KEY);
		expect(ciphertext.startsWith('v1:')).toBe(true);
		const raw = atob(ciphertext.slice(3));
		expect(raw.length).toBe(12 + 5 + 16);
	});

	it('uses a fresh IV each time', async () => {
		const a = await encryptSecret('same', KEY);
		const b = await encryptSecret('same', KEY);
		expect(a).not.toBe(b);
		expect(atob(a.slice(3)).slice(0, 12)).not.toBe(atob(b.slice(3)).slice(0, 12));
	});

	it('never contains the plaintext', async () => {
		const secret = 'PLAINTEXT-MARKER';
		const ciphertext = await encryptSecret(secret, KEY);
		expect(ciphertext).not.toContain(secret);
		expect(atob(ciphertext.slice(3))).not.toContain(secret);
	});

	it('rejects decryption with the wrong key', async () => {
		const ciphertext = await encryptSecret('secret', KEY);
		await expect(decryptSecret(ciphertext, OTHER_KEY)).rejects.toThrow();
	});

	it('rejects tampered ciphertext, IV, or tag (GCM auth)', async () => {
		const ciphertext = await encryptSecret('secret value', KEY);
		await expect(decryptSecret(tamper(ciphertext, 0), KEY)).rejects.toThrow(); // IV
		await expect(decryptSecret(tamper(ciphertext, 14), KEY)).rejects.toThrow(); // body
		const tagByte = atob(ciphertext.slice(3)).length - 1;
		await expect(decryptSecret(tamper(ciphertext, tagByte), KEY)).rejects.toThrow(); // tag
	});

	it('rejects truncated and non-base64 v1 payloads', async () => {
		await expect(decryptSecret('v1:' + btoa('short'), KEY)).rejects.toThrow(/too short/);
		await expect(decryptSecret('v1:!!!not-base64!!!', KEY)).rejects.toThrow();
	});

	it('refuses to encrypt or decrypt without a key', async () => {
		await expect(encryptSecret('x', '')).rejects.toThrow(/not configured/);
		const ciphertext = await encryptSecret('x', KEY);
		await expect(decryptSecret(ciphertext, '')).rejects.toThrow(/not configured/);
	});
});

describe('decryptSecret legacy path', () => {
	it('reads the pre-v1 format with SESSION_SECRET', async () => {
		const legacy = await legacyEncryptToken('old-github-token', SESSION_SECRET);
		expect(legacy.startsWith('v1:')).toBe(false);
		expect(await decryptSecret(legacy, KEY, SESSION_SECRET)).toBe('old-github-token');
	});

	it('throws on legacy values when SESSION_SECRET is not provided', async () => {
		const legacy = await legacyEncryptToken('old', SESSION_SECRET);
		await expect(decryptSecret(legacy, KEY)).rejects.toThrow(/SESSION_SECRET/);
	});

	it('throws on legacy values with the wrong SESSION_SECRET', async () => {
		const legacy = await legacyEncryptToken('old', SESSION_SECRET);
		await expect(decryptSecret(legacy, KEY, 'wrong-secret')).rejects.toThrow();
	});

	it('has no plaintext fallback: a raw token is rejected, not returned', async () => {
		await expect(decryptSecret('ghp_plaintexttoken', KEY, SESSION_SECRET)).rejects.toThrow();
		await expect(decryptSecret('not base64 at all!', KEY, SESSION_SECRET)).rejects.toThrow();
	});

	it('a v1 value is not readable via the legacy key and vice versa', async () => {
		const v1 = await encryptSecret('x', KEY);
		await expect(decryptSecret(v1, SESSION_SECRET, KEY)).rejects.toThrow();
	});
});

describe('hashKey', () => {
	it('is the SHA-256 hex digest', async () => {
		expect(await hashKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(await hashKey('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});
});
