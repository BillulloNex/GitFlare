import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PACK_TYPE_BLOB, scanPackForLargeBlobs } from '../src/lib/pack-scan.ts';

// ─── Pack fixture builder ───────────────────────────────────────

function objectHeader(type: number, size: number): number[] {
	const out: number[] = [];
	let byte = (type << 4) | (size & 0x0f);
	size = Math.floor(size / 16);
	while (size > 0) {
		out.push(byte | 0x80);
		byte = size & 0x7f;
		size = Math.floor(size / 128);
	}
	out.push(byte);
	return out;
}

type Entry = { type: number; data: Uint8Array; sizeOverride?: number; ofsDelta?: number; refDelta?: boolean };

function buildPack(entries: Entry[], opts: { count?: number } = {}): Uint8Array {
	const parts: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2];
	const count = opts.count ?? entries.length;
	parts.push((count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff);
	for (const e of entries) {
		parts.push(...objectHeader(e.type, e.sizeOverride ?? e.data.length));
		if (e.ofsDelta !== undefined) {
			// single-byte offset varint for small offsets
			parts.push(e.ofsDelta & 0x7f);
		}
		if (e.refDelta) parts.push(...new Array(20).fill(0xab));
		parts.push(...deflateSync(e.data));
	}
	parts.push(...new Array(20).fill(0)); // trailer checksum (not verified)
	return Uint8Array.from(parts);
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

describe('scanPackForLargeBlobs', () => {
	it('walks a pack and reports oversized blobs by header size', () => {
		const pack = buildPack([
			{ type: 1, data: bytes(50) }, // commit
			{ type: 2, data: bytes(40) }, // tree
			{ type: PACK_TYPE_BLOB, data: bytes(10) },
			{ type: PACK_TYPE_BLOB, data: bytes(300) },
			{ type: PACK_TYPE_BLOB, data: bytes(20) },
		]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 100 });
		expect(r.complete).toBe(true);
		expect(r.total).toBe(5);
		expect(r.scanned).toBe(5);
		expect(r.oversized).toEqual([{ size: 300, index: 3 }]);
	});

	it('ignores large non-blobs', () => {
		const pack = buildPack([{ type: 1, data: bytes(500) }, { type: PACK_TYPE_BLOB, data: bytes(10) }]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 100 });
		expect(r.oversized).toEqual([]);
		expect(r.complete).toBe(true);
	});

	it('skips OFS and REF deltas', () => {
		const pack = buildPack([
			{ type: PACK_TYPE_BLOB, data: bytes(30) },
			{ type: 6, data: bytes(200), ofsDelta: 5 },
			{ type: 7, data: bytes(200), refDelta: true },
			{ type: PACK_TYPE_BLOB, data: bytes(150) },
		]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 100 });
		expect(r.complete).toBe(true);
		expect(r.oversized).toEqual([{ size: 150, index: 3 }]);
	});

	it('handles multi-byte size varints', () => {
		const pack = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(70_000, 0x7a) }]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 65_536 });
		expect(r.oversized).toEqual([{ size: 70_000, index: 0 }]);
	});

	it('stops at the inflate budget without failing the push', () => {
		const pack = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(1000) }, { type: PACK_TYPE_BLOB, data: bytes(5000) }]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 10_000, inflateBudgetBytes: 2000 });
		expect(r.complete).toBe(false);
		expect(r.scanned).toBe(1);
		expect(r.reason).toMatch(/budget/);
		expect(r.oversized).toEqual([]);
	});

	it('reports an oversized blob even when it cannot afford to inflate it', () => {
		const pack = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(5000) }]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 100, inflateBudgetBytes: 10 });
		expect(r.oversized).toEqual([{ size: 5000, index: 0 }]);
		expect(r.complete).toBe(false);
	});

	it('tolerates garbage and truncation', () => {
		expect(scanPackForLargeBlobs(new Uint8Array([1, 2, 3]), { limitBytes: 1 })).toMatchObject({ complete: false, reason: 'no PACK header' });
		const pack = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(10) }], { count: 3 });
		const r = scanPackForLargeBlobs(pack, { limitBytes: 100 });
		expect(r.complete).toBe(false);
		expect(r.scanned).toBe(1);
		const cut = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(2000) }]).subarray(0, 30);
		expect(scanPackForLargeBlobs(cut, { limitBytes: 100 }).complete).toBe(false);
	});

	it('does not misreport a header-declared size that is only large when lying', () => {
		// A pack whose header claims 50 bytes but holds 10: scan reads the header size.
		const pack = buildPack([{ type: PACK_TYPE_BLOB, data: bytes(10), sizeOverride: 50 }]);
		const r = scanPackForLargeBlobs(pack, { limitBytes: 20 });
		expect(r.oversized).toEqual([{ size: 50, index: 0 }]);
	});
});
