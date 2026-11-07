/**
 * Minimal typing for the one node:zlib call the Worker makes (lib/pack-scan.ts).
 * Available at runtime via the `nodejs_compat` flag; @types/node is not
 * installed because it conflicts with @cloudflare/workers-types globals.
 */
declare module 'node:zlib' {
	interface InflateInfoOptions {
		info: true;
		maxOutputLength?: number;
	}
	interface InflateInfoResult {
		buffer: Uint8Array;
		/** `bytesWritten` is the number of input bytes the stream consumed. */
		engine: { bytesWritten: number };
	}
	export function inflateSync(buffer: Uint8Array, options: InflateInfoOptions): InflateInfoResult;
	export function inflateSync(buffer: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}
