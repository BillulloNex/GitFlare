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

// ─── Merge Queue: Perform merge for a ticket ────────────────────
// Called by the TicketQueue DO when it's a ticket's turn to merge.
// This endpoint does the actual git merge via Artifacts.
app.post('/internal/merge/execute', async (c) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.RUNNER_SECRET}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{
    ticketId: string;
    repoId: string;
    repoName: string;
    branch: string;
    baseBranch: string;
    commitSha: string;
  }>();

  const { DB, REPOS, TICKET_QUEUE } = c.env;
  const now = new Date().toISOString();

  // Update ticket status to "merging"
  await DB.prepare("UPDATE tickets SET status = 'merging', updated_at = ? WHERE id = ?")
    .bind(now, body.ticketId).run();

  // Log merge start
  await DB.prepare(
    "INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, 'merge_start', ?, ?)"
  ).bind(crypto.randomUUID(), body.repoId, body.ticketId, JSON.stringify({ branch: body.branch, baseBranch: body.baseBranch }), now).run();

  let mergeSuccess = false;
  let mergeCommitSha: string | undefined;
  let mergeError: string | undefined;

  try {
    const artifactRepo = await REPOS.get(body.repoName);
    if (!artifactRepo) {
      throw new Error(`Repository "${body.repoName}" not found in Artifacts`);
    }

    // Get a write token for the merge operation
    const tokenResult = await artifactRepo.createToken('write', 120);
    const token = typeof tokenResult === 'string' ? tokenResult : 
      (tokenResult && typeof tokenResult === 'object' && 'plaintext' in (tokenResult as any)) 
        ? (tokenResult as any).plaintext : String(tokenResult);

    const ACCOUNT_ID = 'aed09ddf6077b29514def05ed3d5e699';
    const ARTIFACTS_NAMESPACE = 'gitflare-repos';
    const remoteUrl = `https://${ACCOUNT_ID}.artifacts.cloudflare.net/git/${ARTIFACTS_NAMESPACE}/${body.repoName}.git`;

    // Use the runner to perform the rebase + merge
    // The runner has git installed and can do the actual rebase
    const mergeResponse = await fetch(`${c.env.RUNNER_URL}/webhook/merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.RUNNER_SECRET}`,
      },
      body: JSON.stringify({
        ticketId: body.ticketId,
        repoUrl: remoteUrl,
        token,
        branch: body.branch,
        baseBranch: body.baseBranch,
        callbackUrl: 'https://git.beenex.company/api/internal/merge/callback',
      }),
    });

    if (mergeResponse.status === 202) {
      // Runner accepted — it will callback when done
      return c.json({ status: 'accepted', message: 'Merge in progress, will callback' });
    }

    // If runner is unavailable, try a direct fast-forward approach
    // (This works only when the agent's branch is already rebased)
    const result = await mergeResponse.json() as any;
    if (result.success) {
      mergeSuccess = true;
      mergeCommitSha = result.mergeCommitSha;
    } else {
      mergeError = result.error || 'Merge failed';
    }
  } catch (err: any) {
    console.error('Merge execution error:', err);
    mergeError = err.message;
  }

  // Update ticket + DO with result
  const mergeResult = {
    ticketId: body.ticketId,
    success: mergeSuccess,
    mergeCommitSha,
    error: mergeError,
  };

  if (mergeSuccess) {
    await DB.prepare(
      "UPDATE tickets SET status = 'merged', merge_commit_sha = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).bind(mergeCommitSha, now, now, body.ticketId).run();

    await DB.prepare(
      "INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, 'merge_success', ?, ?)"
    ).bind(crypto.randomUUID(), body.repoId, body.ticketId, JSON.stringify({ mergeCommitSha }), now).run();
  } else {
    await DB.prepare(
      "UPDATE tickets SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(mergeError, now, body.ticketId).run();

    await DB.prepare(
      "INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, 'merge_fail', ?, ?)"
    ).bind(crypto.randomUUID(), body.repoId, body.ticketId, JSON.stringify({ error: mergeError }), now).run();
  }

  // Notify the DO
  const doId = TICKET_QUEUE.idFromName(body.repoId);
  const doStub = TICKET_QUEUE.get(doId);
  await doStub.fetch(new Request('https://do/merge-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mergeResult),
  }));

  return c.json(mergeResult);
});

// ─── Merge callback from Runner ─────────────────────────────────
// Called by the runner after completing a rebase+merge operation
app.post('/internal/merge/callback', async (c) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.RUNNER_SECRET}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{
    ticketId: string;
    success: boolean;
    mergeCommitSha?: string;
    error?: string;
  }>();

  const { DB, TICKET_QUEUE } = c.env;
  const now = new Date().toISOString();

  const ticket = await DB.prepare('SELECT * FROM tickets WHERE id = ?')
    .bind(body.ticketId).first<any>();
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  if (body.success) {
    await DB.prepare(
      "UPDATE tickets SET status = 'merged', merge_commit_sha = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).bind(body.mergeCommitSha, now, now, body.ticketId).run();

    await DB.prepare(
      "INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, 'merge_success', ?, ?)"
    ).bind(crypto.randomUUID(), ticket.repo_id, body.ticketId, JSON.stringify({ mergeCommitSha: body.mergeCommitSha }), now).run();
  } else {
    await DB.prepare(
      "UPDATE tickets SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(body.error, now, body.ticketId).run();

    await DB.prepare(
      "INSERT INTO merge_queue_log (id, repo_id, ticket_id, action, details, created_at) VALUES (?, ?, ?, 'merge_fail', ?, ?)"
    ).bind(crypto.randomUUID(), ticket.repo_id, body.ticketId, JSON.stringify({ error: body.error }), now).run();
  }

  // Notify the DO to advance the queue
  const doId = TICKET_QUEUE.idFromName(ticket.repo_id);
  const doStub = TICKET_QUEUE.get(doId);
  await doStub.fetch(new Request('https://do/merge-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ticketId: body.ticketId,
      success: body.success,
      mergeCommitSha: body.mergeCommitSha,
      error: body.error,
    }),
  }));

  return c.json({ ok: true });
});

export default app;
