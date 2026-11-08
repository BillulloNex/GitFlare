import { describe, expect, it } from 'vitest';
import { buildLfsPointer, parseLfsPointer } from '../src/lib/lfs.ts';
import { byteRangeResponse, contentDisposition, parseByteRange, videoContentType } from '../src/lib/media.ts';

const OID = 'ab'.repeat(32);

describe('videoContentType', () => {
	it('allowlists browser-playable extensions only', () => {
		expect(videoContentType('clips/demo.mp4')).toBe('video/mp4');
		expect(videoContentType('Demo.MOV')).toBe('video/quicktime');
		expect(videoContentType('a.webm')).toBe('video/webm');
		expect(videoContentType('a.m4v')).toBe('video/mp4');
		expect(videoContentType('a.ogv')).toBe('video/ogg');
		expect(videoContentType('page.html')).toBeNull();
		expect(videoContentType('clip.mkv')).toBeNull();
		expect(videoContentType('noext')).toBeNull();
	});
});

describe('parseByteRange', () => {
	it('parses open, closed, and suffix ranges', () => {
		expect(parseByteRange(null, 100)).toBeNull();
		expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
		expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
		expect(parseByteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
		expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
		expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 });
	});

	it('rejects unsatisfiable and multi ranges', () => {
		expect(parseByteRange('bytes=100-110', 100)).toBe('invalid');
		expect(parseByteRange('bytes=5-1', 100)).toBe('invalid');
		expect(parseByteRange('bytes=0-1,2-3', 100)).toBe('invalid');
		expect(parseByteRange('bytes=-0', 100)).toBe('invalid');
		expect(parseByteRange('bytes=0-1', 0)).toBe('invalid');
		expect(parseByteRange('items=0-1', 100)).toBe('invalid');
	});
});

describe('byteRangeResponse', () => {
	const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const opts = {
		contentType: 'video/mp4',
		filename: 'clips/demo.mp4',
		disposition: 'inline' as const,
		cacheControl: 'private, no-transform',
		sandbox: true,
	};

	it('returns the whole body when no Range was sent', async () => {
		const res = byteRangeResponse(bytes, new Request('https://git.example/raw'), opts);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('video/mp4');
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(res.headers.get('Content-Length')).toBe('10');
		expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
		expect(res.headers.get('Content-Disposition')).toContain('inline');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	it('returns 206 for a byte range', async () => {
		const res = byteRangeResponse(bytes, new Request('https://git.example/raw', { headers: { Range: 'bytes=2-5' } }), opts);
		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
		expect(res.headers.get('Content-Length')).toBe('4');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
	});

	it('returns 416 for a range past the end', () => {
		const res = byteRangeResponse(bytes, new Request('https://git.example/raw', { headers: { Range: 'bytes=40-' } }), opts);
		expect(res.status).toBe(416);
		expect(res.headers.get('Content-Range')).toBe('bytes */10');
	});
});

describe('contentDisposition', () => {
	it('keeps a UTF-8 filename and an ASCII fallback', () => {
		expect(contentDisposition('attachment', 'dir/café.mp4')).toBe(
			`attachment; filename="caf_.mp4"; filename*=UTF-8''caf%C3%A9.mp4`
		);
	});
});

describe('LFS pointers are not video bytes', () => {
	it('a .mp4 path can still be a pointer file', () => {
		const pointer = new TextEncoder().encode(buildLfsPointer(OID, 50_000_000));
		expect(videoContentType('clip.mp4')).toBe('video/mp4');
		expect(parseLfsPointer(pointer)).toEqual({ oid: OID, size: 50_000_000 });
	});
});
