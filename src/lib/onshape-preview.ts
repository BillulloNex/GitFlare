/**
 * Live preview of a linked Onshape document: the CAD tab renders the
 * document as it is now in its main workspace, before anyone creates a
 * Version (the sync in lib/onshape-sync.ts only commits Versions).
 *
 * One Part Studio or Assembly is exported to GLB and cached in R2 under
 * `onshape-preview/<repo_id>/<document>/<element>/<microversion>`. The
 * microversion changes on every edit in Onshape, so an unchanged tab is
 * served from the cache and costs only the two lookup calls. Previews are
 * not committed to git.
 *
 * Export is asynchronous in Onshape, so the dashboard drives it:
 *   startPreview → { state: 'exporting', translation_id } → pollPreview … → 'ready'
 */
import { detectExtension, type OnshapeClient } from './onshape.ts';
import { MAX_EXPORT_BYTES, readCapped } from './onshape-sync.ts';

export const PREVIEW_PREFIX = 'onshape-preview/';
const EXPORTABLE = new Set(['PARTSTUDIO', 'ASSEMBLY']);
const ID_RE = /^[A-Za-z0-9]{1,64}$/;

export interface PreviewElement {
	id: string;
	name: string;
	type: string;
}

export type PreviewResult =
	| { state: 'ready'; element_id: string; microversion: string; elements?: PreviewElement[] }
	| { state: 'exporting'; element_id: string; microversion: string; translation_id: string; elements?: PreviewElement[] }
	| { state: 'failed'; error: string; elements?: PreviewElement[] };

/** Onshape ids are hex; anything else never reaches an R2 key or an API path. */
export function isPreviewId(value: unknown): value is string {
	return typeof value === 'string' && ID_RE.test(value);
}

export function previewKey(repoId: string, documentId: string, elementId: string, microversion: string): string {
	return `${PREVIEW_PREFIX}${repoId}/${documentId}/${elementId}/${microversion}`;
}

/**
 * Find the tab to show (the requested one, else the first Assembly, else the
 * first Part Studio) at its current microversion. Returns it from the cache,
 * or starts a GLB export.
 */
export async function startPreview(
	storage: R2Bucket,
	client: OnshapeClient,
	repoId: string,
	documentId: string,
	elementId?: string
): Promise<PreviewResult> {
	const doc = await client.document(documentId);
	const workspaceId = doc.defaultWorkspace?.id;
	if (!workspaceId) return { state: 'failed', error: 'This Onshape document has no main workspace to preview' };

	const tabs = (await client.elements(documentId, workspaceId, 'w')).filter((e) => EXPORTABLE.has(e.elementType));
	const elements = tabs.map((e) => ({ id: e.id, name: e.name, type: e.elementType }));
	if (tabs.length === 0) return { state: 'failed', error: 'This document has no Part Studio or Assembly to render', elements };

	const pick = elementId ? tabs.find((e) => e.id === elementId) : (tabs.find((e) => e.elementType === 'ASSEMBLY') ?? tabs[0]);
	if (!pick) return { state: 'failed', error: 'That tab is no longer in the document', elements };
	const microversion = pick.microversionId;
	if (!isPreviewId(pick.id) || !isPreviewId(microversion)) return { state: 'failed', error: 'Onshape did not say which revision this tab is at', elements };

	if (await storage.head(previewKey(repoId, documentId, pick.id, microversion))) {
		return { state: 'ready', element_id: pick.id, microversion, elements };
	}
	const t = await client.startExport(documentId, workspaceId, { id: pick.id, elementType: pick.elementType }, 'glb', 'w');
	if (t.requestState === 'FAILED' || !isPreviewId(t.id)) return { state: 'failed', error: t.failureReason || 'Onshape could not export this tab', elements };
	return { state: 'exporting', element_id: pick.id, microversion, translation_id: t.id, elements };
}

/** One status check on a running export; downloads it into the cache when done. */
export async function pollPreview(
	storage: R2Bucket,
	client: OnshapeClient,
	repoId: string,
	documentId: string,
	elementId: string,
	microversion: string,
	translationId: string
): Promise<PreviewResult> {
	const key = previewKey(repoId, documentId, elementId, microversion);
	if (await storage.head(key)) return { state: 'ready', element_id: elementId, microversion };

	const t = await client.translation(translationId);
	if (t.requestState === 'ACTIVE') return { state: 'exporting', element_id: elementId, microversion, translation_id: translationId };
	if (t.requestState === 'FAILED') return { state: 'failed', error: t.failureReason || 'Onshape could not export this tab' };
	const fileId = t.resultExternalDataIds?.[0];
	if (!fileId) return { state: 'failed', error: 'The export finished without a file' };

	const bytes = await readCapped(await client.downloadResponse(documentId, fileId), MAX_EXPORT_BYTES);
	if (!bytes) return { state: 'failed', error: `The model is over the ${MAX_EXPORT_BYTES / 1024 / 1024} MB preview limit` };
	const ext = detectExtension('glb', bytes);
	if (ext.endsWith('zip')) return { state: 'failed', error: 'Onshape split this model into several files, which the preview cannot show' };
	await storage.put(key, bytes, { httpMetadata: { contentType: ext === 'glb' ? 'model/gltf-binary' : 'model/gltf+json' } });
	return { state: 'ready', element_id: elementId, microversion };
}

/** Drop every cached preview of a repo (on disconnect). Best effort. */
export async function deletePreviews(storage: R2Bucket, repoId: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await storage.list({ prefix: `${PREVIEW_PREFIX}${repoId}/`, cursor });
		if (page.objects.length) await storage.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}
