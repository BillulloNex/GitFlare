import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.ts';
import { safeTimingEqual } from '../lib/crypto.ts';

/**
 * Authenticates runner → Worker callbacks with `Authorization: Bearer <RUNNER_SECRET>`.
 *
 * Fails closed: if RUNNER_SECRET is unset the endpoint is unavailable (503)
 * rather than accepting `Bearer undefined` / `Bearer `.
 */
export const requireRunnerSecret = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const secret = c.env.RUNNER_SECRET;
	if (!secret) {
		return c.json({ error: 'Not configured' }, 503);
	}

	const header = c.req.header('Authorization') ?? '';
	const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (!provided || !(await safeTimingEqual(provided, secret))) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	await next();
});
