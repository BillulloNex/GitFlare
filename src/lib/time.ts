/**
 * Human-readable relative time ("just now", "1 minute ago", "3 days ago").
 * Accepts an ISO date string, a Date, or Unix epoch **seconds**. Missing or
 * unparseable input returns "recently"; future timestamps clamp to "just now".
 */
export function timeAgo(when: string | number | Date | null | undefined): string {
	if (when === null || when === undefined || when === '') return 'recently';
	const ms = typeof when === 'number' ? when * 1000 : new Date(when).getTime();
	if (!Number.isFinite(ms)) return 'recently';

	const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (seconds < 60) return 'just now';

	const units: [limit: number, size: number, name: string][] = [
		[3600, 60, 'minute'],
		[86400, 3600, 'hour'],
		[86400 * 30, 86400, 'day'],
		[86400 * 365, 86400 * 30, 'month'],
		[Infinity, 86400 * 365, 'year'],
	];
	for (const [limit, size, name] of units) {
		if (seconds < limit) {
			const n = Math.floor(seconds / size);
			return `${n} ${name}${n === 1 ? '' : 's'} ago`;
		}
	}
	return 'recently';
}
