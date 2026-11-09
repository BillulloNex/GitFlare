import type { Env } from '../env.ts';

const API = 'https://api.github.com';
const encoder = new TextEncoder();

export interface GitHubInstallation {
	id: number;
	account: { login: string; type: 'Organization' | 'User' };
	repository_selection: 'all' | 'selected';
}

export function githubAppConfigured(env: Env): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
}

function base64Url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemBytes(pem: string): Uint8Array {
	const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
	const binary = atob(body);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function derLength(n: number): number[] {
	if (n < 128) return [n];
	const bytes: number[] = [];
	while (n) { bytes.unshift(n & 255); n >>>= 8; }
	return [128 | bytes.length, ...bytes];
}

function der(tag: number, value: Uint8Array): Uint8Array {
	return new Uint8Array([tag, ...derLength(value.length), ...value]);
}

/** GitHub downloads PKCS#1 RSA keys; WebCrypto imports PKCS#8. */
function pkcs8FromPkcs1(rsa: Uint8Array): Uint8Array {
	const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
	const octets = der(0x04, rsa);
	return der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...algorithm, ...octets]));
}

export async function appJwt(env: Env): Promise<string> {
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App is not configured');
	const keyBytes = pemBytes(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
	const pkcs8 = env.GITHUB_APP_PRIVATE_KEY.includes('BEGIN RSA PRIVATE KEY') ? pkcs8FromPkcs1(keyBytes) : keyBytes;
	const key = await crypto.subtle.importKey('pkcs8', pkcs8.buffer as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64Url(encoder.encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID })))}`;
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
	return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export async function githubApi(path: string, token: string, init: RequestInit = {}): Promise<Response> {
	if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path');
	return fetch(`${API}${path}`, {
		...init,
		headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'GitFlare-CI',
			Authorization: `Bearer ${token}`,
			...init.headers,
		},
	});
}

export async function installationToken(env: Env, installationId: number): Promise<string> {
	const cacheKey = `github-installation-token:${installationId}`;
	const cached = await env.CACHE.get(cacheKey);
	if (cached) return cached;
	const res = await githubApi(`/app/installations/${installationId}/access_tokens`, await appJwt(env), { method: 'POST' });
	if (!res.ok) throw new Error(`GitHub installation token request failed (${res.status})`);
	const body = await res.json<{ token: string; expires_at: string }>();
	const ttl = Math.max(1, Math.min(3300, Math.floor((Date.parse(body.expires_at) - Date.now()) / 1000) - 60));
	await env.CACHE.put(cacheKey, body.token, { expirationTtl: ttl });
	return body.token;
}

export async function exchangeUserCode(env: Env, code: string): Promise<string> {
	const res = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code }),
	});
	if (!res.ok) throw new Error(`GitHub user authorization failed (${res.status})`);
	const body = await res.json<{ access_token?: string; error?: string }>();
	if (!body.access_token) throw new Error(body.error || 'GitHub returned no user token');
	return body.access_token;
}

export async function userInstallations(userToken: string): Promise<GitHubInstallation[]> {
	const all: GitHubInstallation[] = [];
	for (let page = 1; page <= 10; page++) {
		const res = await githubApi(`/user/installations?per_page=100&page=${page}`, userToken);
		if (!res.ok) throw new Error(`Could not verify GitHub installations (${res.status})`);
		const body = await res.json<{ installations: GitHubInstallation[] }>();
		all.push(...body.installations);
		if (body.installations.length < 100) break;
	}
	return all;
}

/** GitFlare assigns the compute bill to the repository owner. A GitHub org
 * installation is eligible only when that user is an org owner. */
export async function verifyInstallationOwner(userToken: string, installation: GitHubInstallation): Promise<boolean> {
	const identity = await githubApi('/user', userToken);
	if (!identity.ok) return false;
	const user = await identity.json<{ login: string }>();
	if (installation.account.type === 'User') return installation.account.login.toLowerCase() === user.login.toLowerCase();
	const membership = await githubApi(`/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`, userToken);
	if (!membership.ok) return false;
	const body = await membership.json<{ role?: string; state?: string }>();
	return body.role === 'admin' && body.state === 'active';
}
