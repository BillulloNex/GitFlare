import { describe, expect, it } from 'vitest';
import type { OnshapeClient } from '../src/lib/onshape.ts';
import { deletePreviews, isPreviewId, pollPreview, previewKey, startPreview } from '../src/lib/onshape-preview.ts';

const DID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const WID = 'b1b2c3d4e5f6a1b2c3d4e5f6';
const PART = 'c1b2c3d4e5f6a1b2c3d4e5f6';
const ASM = 'd1b2c3d4e5f6a1b2c3d4e5f6';
const MV = 'e1b2c3d4e5f6a1b2c3d4e5f6';
const TID = 'f1b2c3d4e5f6a1b2c3d4e5f6';

function fakeStorage() {
	const objects = new Map<string, Uint8Array>();
	const storage = {
		head: async (key: string) => (objects.has(key) ? { key } : null),
		put: async (key: string, value: Uint8Array | ReadableStream) => {
			objects.set(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value);
		},
		get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
			const bytes = objects.get(key);
			if (!bytes) return null;
			const slice = opts?.range ? bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length) : bytes;
			return { arrayBuffer: async () => slice.slice().buffer };
		},
		list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
		delete: async (keys: string | string[]) => [keys].flat().forEach((k) => objects.delete(k)),
	};
	return { objects, storage: storage as unknown as R2Bucket };
}

function fakeClient(over: Partial<Record<keyof OnshapeClient, unknown>> = {}) {
	const calls: string[] = [];
	const client = {
		document: async () => (calls.push('document'), { id: DID, name: 'Doc', defaultWorkspace: { id: WID } }),
		elements: async (_d: string, w: string, wv: string) => (
			calls.push(`elements:${wv}:${w}`),
			[
				{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Notes', elementType: 'BLOB' },
				{ id: PART, name: 'Part Studio 1', elementType: 'PARTSTUDIO', microversionId: MV },
				{ id: ASM, name: 'Assembly 1', elementType: 'ASSEMBLY', microversionId: MV },
			]
		),
		startExport: async (_d: string, w: string, el: { id: string }, format: string, wv: string, resolution?: string) => (
			calls.push(`export:${wv}:${w}:${el.id}:${format}:${resolution}`),
			{ id: TID, requestState: 'ACTIVE' }
		),
		translation: async () => (calls.push('translation'), { id: TID, requestState: 'DONE', resultExternalDataIds: ['file1'] }),
		downloadResponse: async () => (calls.push('download'), new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]))),
		...over,
	};
	return { calls, client: client as unknown as OnshapeClient };
}

describe('onshape live preview', () => {
	it('validates ids before they reach a key or path', () => {
		expect(isPreviewId(DID)).toBe(true);
		expect(isPreviewId('../etc')).toBe(false);
		expect(isPreviewId('')).toBe(false);
		expect(isPreviewId(undefined)).toBe(false);
	});

	it('exports the first assembly of the workspace, then caches it by microversion', async () => {
		const { storage, objects } = fakeStorage();
		const { client, calls } = fakeClient();
		const started = await startPreview(storage, client, 'repo1', DID);
		expect(started).toMatchObject({ state: 'exporting', element_id: ASM, microversion: MV, translation_id: TID });
		expect(started.elements?.map((e) => e.name)).toEqual(['Part Studio 1', 'Assembly 1']);
		expect(calls).toEqual(['document', `elements:w:${WID}`, `export:w:${WID}:${ASM}:glb:COARSE`]);

		const done = await pollPreview(storage, client, 'repo1', DID, ASM, MV, TID);
		expect(done).toEqual({ state: 'ready', element_id: ASM, microversion: MV });
		expect(objects.has(previewKey('repo1', DID, ASM, MV))).toBe(true);

		// Unchanged tab: served from the cache, no export.
		calls.length = 0;
		expect(await startPreview(storage, client, 'repo1', DID, ASM)).toMatchObject({ state: 'ready', element_id: ASM });
		expect(calls).toEqual(['document', `elements:w:${WID}`]);

		await deletePreviews(storage, 'repo1');
		expect(objects.size).toBe(0);
	});

	it('keeps polling while Onshape is busy and reports failures', async () => {
		const { storage } = fakeStorage();
		const busy = fakeClient({ translation: async () => ({ id: TID, requestState: 'ACTIVE' }) });
		expect(await pollPreview(storage, busy.client, 'r', DID, PART, MV, TID)).toMatchObject({ state: 'exporting', translation_id: TID });
		const failed = fakeClient({ translation: async () => ({ id: TID, requestState: 'FAILED', failureReason: 'Regen error' }) });
		expect(await pollPreview(storage, failed.client, 'r', DID, PART, MV, TID)).toEqual({ state: 'failed', error: 'Regen error' });
		const zip = fakeClient({ downloadResponse: async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4])) });
		expect((await pollPreview(storage, zip.client, 'r', DID, PART, MV, TID)).state).toBe('failed');
	});

	it('streams a download of known size into R2 and refuses one over the limit', async () => {
		const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
		const { storage, objects } = fakeStorage();
		const streamed = fakeClient({ downloadResponse: async () => new Response(glb, { headers: { 'Content-Length': String(glb.length) } }) });
		expect(await pollPreview(storage, streamed.client, 'r', DID, PART, MV, TID)).toMatchObject({ state: 'ready' });
		expect(objects.get(previewKey('r', DID, PART, MV))).toEqual(glb);

		const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4]);
		const zip = fakeClient({ downloadResponse: async () => new Response(zipBytes, { headers: { 'Content-Length': '4' } }) });
		expect((await pollPreview(storage, zip.client, 'r', DID, ASM, MV, TID)).state).toBe('failed');
		expect(objects.has(previewKey('r', DID, ASM, MV))).toBe(false);

		const huge = fakeClient({ downloadResponse: async () => new Response(glb, { headers: { 'Content-Length': String(400 * 1024 * 1024) } }) });
		const result = await pollPreview(storage, huge.client, 'r', DID, ASM, MV, TID);
		expect(result).toMatchObject({ state: 'failed' });
		expect(result.state === 'failed' && result.error).toContain('400 MB');
	});

	it('says so when a document has nothing to render', async () => {
		const { storage } = fakeStorage();
		const { client } = fakeClient({ elements: async () => [{ id: 'x', name: 'Drawing', elementType: 'DRAWING' }] });
		expect(await startPreview(storage, client, 'r', DID)).toMatchObject({ state: 'failed', error: 'This document has no Part Studio or Assembly to render' });
	});
});
