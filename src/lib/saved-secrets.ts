/**
 * Saved secrets: named credentials stored on a user and reused across repos.
 *
 * `text` is one secret value (`{ "value" }`). `onshape` is a key pair saved
 * before secrets were general (`{ "access_key", "secret_key" }`). The
 * ciphertext is `encryptSecret`. List responses use `publicSecret` and never
 * include the payload.
 */
import { decryptSecret, encryptSecret } from './crypto.ts';

export const SECRET_KINDS = ['text', 'onshape'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const MAX_SAVED_SECRETS = 50;
const NAME_MAX = 80;
const VALUE_MAX = 16_000;
const ONSHAPE_KEY_MAX = 200;

export interface OnshapeSecret {
	access_key: string;
	secret_key: string;
}

export interface SavedSecretRow {
	id: string;
	user_id: string;
	name: string;
	kind: string;
	payload_encrypted: string;
	hint: string;
	created_at: string;
	updated_at: string;
}

/** Trimmed display name, or null when it is empty or longer than 80 characters. */
export function parseSecretName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.trim();
	if (!name || name.length > NAME_MAX) return null;
	return name;
}

/** A non-empty secret, trimmed, within the size cap. Newlines are allowed. */
export function parseSecretValue(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const secret = value.trim();
	if (!secret || secret.length > VALUE_MAX) return null;
	return secret;
}

/** A non-empty Onshape key pair within the length cap, or null. */
export function parseOnshapeKeys(access: unknown, secret: unknown): OnshapeSecret | null {
	if (typeof access !== 'string' || typeof secret !== 'string') return null;
	if (/[\r\n]/.test(access) || /[\r\n]/.test(secret)) return null;
	const access_key = access.trim();
	const secret_key = secret.trim();
	if (!access_key || !secret_key) return null;
	if (access_key.length > ONSHAPE_KEY_MAX || secret_key.length > ONSHAPE_KEY_MAX) return null;
	return { access_key, secret_key };
}

/** Last four visible characters, for display in place of the secret. */
export function secretHint(value: string): string {
	const compact = value.replace(/\s/g, '');
	return (compact || value).slice(-4);
}

/** @deprecated use secretHint — kept for the Onshape access-key display. */
export function onshapeHint(accessKey: string): string {
	return accessKey.slice(-4);
}

export function isSecretKind(value: unknown): value is SecretKind {
	return typeof value === 'string' && (SECRET_KINDS as readonly string[]).includes(value);
}

/** Fields safe to send to the browser. */
export function publicSecret(row: Pick<SavedSecretRow, 'id' | 'name' | 'kind' | 'hint' | 'created_at' | 'updated_at'>) {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		hint: row.hint,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export function encryptTextSecret(value: string, encryptionKey: string): Promise<string> {
	return encryptSecret(JSON.stringify({ value }), encryptionKey);
}

export function encryptOnshapeSecret(keys: OnshapeSecret, encryptionKey: string): Promise<string> {
	return encryptSecret(JSON.stringify(keys), encryptionKey);
}

/** Throws when the ciphertext is not a single secret value. */
export async function decryptTextSecret(payload: string, encryptionKey: string, legacySecret?: string): Promise<string> {
	const parsed: unknown = JSON.parse(await decryptSecret(payload, encryptionKey, legacySecret));
	if (!parsed || typeof parsed !== 'object') throw new Error('Saved secret payload is not a secret value');
	const value = parseSecretValue((parsed as { value?: unknown }).value);
	if (!value) throw new Error('Saved secret payload is not a secret value');
	return value;
}

/** Throws when the ciphertext or the JSON inside it is not an Onshape key pair. */
export async function decryptOnshapeSecret(payload: string, encryptionKey: string, legacySecret?: string): Promise<OnshapeSecret> {
	const parsed: unknown = JSON.parse(await decryptSecret(payload, encryptionKey, legacySecret));
	if (!parsed || typeof parsed !== 'object') throw new Error('Saved secret payload is not an Onshape key pair');
	const record = parsed as Record<string, unknown>;
	const keys = parseOnshapeKeys(record.access_key, record.secret_key);
	if (!keys) throw new Error('Saved secret payload is not an Onshape key pair');
	return keys;
}

/**
 * The string to copy into one credential field.
 * A text secret is that string. An Onshape pair contributes its access or signing key.
 */
export async function secretField(
	row: SavedSecretRow,
	field: 'access' | 'secret',
	encryptionKey: string,
	legacySecret?: string
): Promise<string> {
	if (row.kind === 'text') return decryptTextSecret(row.payload_encrypted, encryptionKey, legacySecret);
	if (row.kind === 'onshape') {
		const keys = await decryptOnshapeSecret(row.payload_encrypted, encryptionKey, legacySecret);
		return field === 'access' ? keys.access_key : keys.secret_key;
	}
	throw new Error('Unknown saved secret');
}
