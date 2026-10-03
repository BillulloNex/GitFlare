import { DurableObject } from 'cloudflare:workers';

/**
 * TicketQueue Durable Object
 * 
 * One instance per repo. Manages the merge queue that serializes
 * parallel agent work into the target branch (usually main).
 * 
 * Flow:
 * 1. Agent creates ticket → gets assigned a working branch
 * 2. Agent pushes commits to their branch (parallel, no conflicts)
 * 3. Agent marks ticket as "review" → ticket enters merge queue
 * 4. Queue processes tickets FIFO: rebase onto latest main, fast-forward merge
 * 5. If rebase conflicts → ticket goes to "failed", agent is notified to resolve
 * 6. On success → ticket is "merged", CI fires on main
 */

interface QueueEntry {
	ticketId: string;
	agentId: string;
	branch: string;
	commitSha: string;
	priority: number;
	enqueuedAt: number;
}

interface TicketUpdate {
	ticketId: string;
	agentId: string;
	branch: string;
	commitSha: string;
	status: 'review';  // only review triggers enqueue
	priority?: number;
}

interface MergeResult {
	ticketId: string;
	success: boolean;
	mergeCommitSha?: string;
	error?: string;
}

type WSMessage = {
	type: 'queue_update';
	queue: QueueEntry[];
	processing: string | null;
} | {
	type: 'merge_result';
	result: MergeResult;
} | {
	type: 'ticket_update';
	ticketId: string;
	status: string;
	position?: number;
};

