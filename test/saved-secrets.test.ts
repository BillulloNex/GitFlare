import { describe, expect, it } from 'vitest';
import {
	decryptOnshapeSecret,
	decryptTextSecret,
	encryptOnshapeSecret,
	encryptTextSecret,
	parseOnshapeKeys,
	parseSecretName,
	parseSecretValue,
	publicSecret,
	secretField,
	secretHint,
} from '../src/lib/saved-secrets.ts';

const KEY = 'test-encryption-key-0123456789abcdef';

describe('saved secrets', () => {
	it('accepts a short display name and rejects an empty or huge one', () => {
		expect(parseSecretName('  GitHub  ')).toBe('GitHub');
		expect(parseSecretName('')).toBeNull();
		expect(parseSecretName('   ')).toBeNull();
		expect(parseSecretName('x'.repeat(81))).toBeNull();
		expect(parseSecretName(12)).toBeNull();
	});

	it('accepts a secret value, including newlines, and rejects an empty or huge one', () => {
		expect(parseSecretValue('  ghp_abc  ')).toBe('ghp_abc');
		expect(parseSecretValue('{\n  "type": "service_account"\n}')).toBe('{\n  "type": "service_account"\n}');
		expect(parseSecretValue('')).toBeNull();
		expect(parseSecretValue('   ')).toBeNull();
		expect(parseSecretValue('x'.repeat(16_001))).toBeNull();
	});

	it('accepts an Onshape key pair and rejects blanks, newlines and over-long keys', () => {
		expect(parseOnshapeKeys(' access ', ' secret ')).toEqual({ access_key: 'access', secret_key: 'secret' });
		expect(parseOnshapeKeys('', 'secret')).toBeNull();
		expect(parseOnshapeKeys('access\n', 'secret')).toBeNull();
		expect(parseOnshapeKeys('a'.repeat(201), 'secret')).toBeNull();
	});

	it('hints with the last four visible characters', () => {
		expect(secretHint('abcd1234')).toBe('1234');
		expect(secretHint('{\n}\n')).toBe('{}');
		expect(secretHint('ab')).toBe('ab');
	});

	it('round-trips a secret value and does not describe the ciphertext', async () => {
		const stored = await encryptTextSecret('ghp_secret-value', KEY);
		expect(stored.startsWith('v1:')).toBe(true);
		expect(stored).not.toContain('ghp_secret-value');
		expect(await decryptTextSecret(stored, KEY)).toBe('ghp_secret-value');
		const row = publicSecret({
			id: 'id',
			name: 'GitHub',
			kind: 'text',
			hint: 'alue',
			created_at: 't',
			updated_at: 't',
		});
		expect(row).not.toHaveProperty('payload_encrypted');
		expect(JSON.stringify(row)).not.toContain('ghp_secret-value');
	});

	it('reads one field from a text secret or an older Onshape pair', async () => {
		const text = { id: '1', user_id: 'u', name: 'Access', kind: 'text', payload_encrypted: await encryptTextSecret('access-key', KEY), hint: 'key', created_at: 't', updated_at: 't' };
		expect(await secretField(text, 'access', KEY)).toBe('access-key');
		expect(await secretField(text, 'secret', KEY)).toBe('access-key');

		const pair = { ...text, kind: 'onshape', payload_encrypted: await encryptOnshapeSecret({ access_key: 'access-key', secret_key: 'secret-key' }, KEY) };
		expect(await secretField(pair, 'access', KEY)).toBe('access-key');
		expect(await secretField(pair, 'secret', KEY)).toBe('secret-key');
		expect(await decryptOnshapeSecret(pair.payload_encrypted, KEY)).toEqual({ access_key: 'access-key', secret_key: 'secret-key' });
	});

	it('rejects a payload that is not a secret value', async () => {
		const { encryptSecret } = await import('../src/lib/crypto.ts');
		await expect(decryptTextSecret(await encryptSecret('{"value":""}', KEY), KEY)).rejects.toThrow(/secret value/);
		await expect(decryptTextSecret(await encryptSecret('not-json', KEY), KEY)).rejects.toThrow();
	});
});
