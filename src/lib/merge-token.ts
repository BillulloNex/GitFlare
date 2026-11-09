/** Short-lived, single-ref credential for GitHub merge jobs. It is accepted
 * only by GitFlare's receive-pack endpoint, never by Artifacts directly. */
const encoder = new TextEncoder();

export interface MergeTokenClaims { repoId: string; ticketId: string; attemptId: string; exp: number }

async function signingKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error('ENCRYPTION_KEY is not configured');
	const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('gitflare-merge-token-v1'),
		info: encoder.encode('gitflare:merge-token:v1') }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

function b64(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function mintMergeToken(secret: string, claims: Omit<MergeTokenClaims, 'exp'>, ttlSeconds = 600): Promise<string> {
	for (const value of [claims.repoId, claims.ticketId, claims.attemptId]) {
		if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid merge token identifier');
	}
	const body = `mg1.${claims.repoId}.${claims.ticketId}.${claims.attemptId}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
	const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(body));
	return `${body}.${b64(new Uint8Array(signature))}`;
}

export async function verifyMergeToken(secret: string, token: string): Promise<MergeTokenClaims | null> {
	const parts = token.split('.');
	if (parts.length !== 6 || parts[0] !== 'mg1' || !parts.slice(1, 4).every((v) => /^[0-9a-f-]{36}$/i.test(v)) || !/^\d+$/.test(parts[4])) return null;
	const exp = Number(parts[4]);
	if (exp <= Math.floor(Date.now() / 1000)) return null;
	let signature: Uint8Array;
	try { signature = Uint8Array.from(atob(parts[5].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[5].length / 4) * 4, '=')), (c) => c.charCodeAt(0)); }
	catch { return null; }
	const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signature.buffer as ArrayBuffer, encoder.encode(parts.slice(0, 5).join('.')));
	return valid ? { repoId: parts[1], ticketId: parts[2], attemptId: parts[3], exp } : null;
}
