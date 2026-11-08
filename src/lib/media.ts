/**
 * Safe inline media for the file viewer.
 *
 * Repo bytes are attacker-controlled, so only an extension allowlist is ever
 * served as video. Sniffing stays off. HTML-like types are not in this map.
 */

export const VIDEO_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
};

export function fileExtension(path: string): string {
	const name = path.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Content type a browser can play, or null when the file should not be a <video> source. */
export function videoContentType(path: string): string | null {
	return VIDEO_TYPES[fileExtension(path)] ?? null;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: 'inline' | 'attachment', path: string): string {
	const name = path.split('/').pop() || 'file';
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parse a single `Range: bytes=` header against a known object size.
 * null = header absent. 'invalid' = present but not one satisfiable range.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | 'invalid' | null {
	if (header == null || header === '') return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || size <= 0) return 'invalid';
	const startStr = match[1] ?? '';
	const endStr = match[2] ?? '';
	if (startStr === '' && endStr === '') return 'invalid';

	if (startStr === '') {
		const suffix = Number(endStr);
		if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
		const length = Math.min(suffix, size);
		return { start: size - length, end: size - 1 };
	}

	const start = Number(startStr);
	if (!Number.isInteger(start) || start < 0 || start >= size) return 'invalid';
	const end = endStr === '' ? size - 1 : Number(endStr);
	if (!Number.isInteger(end) || end < start) return 'invalid';
	return { start, end: Math.min(end, size - 1) };
}

export function mediaHeaders(opts: {
	contentType: string;
	filename: string;
	disposition: 'inline' | 'attachment';
	cacheControl: string;
	/** Extra sandboxing for bytes served on this origin (not used for presigned redirects). */
	sandbox?: boolean;
}): Headers {
	const headers = new Headers({
		'Content-Type': opts.contentType,
		'Content-Disposition': contentDisposition(opts.disposition, opts.filename),
		'X-Content-Type-Options': 'nosniff',
		'Accept-Ranges': 'bytes',
		'Cache-Control': opts.cacheControl,
	});
	if (opts.sandbox) {
		headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
		headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	}
	return headers;
}

/** Serve an in-memory blob (git files are capped at 32 MB) with optional Range. */
export function byteRangeResponse(
	bytes: Uint8Array,
	request: Request,
	opts: {
		contentType: string;
		filename: string;
		disposition: 'inline' | 'attachment';
		cacheControl: string;
		sandbox?: boolean;
	}
): Response {
	const size = bytes.byteLength;
	const headers = mediaHeaders(opts);
	const range = parseByteRange(request.headers.get('Range'), size);
	if (range === 'invalid') {
		headers.set('Content-Range', `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}
	if (!range) {
		headers.set('Content-Length', String(size));
		return new Response(bytes, { status: 200, headers });
	}
	const slice = bytes.subarray(range.start, range.end + 1);
	headers.set('Content-Length', String(slice.byteLength));
	headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
	return new Response(slice, { status: 206, headers });
}
