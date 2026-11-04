import type { Context } from 'hono';

/**
 * Parse a JSON object request body. Returns null when the body is missing,
 * malformed, or not a plain object (arrays, strings and `null` are rejected),
 * so handlers can answer 400 instead of throwing. Fields are still `unknown`
 * at runtime — check each one's type before use.
 */
export async function readJsonObject<T extends object>(c: Context<any, any, any>): Promise<Partial<T> | null> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return null;
	}
	return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Partial<T>) : null;
}

export const isOptionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
export const isOptionalBoolean = (v: unknown): v is boolean | undefined => v === undefined || typeof v === 'boolean';
