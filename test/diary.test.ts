import { describe, expect, it } from 'vitest';
import {
	decodeCursor,
	encodeCursor,
	MEDIA_MAX_BYTES,
	mediaKey,
	mediaType,
	PART_SIZE,
	partCount,
	partLength,
	parseFilename,
	parseHappenedAt,
	parseLimit,
	parseMediaIds,
	parseParts,
	parseSize,
	parseText,
} from '../src/lib/diary.ts';

describe('mediaType', () => {
	it('maps phone formats by extension, case-insensitively', () => {
		expect(mediaType('IMG_1073.MOV')).toEqual({ type: 'video/quicktime', kind: 'video' });
		expect(mediaType('IMG_1077.heic')).toEqual({ type: 'image/heic', kind: 'image' });
		expect(mediaType('Photo on 10-5-26 at 2.50 PM.jpg')).toEqual({ type: 'image/jpeg', kind: 'image' });
		expect(mediaType('timelapse_seg010.mp4')?.kind).toBe('video');
	});

	it('refuses script-capable and unknown types', () => {
		expect(mediaType('x.svg')).toBeNull();
		expect(mediaType('x.html')).toBeNull();
		expect(mediaType('noextension')).toBeNull();
		expect(mediaType('.png')).toBeNull();
	});
});

describe('parseFilename', () => {
	it('keeps the last path segment and strips control characters', () => {
		expect(parseFilename('C:\\Users\\me\\IMG_1.jpg')).toBe('IMG_1.jpg');
		expect(parseFilename('../../etc/a.png')).toBe('a.png');
		expect(parseFilename('a\u0000b.png')).toBe('ab.png');
	});

	it('rejects empty names and keeps the extension when truncating', () => {
		expect(parseFilename('')).toBeNull();
		expect(parseFilename('..')).toBeNull();
		expect(parseFilename(42)).toBeNull();
		const long = parseFilename(`${'x'.repeat(300)}.mov`)!;
		expect(long.length).toBe(200);
		expect(long.endsWith('.mov')).toBe(true);
	});
});

describe('parseSize', () => {
	it('accepts 1 byte to the cap', () => {
		expect(parseSize(1)).toBe(1);
		expect(parseSize(MEDIA_MAX_BYTES)).toBe(MEDIA_MAX_BYTES);
		expect(parseSize(MEDIA_MAX_BYTES + 1)).toBeNull();
		expect(parseSize(0)).toBeNull();
		expect(parseSize(1.5)).toBeNull();
		expect(parseSize('10')).toBeNull();
	});
});

describe('parseText', () => {
	it('allows empty text, normalises newlines and trims', () => {
		expect(parseText(undefined)).toBe('');
		expect(parseText('  hi\r\nthere \n')).toBe('hi\nthere');
		expect(parseText(5)).toBeNull();
		expect(parseText('x'.repeat(20_001))).toBeNull();
	});
});

describe('parseHappenedAt', () => {
	const now = new Date('2026-11-07T12:00:00Z');

	it('defaults to now', () => {
		expect(parseHappenedAt(undefined, now)).toBe(now.toISOString());
		expect(parseHappenedAt('', now)).toBe(now.toISOString());
	});

	it('normalises zoned timestamps to UTC ISO', () => {
		expect(parseHappenedAt('2026-10-03T03:26:00-04:00', now)).toBe('2026-10-03T07:26:00.000Z');
		expect(parseHappenedAt('2026-10-03T07:26:00Z', now)).toBe('2026-10-03T07:26:00.000Z');
	});

	it('rejects zone-less, far-future and garbage values', () => {
		expect(parseHappenedAt('2026-10-03T03:26', now)).toBeNull();
		expect(parseHappenedAt('2026-11-09T12:00:00Z', now)).toBeNull();
		expect(parseHappenedAt('yesterday', now)).toBeNull();
		expect(parseHappenedAt(123, now)).toBeNull();
	});
});

describe('parseMediaIds', () => {
	it('dedupes and validates ids', () => {
		expect(parseMediaIds(undefined)).toBeUndefined();
		expect(parseMediaIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
		expect(parseMediaIds(['bad id'])).toBeNull();
		expect(parseMediaIds('a')).toBeNull();
		expect(parseMediaIds(Array.from({ length: 41 }, (_, i) => `m${i}`))).toBeNull();
	});
});

describe('parts', () => {
	it('splits into fixed parts with a short last part', () => {
		expect(partCount(1)).toBe(1);
		expect(partCount(PART_SIZE)).toBe(1);
		expect(partCount(PART_SIZE + 1)).toBe(2);
		expect(partLength(PART_SIZE + 1, 1)).toBe(PART_SIZE);
		expect(partLength(PART_SIZE + 1, 2)).toBe(1);
		expect(partLength(PART_SIZE + 1, 3)).toBeNull();
		expect(partLength(500, 0)).toBeNull();
	});

	it('requires every part exactly once, in any order', () => {
		const size = PART_SIZE * 2 + 5;
		expect(
			parseParts(
				[
					{ part_number: 3, etag: 'c' },
					{ part_number: 1, etag: 'a' },
					{ part_number: 2, etag: 'b' },
				],
				size
			)
		).toEqual([
			{ partNumber: 1, etag: 'a' },
			{ partNumber: 2, etag: 'b' },
			{ partNumber: 3, etag: 'c' },
		]);
		expect(parseParts([{ part_number: 1, etag: 'a' }, { part_number: 1, etag: 'a' }, { part_number: 2, etag: 'b' }], size)).toBeNull();
		expect(parseParts([{ part_number: 1, etag: 'a' }], size)).toBeNull();
		expect(parseParts([{ part_number: 1, etag: '' }], 10)).toBeNull();
	});
});

describe('mediaKey', () => {
	it('groups by repo and makes the filename key-safe', () => {
		expect(mediaKey('repo1', 'm1', 'Photo on 10-5-26 at 2.50 PM.jpg')).toBe('diary/repo1/m1/Photo_on_10-5-26_at_2.50_PM.jpg');
	});
});

describe('cursor', () => {
	it('round-trips and rejects junk', () => {
		const c = encodeCursor('2026-10-03T07:26:00.000Z', 'abc123');
		expect(decodeCursor(c)).toEqual({ happenedAt: '2026-10-03T07:26:00.000Z', id: 'abc123' });
		expect(decodeCursor('nope')).toBeNull();
		expect(decodeCursor('notadate|abc')).toBeNull();
		expect(decodeCursor('2026-10-03T07:26:00.000Z|bad id')).toBeNull();
	});
});

describe('parseLimit', () => {
	it('defaults and bounds', () => {
		expect(parseLimit(undefined)).toBe(30);
		expect(parseLimit('100')).toBe(100);
		expect(parseLimit('101')).toBeNull();
		expect(parseLimit('0')).toBeNull();
	});
});
