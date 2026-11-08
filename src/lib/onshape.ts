/**
 * Minimal Onshape REST client for the repo sync (lib/onshape-sync.ts).
 *
 * Auth: API keys with HMAC request signing (`Authorization: On <access>:HmacSHA256:<sig>`),
 * per https://onshape-public.github.io/docs/auth/apikeys/. Redirects (307 on
 * downloads) are followed by hand and re-signed for the new URL, as the docs
 * require.
 *
 * Quota: Onshape counts every 2xx/3xx API-key call against an annual
 * per-user allowance (2,500 on Free/Standard), and answers 402 once it is
 * used up. Every call goes through `OnshapeClient.request`, which counts
 * them so the sync can report usage.
 */

export const ONSHAPE_API_VERSION = 'v17';
export const DEFAULT_ONSHAPE_BASE_URL = 'https://cad.onshape.com';

const encoder = new TextEncoder();

export class OnshapeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Seconds, from Retry-After on 429. */
		readonly retryAfter?: number
	) {
		super(message);
	}
	/** 402: the account's annual API allowance is used up. */
	get quotaExhausted(): boolean {
		return this.status === 402;
	}
	get rateLimited(): boolean {
		return this.status === 429;
	}
	get unauthorized(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

export interface OnshapeCredentials {
	baseUrl: string;
	accessKey: string;
	secretKey: string;
}

export interface OnshapeVersion {
	id: string;
	name: string;
	description?: string | null;
	createdAt: string;
	creator?: { id?: string; name?: string } | null;
	microversion?: string;
}

export interface OnshapeElement {
	id: string;
	name: string;
	elementType: string;
	microversionId?: string;
}

export interface OnshapeTranslation {
	id: string;
	requestState: 'ACTIVE' | 'DONE' | 'FAILED';
	resultExternalDataIds?: string[] | null;
	failureReason?: string | null;
}

// ─── URLs ───────────────────────────────────────────────────────

/**
 * Normalise an Onshape origin. Only https and *.onshape.com hosts (cad., or an
 * Enterprise `company.onshape.com`) are accepted: the stored keys are sent to
 * this host.
 */
export function normalizeBaseUrl(input: string | undefined | null): string | null {
	const raw = (input ?? '').trim() || DEFAULT_ONSHAPE_BASE_URL;
	let url: URL;
	try {
		url = new URL(raw.includes('://') ? raw : `https://${raw}`);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	if (host !== 'onshape.com' && !host.endsWith('.onshape.com')) return null;
	return `https://${host}`;
}

/**
 * Accepts a document id (24 hex) or any Onshape document URL
 * (`https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>`). Returns the
 * document id and, for URLs, the origin it came from.
 */
export function parseDocumentRef(input: string): { documentId: string; baseUrl?: string } | null {
	const value = input.trim();
	if (/^[0-9a-f]{24}$/i.test(value)) return { documentId: value.toLowerCase() };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const match = url.pathname.match(/\/documents\/([0-9a-f]{24})(?:\/|$)/i);
	if (!match) return null;
	const baseUrl = normalizeBaseUrl(url.origin);
	if (!baseUrl) return null;
	return { documentId: match[1].toLowerCase(), baseUrl };
}

export function documentUrl(baseUrl: string, documentId: string, versionId?: string): string {
	return versionId ? `${baseUrl}/documents/${documentId}/v/${versionId}` : `${baseUrl}/documents/${documentId}`;
}

// ─── Signing ────────────────────────────────────────────────────

function base64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = crypto.getRandomValues(new Uint8Array(25));
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Headers for one signed request. String to sign (lowercased):
 * method \n nonce \n date \n content-type \n path \n query \n
 */
export async function signRequest(
	creds: Pick<OnshapeCredentials, 'accessKey' | 'secretKey'>,
	method: string,
	url: URL,
	contentType: string,
	date = new Date().toUTCString(),
	onNonce = nonce()
): Promise<Record<string, string>> {
	const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
	const toSign = `${method}\n${onNonce}\n${date}\n${contentType}\n${url.pathname}\n${query}\n`.toLowerCase();
	const key = await crypto.subtle.importKey('raw', encoder.encode(creds.secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(toSign))));
	return {
		Date: date,
		'On-Nonce': onNonce,
		'Content-Type': contentType,
		Authorization: `On ${creds.accessKey}:HmacSHA256:${signature}`,
	};
}

// ─── Client ─────────────────────────────────────────────────────

const MAX_REDIRECTS = 3;

export class OnshapeClient {
	/** 2xx/3xx responses so far — what Onshape bills against the annual allowance. */
	calls = 0;

	constructor(
		private readonly creds: OnshapeCredentials,
		// Wrapped: calling the native fetch as a method of another object throws "Illegal invocation" in Workers.
		private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
	) {}

	/**
	 * Signed request with manual, re-signed redirects. Throws OnshapeError on
	 * any non-2xx final response.
	 */
	async request(method: 'GET' | 'POST', path: string, opts: { body?: unknown; accept?: string; query?: Record<string, string> } = {}): Promise<Response> {
		let url = new URL(path.startsWith('http') ? path : `${this.creds.baseUrl}/api/${ONSHAPE_API_VERSION}${path}`);
		if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
		let currentMethod = method;
		let body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

		for (let hop = 0; ; hop++) {
			const contentType = 'application/json';
			const headers: Record<string, string> = {
				...(await signRequest(this.creds, currentMethod, url, contentType)),
				Accept: opts.accept ?? 'application/json',
			};
			const res = await this.fetchImpl(url.toString(), { method: currentMethod, headers, body, redirect: 'manual' });
			if (res.status < 400) this.calls++;

			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get('Location');
				if (!location || hop >= MAX_REDIRECTS) throw new OnshapeError(`Onshape redirect without a usable Location (HTTP ${res.status})`, res.status);
				const next = new URL(location, url);
				if (next.protocol !== 'https:') throw new OnshapeError('Onshape redirected to a non-https URL', res.status);
				if (!(next.hostname === 'onshape.com' || next.hostname.endsWith('.onshape.com'))) {
					// Off-Onshape (e.g. a presigned storage URL): never send our signature there.
					const plain = await this.fetchImpl(next.toString(), { redirect: 'follow' });
					if (!plain.ok) throw new OnshapeError(`Download from ${next.hostname} failed (HTTP ${plain.status})`, plain.status);
					return plain;
				}
				url = next;
				if (res.status === 303) {
					currentMethod = 'GET';
					body = undefined;
				}
				continue;
			}
			if (!res.ok) {
				const text = (await res.text().catch(() => '')).slice(0, 300);
				const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
				throw new OnshapeError(describeError(res.status, text), res.status, retryAfter);
			}
			return res;
		}
	}

	private async json<T>(method: 'GET' | 'POST', path: string, opts?: { body?: unknown; query?: Record<string, string> }): Promise<T> {
		return (await (await this.request(method, path, opts)).json()) as T;
	}

	/** The key's owner — a cheap credential check. */
	sessionInfo(): Promise<{ id?: string; name?: string; email?: string }> {
		return this.json('GET', '/users/sessioninfo');
	}

	document(documentId: string): Promise<{ id: string; name: string; defaultWorkspace?: { id: string } }> {
		return this.json('GET', `/documents/${documentId}`);
	}

	/** One page of a document's versions (Onshape caps `limit` at 20). */
	versions(documentId: string, offset: number, limit = 20): Promise<OnshapeVersion[]> {
		return this.json('GET', `/documents/d/${documentId}/versions`, { query: { offset: String(offset), limit: String(limit) } });
	}

	elements(documentId: string, versionId: string): Promise<OnshapeElement[]> {
		return this.json('GET', `/documents/d/${documentId}/v/${versionId}/elements`);
	}

	/** Start an export of a Part Studio or Assembly at a version. */
	startExport(documentId: string, versionId: string, element: { id: string; elementType: string }, format: ExportFormat): Promise<OnshapeTranslation> {
		const kind = element.elementType === 'ASSEMBLY' ? 'assemblies' : 'partstudios';
		const base = `/${kind}/d/${documentId}/v/${versionId}/e/${element.id}`;
		switch (format) {
			case 'glb':
				return this.json('POST', `${base}/export/gltf`, { body: { storeInDocument: false } });
			case 'step':
				return this.json('POST', `${base}/export/step`, { body: { storeInDocument: false } });
			case 'stl':
				return this.json('POST', `${base}/translations`, {
					body: { formatName: 'STL', storeInDocument: false, stlMode: 'BINARY', resolution: 'medium', grouping: true },
				});
		}
	}

	translation(translationId: string): Promise<OnshapeTranslation> {
		return this.json('GET', `/translations/${translationId}`);
	}

	async download(documentId: string, externalDataId: string): Promise<Uint8Array> {
		const res = await this.request('GET', `/documents/d/${documentId}/externaldata/${externalDataId}`, { accept: 'application/octet-stream' });
		return new Uint8Array(await res.arrayBuffer());
	}
}

export type ExportFormat = 'glb' | 'step' | 'stl';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['glb', 'step', 'stl'];

function describeError(status: number, text: string): string {
	switch (status) {
		case 401:
			return 'Onshape rejected the API keys (401) — check the access and secret key';
		case 402:
			return "Onshape API quota used up (402) — the account's annual API call allowance is exhausted";
		case 403:
			return 'Onshape denied access (403) — the API key needs read access to this document';
		case 404:
			return 'Onshape document or element not found (404)';
		case 429:
			return 'Onshape rate limit hit (429)';
		default:
			return `Onshape API error ${status}${text ? `: ${text}` : ''}`;
	}
}

/**
 * Exported file → extension. glTF exports may come back as binary GLB or as
 * JSON glTF; zips appear when Onshape splits a result into several files.
 */
export function detectExtension(format: ExportFormat, bytes: Uint8Array): string {
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (magic.startsWith('PK')) return `${format}.zip`;
	if (format === 'glb') return magic === 'glTF' ? 'glb' : 'gltf';
	return format;
}
