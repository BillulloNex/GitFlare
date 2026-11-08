/** Node stand-ins for the Workers-only FixedLengthStream and crypto.DigestStream. */
import { createHash } from 'node:crypto';

class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(readonly expectedLength: number) {
		let seen = 0;
		super({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				controller.enqueue(chunk);
			},
			flush() {
				if (seen !== expectedLength) throw new Error(`FixedLengthStream got ${seen} of ${expectedLength} bytes`);
			},
		});
	}
}

class DigestStream extends WritableStream<Uint8Array> {
	readonly digest: Promise<ArrayBuffer>;
	constructor(_algorithm: string) {
		const hash = createHash('sha256');
		let resolve!: (b: ArrayBuffer) => void;
		const digest = new Promise<ArrayBuffer>((r) => (resolve = r));
		super({
			write: (chunk) => void hash.update(chunk),
			close: () => {
				const b = hash.digest();
				resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
			},
		});
		this.digest = digest;
	}
}

export function installWorkersStreams(): void {
	(globalThis as Record<string, unknown>).FixedLengthStream = FixedLengthStream;
	(globalThis.crypto as unknown as Record<string, unknown>).DigestStream = DigestStream;
}

/** In-memory R2 with the calls the sync and preview use. */
export function memoryR2(objects = new Map<string, Uint8Array>()) {
	const bytesOf = async (v: Uint8Array | ReadableStream | string) =>
		typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ReadableStream ? new Uint8Array(await new Response(v).arrayBuffer()) : v;
	return {
		objects,
		head: async (k: string) => (objects.has(k) ? { key: k, size: objects.get(k)!.length } : null),
		put: async (k: string, v: Uint8Array | ReadableStream | string) => void objects.set(k, await bytesOf(v)),
		get: async (k: string, opts?: { range?: { offset: number; length: number } }) => {
			const all = objects.get(k);
			if (!all) return null;
			const bytes = opts?.range ? all.subarray(opts.range.offset, opts.range.offset + opts.range.length) : all;
			return { size: all.length, body: new Response(bytes.slice()).body!, arrayBuffer: async () => bytes.slice().buffer };
		},
		list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
		delete: async (keys: string | string[]) => [keys].flat().forEach((k) => objects.delete(k)),
	};
}