export class TicketQueue extends DurableObject {
	private queue: QueueEntry[] = [];
	private processing: string | null = null; // ticketId currently being merged
	private sessions: Set<WebSocket> = new Set();
	private initialized = false;

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);

		this.ctx.blockConcurrencyWhile(async () => {
			const storedQueue = await this.ctx.storage.get<QueueEntry[]>('queue');
			if (storedQueue) this.queue = storedQueue;

			const storedProcessing = await this.ctx.storage.get<string | null>('processing');
			if (storedProcessing) this.processing = storedProcessing;

			this.initialized = true;
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// ─── Enqueue a ticket for merge ────────────────────────────
		if (request.method === 'POST' && url.pathname === '/enqueue') {
			const body = await request.json() as TicketUpdate;

			// Don't enqueue duplicates
			if (this.queue.some(e => e.ticketId === body.ticketId)) {
				return new Response(JSON.stringify({
					position: this.queue.findIndex(e => e.ticketId === body.ticketId) + 1,
					total: this.queue.length
				}));
			}

			const entry: QueueEntry = {
				ticketId: body.ticketId,
				agentId: body.agentId,
				branch: body.branch,
				commitSha: body.commitSha,
				priority: body.priority || 0,
				enqueuedAt: Date.now(),
			};

			this.queue.push(entry);
			// Sort: higher priority first, then FIFO
			this.queue.sort((a, b) => {
				if (b.priority !== a.priority) return b.priority - a.priority;
				return a.enqueuedAt - b.enqueuedAt;
			});

			await this.ctx.storage.put('queue', this.queue);

			this.broadcastQueueUpdate();

			// If nothing is being processed, start processing
			if (!this.processing) {
				this.ctx.waitUntil(this.processNext());
			}

			const position = this.queue.findIndex(e => e.ticketId === body.ticketId) + 1;
			return new Response(JSON.stringify({
				position,
				total: this.queue.length,
				processing: this.processing
			}));
		}

		// ─── Dequeue / cancel a ticket ─────────────────────────────
		if (request.method === 'POST' && url.pathname === '/dequeue') {
			const body = await request.json() as { ticketId: string };

			// Can't dequeue if it's currently being processed
			if (this.processing === body.ticketId) {
				return new Response(JSON.stringify({
					error: 'Ticket is currently being merged, cannot dequeue'
				}), { status: 409 });
			}

			this.queue = this.queue.filter(e => e.ticketId !== body.ticketId);
			await this.ctx.storage.put('queue', this.queue);

			this.broadcastQueueUpdate();

			return new Response(JSON.stringify({ success: true }));
		}

		// ─── Get queue status ──────────────────────────────────────
		if (request.method === 'GET' && url.pathname === '/status') {
			return new Response(JSON.stringify({
				queue: this.queue.map((e, i) => ({
					position: i + 1,
					ticketId: e.ticketId,
					agentId: e.agentId,
					branch: e.branch,
					priority: e.priority,
					enqueuedAt: new Date(e.enqueuedAt).toISOString(),
				})),
				processing: this.processing,
				total: this.queue.length,
			}));
		}

		// ─── Merge callback (from the worker after performing the actual merge) ──
		if (request.method === 'POST' && url.pathname === '/merge-result') {
			const result = await request.json() as MergeResult;
			
			if (this.processing === result.ticketId) {
				this.processing = null;
				await this.ctx.storage.put('processing', null);
			}

			// Remove from queue on success
			if (result.success) {
				this.queue = this.queue.filter(e => e.ticketId !== result.ticketId);
				await this.ctx.storage.put('queue', this.queue);
			}

			this.broadcastMergeResult(result);
			this.broadcastQueueUpdate();

			// Process next item in queue
			if (!this.processing && this.queue.length > 0) {
				this.ctx.waitUntil(this.processNext());
			}

			return new Response(JSON.stringify({ success: true }));
		}

		// ─── Update commit SHA for a queued ticket ─────────────────
		if (request.method === 'POST' && url.pathname === '/update-sha') {
			const body = await request.json() as { ticketId: string; commitSha: string };
			const entry = this.queue.find(e => e.ticketId === body.ticketId);
			if (entry) {
				entry.commitSha = body.commitSha;
				await this.ctx.storage.put('queue', this.queue);
			}
			return new Response(JSON.stringify({ success: true }));
		}

		// ─── WebSocket for real-time queue updates ─────────────────
		if (request.method === 'GET' && url.pathname === '/websocket') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected Upgrade: websocket', { status: 426 });
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);
			this.sessions.add(server);

			// Send current state
			server.send(JSON.stringify({
				type: 'queue_update',
				queue: this.queue,
				processing: this.processing,
			} satisfies WSMessage));

			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response('Not Found', { status: 404 });
	}

	/**
	 * Process the next ticket in the merge queue.
	 * 
	 * This doesn't perform the actual git merge — that happens in the Worker
	 * via the Artifacts API. This DO just manages the queue and coordinates
	 * who goes next.
	 * 
	 * The Worker calls back to /merge-result when done.
	 */
	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;

		const next = this.queue[0];
		this.processing = next.ticketId;
		await this.ctx.storage.put('processing', this.processing);

		this.broadcastQueueUpdate();

		// Signal the Worker to perform the merge via an internal fetch.
		// The Worker will:
		// 1. Rebase the agent's branch onto latest main
		// 2. Fast-forward main to the rebased head
		// 3. Call back to /merge-result with the outcome
		try {
			// We use the alarm mechanism to ensure the merge doesn't hang
			await this.ctx.storage.setAlarm(Date.now() + 120_000); // 2 min timeout
		} catch {
			// Alarm already set, ignore
		}
	}

	/**
	 * Alarm handler — if merge takes too long, release the lock
	 */
	async alarm(): Promise<void> {
		if (this.processing) {
			const timedOut = this.processing;
			this.processing = null;
			await this.ctx.storage.put('processing', null);

			this.broadcastMergeResult({
				ticketId: timedOut,
				success: false,
				error: 'Merge timed out after 120 seconds',
			});

			// Try next
			if (this.queue.length > 0) {
				this.ctx.waitUntil(this.processNext());
			}
		}
	}

	private broadcast(msg: string) {
		for (const ws of this.sessions) {
			try { ws.send(msg); } catch { /* ignore dead sockets */ }
		}
	}

	private broadcastQueueUpdate() {
		this.broadcast(JSON.stringify({
			type: 'queue_update',
			queue: this.queue,
			processing: this.processing,
		} satisfies WSMessage));
	}

	private broadcastMergeResult(result: MergeResult) {
		this.broadcast(JSON.stringify({
			type: 'merge_result',
			result,
		} satisfies WSMessage));
	}

	async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
		// Agents can send pings or status requests
		try {
			const data = JSON.parse(message);
			if (data.type === 'ping') {
				ws.send(JSON.stringify({ type: 'pong' }));
			}
		} catch { /* ignore */ }
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.sessions.delete(ws);
	}
}
