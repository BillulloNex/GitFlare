/**
 * Shared crypto helpers (Cloudflare Workers — WebCrypto only).
 *
 * - hashKey:          SHA-256 hex digest for API key storage/lookup
 * - safeTimingEqual:  constant-time string comparison
 * - encryptSecret:    AES-256-GCM with an HKDF-derived key, `v1:` prefixed
 * - decryptSecret:    `v1:` → HKDF path; otherwise legacy PBKDF2/AES-GCM
 *                     (the format written by the old `encryptToken`); else throw
 *
 * There is deliberately NO plaintext fallback here. Plaintext values are
 * handled only by one-off migration scripts.
 */

const AES_GCM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

const V1_PREFIX = 'v1:';
const HKDF_SALT = 'gitflare-secrets-v1';
const HKDF_INFO = 'gitflare:aes-256-gcm:v1';

const LEGACY_PBKDF2_SALT = 'gitflare-mirror-v1';
const LEGACY_PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ─── Encoding helpers ───────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	// atob throws on invalid input — callers rely on that to reject garbage.
	return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

// ─── Hashing / comparison ───────────────────────────────────────

/** SHA-256 hex digest. Used for API key storage and lookup. */
export async function hashKey(key: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
}

/**
 * Constant-time string equality. Both sides are hashed first so inputs of
 * different lengths can be compared without leaking length via timing.
 */
export async function safeTimingEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

// ─── Key derivation ─────────────────────────────────────────────

async function deriveHkdfKey(encryptionKey: string): Promise<CryptoKey> {
	if (!encryptionKey) throw new Error('Encryption key is not configured');
	const material = await crypto.subtle.importKey('raw', encoder.encode(encryptionKey), 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_INFO) },
		material,
		{ name: AES_GCM, length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/** Key derivation used by the legacy `encryptToken` format (PBKDF2, SESSION_SECRET). */
async function deriveLegacyKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: encoder.encode(LEGACY_PBKDF2_SALT), iterations: LEGACY_PBKDF2_ITERATIONS, hash: 'SHA-256' },
		material,
		{ name: AES_GCM, length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

// ─── AES-GCM primitives (payload = iv || ciphertext+tag) ────────

async function aesGcmEncrypt(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = await crypto.subtle.encrypt({ name: AES_GCM, iv, tagLength: TAG_LENGTH }, key, encoder.encode(plaintext));
	const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), IV_LENGTH);
	return combined;
}

async function aesGcmDecrypt(key: CryptoKey, combined: Uint8Array): Promise<string> {
	if (combined.length <= IV_LENGTH) throw new Error('Ciphertext too short');
	const iv = combined.slice(0, IV_LENGTH);
	const ciphertext = combined.slice(IV_LENGTH);
	const plaintext = await crypto.subtle.decrypt({ name: AES_GCM, iv, tagLength: TAG_LENGTH }, key, ciphertext);
	return decoder.decode(plaintext);
}

// ─── Public API ─────────────────────────────────────────────────

/** Encrypt a secret for storage. Returns `v1:<base64(iv || ciphertext)>`. */
export async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
	const key = await deriveHkdfKey(encryptionKey);
	return V1_PREFIX + toBase64(await aesGcmEncrypt(key, plaintext));
}

/**
 * Decrypt a stored secret.
 *
 * 1. `v1:` prefix → AES-256-GCM with HKDF(encryptionKey).
 * 2. Otherwise → legacy AES-GCM with PBKDF2(legacySecret) — the format the old
 *    `encryptToken(…, SESSION_SECRET)` wrote (plain base64 of iv+ciphertext).
 * 3. If decoding or the GCM auth check fails → throws. No plaintext fallback.
 *
 * @param legacySecret SESSION_SECRET; required to read pre-v1 values.
 */
export async function decryptSecret(ciphertext: string, encryptionKey: string, legacySecret?: string): Promise<string> {
	if (ciphertext.startsWith(V1_PREFIX)) {
		const key = await deriveHkdfKey(encryptionKey);
		return aesGcmDecrypt(key, fromBase64(ciphertext.slice(V1_PREFIX.length)));
	}
	if (!legacySecret) {
		throw new Error('Cannot decrypt legacy secret: SESSION_SECRET is not configured');
	}
	return legacyDecryptToken(ciphertext, legacySecret);
}

/**
 * Legacy format writer (PBKDF2 + AES-GCM, no prefix). Kept only so existing
 * callers of `encryptToken` keep working until the Phase 2g switchover.
 * @deprecated use encryptSecret
 */
export async function legacyEncryptToken(token: string, secret: string): Promise<string> {
	return toBase64(await aesGcmEncrypt(await deriveLegacyKey(secret), token));
}

/**
 * Legacy format reader. Throws if base64 decoding or the GCM auth check fails.
 * @deprecated use decryptSecret
 */
export async function legacyDecryptToken(encrypted: string, secret: string): Promise<string> {
	return aesGcmDecrypt(await deriveLegacyKey(secret), fromBase64(encrypted));
}
