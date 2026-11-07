/**
 * Packfile walker for the push guard (src/api/git.ts).
 *
 * Finds blobs whose uncompressed size exceeds a limit BEFORE the pack is
 * forwarded to Artifacts, so the pusher gets an actionable "use Git LFS"
 * message instead of an opaque storage error.
 *
 * Pack format (v2/v3): "PACK" + version + count, then `count` entries, each
 * an object header (type + size varint, plus a base reference for deltas)
 * followed by a zlib stream of unknown compressed length. Skipping an entry
 * therefore requires inflating it; node:zlib's `inflateSync(..., { info })`
 * reports how many input bytes the stream consumed.
 *
 * Deltas are skipped: their header size is the delta's, not the result's, so
 * an oversized blob pushed as a delta is still caught by Artifacts (the
 * caller rewrites that error too). The walk is best effort: any parse error
 * or exhaustion of the inflate budget ends the scan and the push proceeds.
 */
import { inflateSync } from 'node:zlib';

export const PACK_TYPE_BLOB = 3;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

export interface OversizedBlob {
	/** Uncompressed size from the object header. */
	size: number;
	/** 0-based position in the pack. */
	index: number;
}

export interface PackScanResult {
	/** Blobs over the limit, in pack order. */
	oversized: OversizedBlob[];
	/** Number of entries examined. */
	scanned: number;
	/** Total entries declared by the pack header (0 if the header was unreadable). */
	total: number;
	/** True when every entry was examined. */
	complete: boolean;
	/** Why the scan stopped early, if it did. */
	reason?: string;
}

export interface PackScanOptions {
	/** Blobs strictly larger than this are reported. */
	limitBytes: number;
	/** Stop after inflating this many bytes in total (CPU/memory guard). Default 256 MiB. */
	inflateBudgetBytes?: number;
	/** Stop after this many oversized blobs. Default 5. */
	maxFindings?: number;
}

/** Read the type + size varint at `offset`. */
function readObjectHeader(pack: Uint8Array, offset: number): { type: number; size: number; next: number } | null {
	if (offset >= pack.length) return null;
	let byte = pack[offset++];
	const type = (byte >> 4) & 0x07;
	let size = byte & 0x0f;
	let shift = 4;
	while (byte & 0x80) {
		if (offset >= pack.length || shift > 60) return null;
		byte = pack[offset++];
		size += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	}
	return { type, size, next: offset };
}

/** Skip the OFS_DELTA base offset varint. */
function skipOfsDelta(pack: Uint8Array, offset: number): number | null {
	if (offset >= pack.length) return null;
	let byte = pack[offset++];
	let guard = 0;
	while (byte & 0x80) {
		if (offset >= pack.length || ++guard > 10) return null;
		byte = pack[offset++];
	}
	return offset;
}

/** Inflate the zlib stream at `offset` just to learn its compressed length. */
function skipZlib(pack: Uint8Array, offset: number, expectedSize: number): number | null {
	const { engine } = inflateSync(pack.subarray(offset), { info: true, maxOutputLength: Math.max(1, expectedSize) }) as unknown as {
		buffer: Uint8Array;
		engine: { bytesWritten: number };
	};
	const consumed = engine?.bytesWritten;
	if (!Number.isInteger(consumed) || consumed <= 0) return null;
	return offset + consumed;
}

export function scanPackForLargeBlobs(pack: Uint8Array, opts: PackScanOptions): PackScanResult {
	const budget = opts.inflateBudgetBytes ?? 256 * 1024 * 1024;
	const maxFindings = opts.maxFindings ?? 5;
	const result: PackScanResult = { oversized: [], scanned: 0, total: 0, complete: false };

	if (pack.length < 12 || pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) {
		result.reason = 'no PACK header';
		return result;
	}
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) {
		result.reason = `unsupported pack version ${version}`;
		return result;
	}
	result.total = view.getUint32(8);

	let offset = 12;
	let inflated = 0;
	for (let i = 0; i < result.total; i++) {
		const header = readObjectHeader(pack, offset);
		if (!header) {
			result.reason = `unreadable object header at entry ${i}`;
			return result;
		}
		let dataOffset = header.next;
		if (header.type === TYPE_OFS_DELTA) {
			const next = skipOfsDelta(pack, dataOffset);
			if (next === null) {
				result.reason = `unreadable delta offset at entry ${i}`;
				return result;
			}
			dataOffset = next;
		} else if (header.type === TYPE_REF_DELTA) {
			dataOffset += 20;
		}

		if (header.type === PACK_TYPE_BLOB && header.size > opts.limitBytes) {
			result.oversized.push({ size: header.size, index: i });
			result.scanned = i + 1;
			if (result.oversized.length >= maxFindings) {
				result.reason = 'finding limit reached';
				return result;
			}
		}

		// An oversized blob need not be inflated to be reported, but it must be
		// skipped to continue — that costs its full size, so stop instead.
		if (inflated + header.size > budget) {
			result.scanned = i;
			result.reason = 'inflate budget exhausted';
			return result;
		}
		let next: number | null;
		try {
			next = skipZlib(pack, dataOffset, header.size);
		} catch (err: any) {
			result.scanned = i;
			result.reason = `inflate failed at entry ${i}: ${err?.message ?? err}`;
			return result;
		}
		if (next === null || next > pack.length) {
			result.scanned = i;
			result.reason = `truncated zlib stream at entry ${i}`;
			return result;
		}
		inflated += header.size;
		offset = next;
		result.scanned = i + 1;
	}
	result.complete = true;
	return result;
}
