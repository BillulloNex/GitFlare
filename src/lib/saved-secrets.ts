/**
 * Saved secrets: credentials stored on a user, reused when connecting a repo.
 *
 * The ciphertext is `encryptSecret` of a JSON payload. Callers that list
 * secrets return `publicSecret` — never the payload.
 */
import { decryptSecret, encryptSecret } from './crypto.ts';

export const SECRET_KINDS = ['onshape'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const MAX_SAVED_SECRETS = 50;
const NAME_MAX = 80;
const KEY_MAX = 200;

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

/** A non-empty Onshape key pair within the length cap, or null. */
export function parseOnshapeKeys(access: unknown, secret: unknown): OnshapeSecret | null {
	if (typeof access !== 'string' || typeof secret !== 'string') return null;
	if (/[\r\n]/.test(access) || /[\r\n]/.test(secret)) return null;
	const access_key = access.trim();
	const secret_key = secret.trim();
	if (!access_key || !secret_key) return null;
	if (access_key.length > KEY_MAX || secret_key.length > KEY_MAX) return null;
	return { access_key, secret_key };
}

/** Last four characters of the access key, shown in place of the key itself. */
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

export function encryptOnshapeSecret(keys: OnshapeSecret, encryptionKey: string): Promise<string> {
	return encryptSecret(JSON.stringify(keys), encryptionKey);
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
