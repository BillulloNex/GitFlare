/**
 * Presigned R2 URLs (S3 API) for the LFS "presigned" transfer mode.
 *
 * Enabled when R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY are set (an R2 API
 * token with Object Read & Write on the bucket). Bytes then go straight
 * between the git-lfs client and R2; the Worker only signs URLs, so the
 * Worker request-body limit no longer caps object size.
 *
 * Upload URLs are signed with an `x-amz-checksum-sha256` header equal to the
 * LFS oid; the client must send it (the batch response tells it to), and the
 * verify step re-checks R2's recorded checksum, hashing the object when R2
 * did not record one.
 */
import { AwsClient } from 'aws4fetch';
import type { Env } from '../env.ts';

export interface PresignConfig {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export function presignConfig(env: Env): PresignConfig | null {
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CLOUDFLARE_ACCOUNT_ID) return null;
	return {
		accountId: env.CLOUDFLARE_ACCOUNT_ID,
		bucket: env.R2_BUCKET_NAME || 'gitflare-storage',
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	};
}

function client(cfg: PresignConfig): AwsClient {
	return new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' });
}

function objectUrl(cfg: PresignConfig, key: string, query?: Record<string, string>): string {
	const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
	for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
	return url.toString();
}

/** Base64 of a hex SHA-256, the encoding S3 checksum headers use. */
export function hexToBase64(hex: string): string {
	const bytes = Uint8Array.from(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export interface PresignedUpload {
	url: string;
	/** Headers the uploader MUST send (they are part of the signature). */
	headers: Record<string, string>;
}

export async function presignUpload(cfg: PresignConfig, key: string, oid: string, size: number, ttlSeconds: number): Promise<PresignedUpload> {
	// Only the checksum header is signed (and therefore required). Content-Length
	// is deliberately left unsigned: git-lfs sets it from the file, and `size`
	// is re-checked by the verify step.
	const headers: Record<string, string> = { 'x-amz-checksum-sha256': hexToBase64(oid) };
	void size;
	const url = objectUrl(cfg, key, { 'X-Amz-Expires': String(ttlSeconds) });
	const signed = await client(cfg).sign(new Request(url, { method: 'PUT', headers }), { aws: { signQuery: true } });
	return { url: signed.url, headers };
}

export async function presignDownload(cfg: PresignConfig, key: string, ttlSeconds: number, filename?: string): Promise<string> {
	const query: Record<string, string> = {};
	if (filename) {
		const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
		query['response-content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
	}
	query['X-Amz-Expires'] = String(ttlSeconds);
	const signed = await client(cfg).sign(new Request(objectUrl(cfg, key, query), { method: 'GET' }), { aws: { signQuery: true } });
	return signed.url;
}
