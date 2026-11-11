/**
 * AI traces: a per-repo log of AI agent sessions. Pure validation, so it can
 * be unit tested without D1. Routes live in src/api/traces.ts.
 *
 * The transcript (`steps`) is stored as JSON in the D1 row, so it is capped
 * well under D1's 2 MB row limit; clients trim long tool output.
 */
import { parseHappenedAt } from './diary.ts';
import { parseBody, parseRefs, parseTitle, type IdeaRefs } from './ideas.ts';

export const STEP_ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export type StepRole = (typeof STEP_ROLES)[number];
export const STEPS_MAX = 500;
export const STEP_TEXT_MAX = 20_000;
export const STEPS_BYTES_MAX = 900_000;

export interface TraceStep {
	role: StepRole;
	content: string;
	/** Tool name, for role = tool. */
	name?: string;
	at?: string;
}

export interface TraceInput {
	session_id: string | null;
	agent: string;
	model: string | null;
	title: string;
	summary: string;
	started_at: string;
	ended_at: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_usd: number | null;
	refs: IdeaRefs | undefined;
	steps: TraceStep[];
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A short single-line label (agent, model, tool name). Undefined when absent, null when invalid. */
export function parseLabel(value: unknown, max = 100): string | null | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string') return null;
	const label = value.trim();
	return label && label.length <= max && !/[\x00-\x1f\x7f]/.test(label) ? label : null;
}

function parseCount(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseCost(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e6 ? value : null;
}

/** The transcript: up to STEPS_MAX steps with known roles. Null when invalid or too large. */
export function parseSteps(value: unknown): TraceStep[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > STEPS_MAX) return null;
	const steps: TraceStep[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') return null;
		const { role, content, name, at } = raw as Record<string, unknown>;
		if (!(STEP_ROLES as readonly unknown[]).includes(role)) return null;
		if (typeof content !== 'string' || content.length > STEP_TEXT_MAX) return null;
		const step: TraceStep = { role: role as StepRole, content: content.replace(/\r\n?/g, '\n') };
		const tool = parseLabel(name);
		if (tool === null) return null;
		if (tool) step.name = tool;
		if (at !== undefined && at !== null) {
			const when = parseHappenedAt(at);
			if (!when) return null;
			step.at = when;
		}
		steps.push(step);
	}
	return JSON.stringify(steps).length <= STEPS_BYTES_MAX ? steps : null;
}

/** Validate a POST body. Returns the input, or an error message for a 400. */
export function parseTraceInput(body: Record<string, unknown>, now = new Date()): TraceInput | string {
	const session = body.session_id;
	if (session !== undefined && session !== null && (typeof session !== 'string' || !SESSION_RE.test(session))) {
		return 'session_id must be 1-128 characters: letters, digits and . _ : -';
	}
	const agent = parseLabel(body.agent, 60);
	if (!agent) return 'agent is required (e.g. "claude-code", "cursor", "codex"; max 60 characters)';
	const model = parseLabel(body.model);
	if (model === null) return 'model must be a string (max 100 characters)';
	const title = parseTitle(body.title);
	if (!title) return 'title is required (max 200 characters)';
	const summary = parseBody(body.summary);
	if (summary === null) return 'summary must be a string (max 20000 characters)';
	const startedAt = parseHappenedAt(body.started_at, now);
	if (!startedAt) return 'started_at must be an ISO-8601 date-time with a time zone, not in the future';
	const endedAt = body.ended_at == null ? null : body.ended_at === '' ? '' : parseHappenedAt(body.ended_at, now);
	if (endedAt === '' || (body.ended_at != null && !endedAt)) return 'ended_at must be an ISO-8601 date-time with a time zone';
	if (endedAt && endedAt < startedAt) return 'ended_at must not be before started_at';
	const inputTokens = parseCount(body.input_tokens);
	const outputTokens = parseCount(body.output_tokens);
	if (inputTokens === null || outputTokens === null) return 'input_tokens and output_tokens must be non-negative integers';
	const cost = parseCost(body.cost_usd);
	if (cost === null) return 'cost_usd must be a non-negative number';
	const refs = parseRefs(body.refs);
	if (refs === null) return 'refs must be { commits?: sha[], branch?: string, ci_run_id?: string }';
	const steps = parseSteps(body.steps);
	if (!steps) {
		return `steps must be an array of up to ${STEPS_MAX} { role: ${STEP_ROLES.join('|')}, content (max ${STEP_TEXT_MAX} chars), name?, at? }, under ${STEPS_BYTES_MAX} bytes in total`;
	}
	return {
		session_id: (session as string | undefined) ?? null,
		agent,
		model: model ?? null,
		title,
		summary,
		started_at: startedAt,
		ended_at: endedAt,
		input_tokens: inputTokens ?? null,
		output_tokens: outputTokens ?? null,
		cost_usd: cost ?? null,
		refs,
		steps,
	};
}

/** Stored JSON → steps (never throws). */
export function readSteps(stored: string | null): TraceStep[] {
	try {
		const steps = JSON.parse(stored ?? '[]');
		return Array.isArray(steps) ? steps : [];
	} catch {
		return [];
	}
}
