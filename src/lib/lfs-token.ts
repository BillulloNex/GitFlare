/**
 * Short-lived Git LFS bearer tokens.
 *
 * Why they exist: the CI runner clones straight from the Artifacts remote with
 * an Artifacts token the Worker cannot verify, and LFS batch/transfer calls
 * come back to the Worker. The Worker mints one of these alongside the
 * checkout token so the runner can `git lfs pull`. They are also what the
 * batch endpoint puts on proxy-mode transfer actions, so the git-lfs client
 * never has to re-send the API key.
 *
 * Format:  lfs1.<repoId>.<scope>.<expUnixSeconds>.<base64url(HMAC-SHA256)>
 * Key:     HKDF(ENCRYPTION_KEY, info "gitflare:lfs-token:v1")
 *
 * Scope `write` implies `read`. Tokens are bound to one repo id.
 */

const PREFIX = 'lfs1';
const HKDF_SALT = 'gitflare-lfs-token-v1';
const HKDF_INFO = 'gitflare:lfs-token:v1';
const encoder = new TextEncoder();

export type LfsScope = 'read' | 'write';

export interface LfsTokenClaims {
	repoId: string;
	scope: LfsScope;
	/** Unix seconds. */
	exp: number;
}

function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(encryptionKey: string): Promise<CryptoKey> {
	if (!encryptionKey) throw new Error('ENCRYPTION_KEY is not configured');
	const material = await crypto.subtle.importKey('raw', encoder.encode(encryptionKey), 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_INFO) },
		material,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign', 'verify']
	);
}

function payload(claims: LfsTokenClaims): string {
	return `${PREFIX}.${claims.repoId}.${claims.scope}.${claims.exp}`;
}

export async function mintLfsToken(
	encryptionKey: string,
	opts: { repoId: string; scope: LfsScope; ttlSeconds: number; now?: number }
): Promise<string> {
	if (!opts.repoId || opts.repoId.includes('.')) throw new Error('invalid repo id for LFS token');
	const exp = Math.floor((opts.now ?? Date.now()) / 1000) + Math.max(1, Math.floor(opts.ttlSeconds));
	const body = payload({ repoId: opts.repoId, scope: opts.scope, exp });
	const sig = await crypto.subtle.sign('HMAC', await hmacKey(encryptionKey), encoder.encode(body));
	return `${body}.${b64url(new Uint8Array(sig))}`;
}

export function looksLikeLfsToken(token: string): boolean {
	return token.startsWith(`${PREFIX}.`);
}

/** Returns the claims if the signature is valid and the token has not expired; otherwise null. */
export async function verifyLfsToken(encryptionKey: string, token: string, now = Date.now()): Promise<LfsTokenClaims | null> {
	const parts = token.split('.');
	if (parts.length !== 5 || parts[0] !== PREFIX) return null;
	const [, repoId, scope, expStr, sig] = parts;
	if (!repoId || (scope !== 'read' && scope !== 'write') || !/^\d{1,12}$/.test(expStr) || !sig) return null;
	const exp = Number(expStr);
	if (exp * 1000 <= now) return null;

	let sigBytes: Uint8Array;
	try {
		const b64 = sig.replace(/-/g, '+').replace(/_/g, '/');
		sigBytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
	let key: CryptoKey;
	try {
		key = await hmacKey(encryptionKey);
	} catch {
		return null;
	}
	const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload({ repoId, scope, exp })));
	return ok ? { repoId, scope, exp } : null;
}

export function scopeAllows(have: LfsScope, need: LfsScope): boolean {
	return have === 'write' || need === 'read';
}
