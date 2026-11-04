import type { Env } from '../env.ts';

/**
 * Artifacts namespace — must match the `artifacts[].namespace` for the
 * REPOS binding in wrangler.jsonc.
 */
export const ARTIFACTS_NAMESPACE = 'gitflare-repos';

/**
 * Build the Git Smart HTTP remote URL for an Artifacts repo.
 *
 * The REPOS binding's `.get()` returns an RPC proxy that supports
 * `createToken()` but does NOT expose `.remote` at runtime (see commit
 * 626c256), so the URL is constructed from the account ID + namespace.
 */
export function getArtifactsRemoteUrl(env: Pick<Env, 'CLOUDFLARE_ACCOUNT_ID'>, repoName: string): string {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
	return `https://${accountId}.artifacts.cloudflare.net/git/${ARTIFACTS_NAMESPACE}/${encodeURIComponent(repoName)}.git`;
}
