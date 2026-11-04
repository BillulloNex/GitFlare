/**
 * CI step log storage (Phase 2e).
 *
 * - Full logs live in R2 (`STORAGE` binding) at `ci-logs/{runId}/{ordinal}.json`
 *   as a JSON array of LogLine. That R2 key is stored in `ci_steps.stdout_url`.
 *   (stdout and stderr are kept in one interleaved object, tagged by `stream`,
 *   so `stderr_url` is left NULL.)
 * - `ci_steps.logs` keeps only the last TAIL_LINES lines for quick display.
 *
 * `ordinal` is the step's `global_ordinal` (position across all jobs in the
 * run). For rows written before global_ordinal existed, `step_index` is used.
 */

export type LogLine = { timestamp: string; stream: 'stdout' | 'stderr'; line: string };

/** Number of lines kept inline in ci_steps.logs. */
export const TAIL_LINES = 50;

const LOG_PREFIX = 'ci-logs';

export function stepLogKey(runId: string, ordinal: number): string {
	return `${LOG_PREFIX}/${runId}/${ordinal}.json`;
}

/** Keys we will read back. Only ever return objects under ci-logs/. */
export function isStepLogKey(key: string): boolean {
	return key.startsWith(`${LOG_PREFIX}/`) && !key.includes('..');
}

/** Last `n` lines of a log. */
export function tailLines(lines: LogLine[], n: number = TAIL_LINES): LogLine[] {
	return lines.length > n ? lines.slice(-n) : lines;
}

/**
 * Normalise any stored/received log shape into LogLine[].
 * Accepts a JSON string or array of {timestamp, stream, line|text} objects or
 * plain strings; non-JSON text is treated as raw stdout split by newline.
 */
export function parseStepLogs(raw: unknown): LogLine[] {
	if (raw == null || raw === '') return [];
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return raw.split('\n').filter(Boolean).map((line) => ({ timestamp: '', stream: 'stdout' as const, line }));
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.map((entry: any): LogLine => {
		if (typeof entry === 'string') return { timestamp: '', stream: 'stdout', line: entry };
		return {
			timestamp: entry?.timestamp != null ? String(entry.timestamp) : '',
			stream: entry?.stream === 'stderr' ? 'stderr' : 'stdout',
			line: entry?.line != null ? String(entry.line) : entry?.text != null ? String(entry.text) : '',
		};
	});
}

/**
 * Write a step's full log to R2 and record it on the ci_steps row:
 * `stdout_url` = R2 key, `logs` = truncated tail.
 *
 * Returns the R2 key and the tail that was stored inline.
 */
export async function storeStepLogs(
	storage: R2Bucket,
	db: D1Database,
	step: { id: string; runId: string; ordinal: number },
	lines: LogLine[]
): Promise<{ key: string; tail: LogLine[] }> {
	const key = stepLogKey(step.runId, step.ordinal);
	await storage.put(key, JSON.stringify(lines), {
		httpMetadata: { contentType: 'application/json' },
		customMetadata: { runId: step.runId, stepId: step.id, lineCount: String(lines.length) },
	});
	const tail = tailLines(lines);
	await db
		.prepare('UPDATE ci_steps SET logs = ?, stdout_url = ? WHERE id = ?')
		.bind(JSON.stringify(tail), key, step.id)
		.run();
	return { key, tail };
}

/** Read a full step log from R2. Returns null if the object does not exist. */
export async function readStepLogs(storage: R2Bucket, key: string): Promise<LogLine[] | null> {
	if (!isStepLogKey(key)) return null;
	const obj = await storage.get(key);
	if (!obj) return null;
	return parseStepLogs(await obj.text());
}

