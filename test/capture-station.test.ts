import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('capture station segment handoff', () => {
	it('starts the next recording before stopping the old one', async () => {
		const html = readFileSync(new URL('../src/dashboard/station.html', import.meta.url), 'utf8');
		const start = html.indexOf('function beginSegment(r){');
		const end = html.indexOf('async function startRecording(){', start);
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
			start() { this.state = 'recording'; events.push(`start ${this.id}`); queueMicrotask(() => this.onstart?.()); }
			stop() { this.state = 'inactive'; events.push(`stop ${this.id}`); queueMicrotask(() => this.onstop?.()); }
		}
		const row = { stream: {}, active: null as unknown, part: 0, rollover: null as unknown };
		const state = { rows: [row], recording: true, session: { id: 'session', startedAt: Date.now() } };
		const api = runInNewContext(
			`${html.slice(start, end)}\n({ beginSegment, rollover })`,
			{ MediaRecorder: FakeMediaRecorder, state, stationMime: () => 'video/webm', setTimeout: (fn: () => void) => { fn(); }, setError: () => {}, drainQueue: () => {} },
		) as { beginSegment: (r: typeof row) => { started: Promise<void> }; rollover: (r: typeof row, old: unknown) => Promise<void> };
		const first = api.beginSegment(row);
		row.active = first;
		await first.started;
		await api.rollover(row, first);
		expect(events).toEqual(['start 1', 'start 2', 'stop 1']);
		expect(row.part).toBe(2);
	});
});
