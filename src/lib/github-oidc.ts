type Claims = Record<string, unknown> & { repository: string; run_id: string };
type Jwk = JsonWebKey & { kid?: string };

function decode(part: string): Uint8Array {
	const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function verifyGitHubOidc(jwt: string, expectedRepository: string, expectedWorkflowSha: string): Promise<Claims> {
	const parts = jwt.split('.');
	if (parts.length !== 3) throw new Error('Invalid OIDC token');
	const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as { alg?: string; kid?: string };
	const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))) as Claims;
	if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported OIDC signature');
	const now = Math.floor(Date.now() / 1000);
	if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== 'gitflare' ||
		claims.repository !== expectedRepository || claims.event_name !== 'repository_dispatch' ||
		claims.workflow_ref !== `${expectedRepository}/.github/workflows/gitflare.yml@refs/heads/gitflare-control` ||
		claims.workflow_sha !== expectedWorkflowSha ||
		typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.nbf === 'number' && claims.nbf > now ||
		typeof claims.run_id !== 'string' || !/^\d+$/.test(claims.run_id)) {
		throw new Error('OIDC claims do not match the GitFlare workflow');
	}
	const res = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks');
	if (!res.ok) throw new Error('Could not fetch GitHub OIDC signing keys');
	const { keys } = await res.json<{ keys: Jwk[] }>();
	const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
	if (!jwk) throw new Error('GitHub OIDC signing key not found');
	const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
	const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]).buffer as ArrayBuffer,
		new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	if (!valid) throw new Error('Invalid GitHub OIDC signature');
	return claims;
}
