import { describe, expect, it } from 'vitest';
import {
	ARTIFACTS_MAX_BLOB_BYTES,
	buildLfsPointer,
	formatBytes,
	isValidOid,
	lfsFixRecipe,
	lfsObjectKey,
	lfsTrackedPatterns,
	looksLikeSizeLimitError,
	parseLfsPointer,
	validateBatchRequest,
} from '../src/lib/lfs.ts';

const OID = 'a'.repeat(64);

describe('parseLfsPointer', () => {
	it('parses a spec-conformant pointer', () => {
		const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`;
		expect(parseLfsPointer(text)).toEqual({ oid: OID, size: 12345 });
		expect(parseLfsPointer(new TextEncoder().encode(text))).toEqual({ oid: OID, size: 12345 });
	});

	it('round-trips buildLfsPointer', () => {
		expect(parseLfsPointer(buildLfsPointer(OID, 7))).toEqual({ oid: OID, size: 7 });
	});

	it('accepts extension keys', () => {
		const text = `version https://git-lfs.github.com/spec/v1\nname something\noid sha256:${OID}\nsize 1\n`;
		expect(parseLfsPointer(text)).toEqual({ oid: OID, size: 1 });
	});

	it('rejects non-pointers', () => {
		expect(parseLfsPointer('hello world\n')).toBeNull();
		expect(parseLfsPointer('version https://git-lfs.github.com/spec/v1\n')).toBeNull();
		expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v2\noid sha256:${OID}\nsize 1\n`)).toBeNull();
		expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid md5:abc\nsize 1\n`)).toBeNull();
		expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize big\n`)).toBeNull();
		expect(parseLfsPointer(`oid sha256:${OID}\nversion https://git-lfs.github.com/spec/v1\nsize 1\n`)).toBeNull();
		expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1\n` + 'x'.repeat(1100))).toBeNull();
		expect(parseLfsPointer(new Uint8Array([0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x20, 0x00]))).toBeNull();
	});
});

describe('lfsTrackedPatterns', () => {
	it('reads filter=lfs lines, quoted patterns, skips comments', () => {
		const text = [
			'# large assets',
			'*.psd filter=lfs diff=lfs merge=lfs -text',
			'"with space.bin" filter=lfs diff=lfs merge=lfs -text',
			'*.md text',
			'',
			'models/** filter=lfs',
		].join('\n');
		expect(lfsTrackedPatterns(text)).toEqual(['*.psd', 'with space.bin', 'models/**']);
	});
});

describe('validateBatchRequest', () => {
	it('accepts a minimal download request', () => {
		const v = validateBatchRequest({ operation: 'download', objects: [{ oid: OID, size: 3 }] });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.request.objects).toEqual([{ oid: OID, size: 3 }]);
	});

	it('rejects unknown operations, transfers and hash algos', () => {
		expect(validateBatchRequest({ operation: 'delete', objects: [] })).toMatchObject({ ok: false, status: 400 });
		expect(validateBatchRequest({ operation: 'upload', transfers: ['multipart'], objects: [] })).toMatchObject({ ok: false, status: 422 });
		expect(validateBatchRequest({ operation: 'upload', transfers: ['multipart', 'basic'], objects: [] })).toMatchObject({ ok: true });
		expect(validateBatchRequest({ operation: 'upload', hash_algo: 'sha1', objects: [] })).toMatchObject({ ok: false, status: 422 });
		expect(validateBatchRequest({ operation: 'upload' })).toMatchObject({ ok: false, status: 400 });
		expect(validateBatchRequest('nope')).toMatchObject({ ok: false, status: 400 });
	});

	it('keeps malformed objects for per-object errors', () => {
		const v = validateBatchRequest({ operation: 'upload', objects: [{ oid: 'short', size: 'x' }] });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.request.objects).toEqual([{ oid: 'short', size: -1 }]);
	});
});

describe('misc helpers', () => {
	it('validates oids', () => {
		expect(isValidOid(OID)).toBe(true);
		expect(isValidOid(OID.toUpperCase())).toBe(false);
		expect(isValidOid('abc')).toBe(false);
	});

	it('lays out keys per repo', () => {
		expect(lfsObjectKey('repo-1', OID)).toBe(`lfs/repo-1/${OID}`);
	});

	it('formats bytes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(184 * 1024 * 1024)).toBe('184 MB');
		expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
	});

	it('writes an executable recipe', () => {
		const text = lfsFixRecipe({ docsUrl: 'https://x/docs/lfs', sizes: [40 * 1024 * 1024] });
		expect(text).toContain('40.0 MB');
		expect(text).toContain(formatBytes(ARTIFACTS_MAX_BLOB_BYTES));
		expect(text).toContain('git lfs track');
		expect(text).toContain('git lfs migrate import');
		expect(text).toContain('https://x/docs/lfs');
	});

	it('recognises size-limit wording', () => {
		expect(looksLikeSizeLimitError('object exceeds maximum blob size of 32 MiB')).toBe(true);
		expect(looksLikeSizeLimitError('blob too large')).toBe(true);
		expect(looksLikeSizeLimitError('bad object')).toBe(false);
	});
});
