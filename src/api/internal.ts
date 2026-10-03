import { Hono } from 'hono';
import type { Env } from '../env.ts';

const app = new Hono<{ Bindings: Env }>();

// Runner callback - updates CI run status
app.post('/internal/ci/callback', async (c) => {
  // Verify runner secret from Authorization header
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.RUNNER_SECRET}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const body = await c.req.json<{
    runId: string;
    status: 'success' | 'failed';
    deploymentUuid?: string;
    durationMs?: number;
  }>();
  
  const ciStatus = body.status === 'success' ? 'passed' : 'failed';
  const exitCode = body.status === 'success' ? 0 : 1;
  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE ci_runs SET status = ?, finished_at = ? WHERE id = ?')
    .bind(ciStatus, now, body.runId).run();
  await c.env.DB.prepare('UPDATE ci_steps SET status = ?, finished_at = ?, exit_code = ? WHERE run_id = ?')
    .bind(ciStatus, now, exitCode, body.runId).run();
  
  return c.json({ ok: true });
});

export default app;
