import { describe, expect, it } from 'vitest';
import {
	decryptOnshapeSecret,
	encryptOnshapeSecret,
	onshapeHint,
	parseOnshapeKeys,
	parseSecretName,
	publicSecret,
} from '../src/lib/saved-secrets.ts';

const KEY = 'test-encryption-key-0123456789abcdef';

describe('saved secrets', () => {
	it('accepts a short display name and rejects an empty or huge one', () => {
		expect(parseSecretName('  Onshape  ')).toBe('Onshape');
		expect(parseSecretName('')).toBeNull();
		expect(parseSecretName('   ')).toBeNull();
		expect(parseSecretName('x'.repeat(81))).toBeNull();
		expect(parseSecretName(12)).toBeNull();
	});

	it('accepts a key pair and rejects blanks, newlines and over-long keys', () => {
		expect(parseOnshapeKeys(' access ', ' secret ')).toEqual({ access_key: 'access', secret_key: 'secret' });
		expect(parseOnshapeKeys('', 'secret')).toBeNull();
		expect(parseOnshapeKeys('access\n', 'secret')).toBeNull();
		expect(parseOnshapeKeys('a'.repeat(201), 'secret')).toBeNull();
	});

	it('hints with the last four characters of the access key', () => {
		expect(onshapeHint('abcd1234')).toBe('1234');
		expect(onshapeHint('ab')).toBe('ab');
	});

	it('round-trips an Onshape key pair and refuses to describe the ciphertext', async () => {
		const keys = { access_key: 'access-key-value', secret_key: 'secret-key-value' };
		const stored = await encryptOnshapeSecret(keys, KEY);
		expect(stored.startsWith('v1:')).toBe(true);
		expect(stored).not.toContain('access-key-value');
		expect(await decryptOnshapeSecret(stored, KEY)).toEqual(keys);
		const row = publicSecret({
			id: 'id',
			name: 'Work',
			kind: 'onshape',
			hint: 'alue',
			created_at: 't',
			updated_at: 't',
			payload_encrypted: stored,
		} as never);
		expect(row).not.toHaveProperty('payload_encrypted');
		expect(JSON.stringify(row)).not.toContain('secret-key-value');
	});

	it('rejects a payload that is not a key pair', async () => {
		const { encryptSecret } = await import('../src/lib/crypto.ts');
		await expect(decryptOnshapeSecret(await encryptSecret('{"access_key":""}', KEY), KEY)).rejects.toThrow(/key pair/);
		await expect(decryptOnshapeSecret(await encryptSecret('not-json', KEY), KEY)).rejects.toThrow();
	});
});
