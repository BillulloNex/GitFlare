import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('diary recorder segment handoff', () => {
	it('starts the next recorder before stopping the previous one', async () => {
		const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
		const start = html.indexOf('        function newRecorderSegment(r) {');
		const end = html.indexOf('        function toggleRecording() {', start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const events: string[] = [];
		let serial = 0;
		class FakeMediaRecorder {
			readonly id = ++serial;
			state = 'inactive';
			mimeType = 'video/webm';
			onstart?: () => void;
			onstop?: () => void;
			ondataavailable?: (event: { data: { size: number } }) => void;
			start() {
				this.state = 'recording';
				events.push(`start ${this.id}`);
				queueMicrotask(() => this.onstart?.());
			}
			stop() {
				this.state = 'inactive';
				events.push(`stop ${this.id}`);
				queueMicrotask(() => this.onstop?.());
			}
		}
		const row: { stream: object; active: unknown; rollover: Promise<void> | null; segmentIndex: number; el: null } = { stream: {}, active: null, rollover: null, segmentIndex: 0, el: null };
		const recorder = { baseTrayCount: 0, segmentCount: 0, tray: { items: [] }, rows: [row], generation: 1, sessionId: 'test', recording: true, discarding: false, startedAt: Date.now(), added: [] };
		const api = runInNewContext(
			`${html.slice(start, end)}\n({ newRecorderSegment, rolloverRecorderSegment })`,
			{ recorder, MediaRecorder: FakeMediaRecorder, recorderMime: () => 'video/webm', RECORDER_SEGMENT_TARGET: 1536 * 1024 * 1024, RECORDER_SEGMENT_HARD: 1900 * 1024 * 1024, setTimeout: (fn: () => void) => { fn(); }, toast: () => {}, stopRecording: () => {} },
		) as { newRecorderSegment: (row: typeof row) => { media: FakeMediaRecorder; started: Promise<void> } };
		const first = api.newRecorderSegment(row);
		row.active = first;
		await first.started;
		recorder.discarding = true; // The test only exercises the handoff, not File/upload APIs.
		first.media.ondataavailable?.({ data: { size: 1536 * 1024 * 1024 } });
		expect(row.rollover).not.toBeNull();
		await row.rollover;
		expect(events).toEqual(['start 1', 'start 2', 'stop 1']);
		expect(recorder.segmentCount).toBe(2);
	});
});
