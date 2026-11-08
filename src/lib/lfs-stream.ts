/**
 * Store a large download as a Git LFS object without holding it in memory.
 *
 * An LFS object lives at `lfs/<repo_id>/<sha256>`, but the hash is only known
 * once every byte has gone by. So the body streams into a temporary R2 key
 * while it is hashed, then is copied (R2 → R2, still streamed) to its final
 * key, and the temporary key is deleted. Memory stays at a few chunks no
 * matter the size; R2 caps one upload at ~5 GB.
 */
import { lfsObjectKey } from './lfs.ts';

const TMP_PREFIX = 'tmp/lfs-stream/';

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stream exactly `length` bytes of `body` into R2 as an LFS object of
 * `repoId`. Returns its oid and first bytes (to tell file types apart).
 * Throws if the body is shorter or longer than `length`; the temporary key is
 * removed either way.
 */
export async function streamLfsObject(
	storage: R2Bucket,
	repoId: string,
	body: ReadableStream<Uint8Array>,
	length: number
): Promise<{ oid: string; head: Uint8Array }> {
	const tmpKey = `${TMP_PREFIX}${repoId}/${crypto.randomUUID()}`;
	const digest = new crypto.DigestStream('SHA-256');
	const hashWriter = digest.getWriter();
	let seen = 0;
	const head = new Uint8Array(Math.min(16, length));
	// Awaiting the hash write per chunk keeps backpressure on the download.
	const hashing = new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen - chunk.byteLength < head.length) head.set(chunk.subarray(0, head.length - (seen - chunk.byteLength)), seen - chunk.byteLength);
			if (seen > length) throw new Error(`Download is longer than its announced ${length} bytes`);
			await hashWriter.write(chunk);
			controller.enqueue(chunk);
		},
		async flush() {
			if (seen !== length) throw new Error(`Download ended after ${seen} of ${length} bytes`);
			await hashWriter.close();
		},
	});
	// R2 needs a stream of known length.
	const sized = new FixedLengthStream(length);
	const piping = body.pipeThrough(hashing).pipeTo(sized.writable);

	try {
		await Promise.all([storage.put(tmpKey, sized.readable), piping]);
		const oid = toHex(await digest.digest);
		const key = lfsObjectKey(repoId, oid);
		if (!(await storage.head(key))) {
			const tmp = await storage.get(tmpKey);
			if (!tmp) throw new Error('The temporary upload vanished before it could be moved');
			const copy = new FixedLengthStream(tmp.size);
			await Promise.all([
				storage.put(key, copy.readable, { httpMetadata: { contentType: 'application/octet-stream' } }),
				tmp.body.pipeTo(copy.writable),
			]);
		}
		return { oid, head };
	} finally {
		await storage.delete(tmpKey).catch(() => {});
	}
}
