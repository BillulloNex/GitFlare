import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { streamLfsObject } from '../src/lib/lfs-stream.ts';
import { installWorkersStreams, memoryR2 } from './workers-streams.ts';

beforeAll(installWorkersStreams);

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

describe('streamLfsObject', () => {
	const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 251);
	const oid = createHash('sha256').update(bytes).digest('hex');

	it('stores the body under its sha256 and cleans up the temporary key', async () => {
		const r2 = memoryR2();
		const result = await streamLfsObject(r2 as unknown as R2Bucket, 'repo1', chunked(bytes, 4096), bytes.length);
		expect(result.oid).toBe(oid);
		expect([...result.head]).toEqual([...bytes.subarray(0, 16)]);
		expect([...r2.objects.keys()]).toEqual([`lfs/repo1/${oid}`]);
		expect(r2.objects.get(`lfs/repo1/${oid}`)).toEqual(bytes);
	});

	it('captures the head across tiny chunks', async () => {
		const r2 = memoryR2();
		const result = await streamLfsObject(r2 as unknown as R2Bucket, 'repo1', chunked(bytes, 3), bytes.length);
		expect([...result.head]).toEqual([...bytes.subarray(0, 16)]);
	});

	it('rejects a body that does not match its announced length', async () => {
		const r2 = memoryR2();
		await expect(streamLfsObject(r2 as unknown as R2Bucket, 'repo1', chunked(bytes, 4096), bytes.length + 1)).rejects.toThrow();
		await expect(streamLfsObject(r2 as unknown as R2Bucket, 'repo1', chunked(bytes, 4096), bytes.length - 1)).rejects.toThrow();
		expect(r2.objects.size).toBe(0);
	});
});
