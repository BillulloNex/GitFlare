import { DurableObject } from 'cloudflare:workers';

interface Lock {
  pusher: string;
  refs: string[];
  expiresAt: number;
}

export class RepoCoordinator extends DurableObject {
  private locks: Map<string, Lock> = new Map();
  private sessions: Set<WebSocket> = new Set();
  private totalPushes: number = 0;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    // Load state from embedded SQLite
    this.ctx.blockConcurrencyWhile(async () => {
      const pushes = await this.ctx.storage.get<number>('totalPushes');
      this.totalPushes = pushes || 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/lock') {
      const body = await request.json() as { pusher: string, refs: string[] };
      
      // Cleanup expired locks
      const now = Date.now();
      for (const [id, lock] of this.locks.entries()) {
        if (lock.expiresAt < now) {
          this.locks.delete(id);
        }
      }

      // Check for conflicts
      for (const ref of body.refs) {
        for (const lock of this.locks.values()) {
          if (lock.refs.includes(ref)) {
            return new Response(JSON.stringify({ error: 'Conflict: ref is locked' }), { status: 409 });
          }
        }
      }

      const lockId = crypto.randomUUID();
      this.locks.set(lockId, {
        pusher: body.pusher,
        refs: body.refs,
        expiresAt: now + 60000 // 60 seconds
      });

      return new Response(JSON.stringify({ lock_id: lockId }), { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/unlock') {
      const body = await request.json() as { lock_id: string };
      this.locks.delete(body.lock_id);
      
      this.totalPushes++;
      await this.ctx.storage.put('totalPushes', this.totalPushes);
      
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    
    if (request.method === 'POST' && url.pathname === '/push-event') {
      const body = await request.json() as { branch: string, commit_sha: string, pusher: string };
      const msg = JSON.stringify({ type: 'push', ...body });
      for (const ws of this.sessions) {
        try {
          ws.send(msg);
        } catch (e) {
          // ignore
        }
      }
      return new Response(JSON.stringify({ success: true }));
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      return new Response(JSON.stringify({
        total_pushes: this.totalPushes,
        active_locks: this.locks.size,
        connected_clients: this.sessions.size
      }), { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/websocket') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Handle incoming WS messages if necessary
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }
}
