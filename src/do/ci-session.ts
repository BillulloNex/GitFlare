import { DurableObject } from 'cloudflare:workers';

type LogLine = {
  step: string;
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: string;
};

type StatusUpdate = {
  status: string;
  step?: string;
};

export class CISession extends DurableObject {
  private sessions: Set<WebSocket> = new Set();
  private logs: LogLine[] = [];
  private currentStatus: string = 'pending';

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    // Load initial state if needed
    this.ctx.blockConcurrencyWhile(async () => {
      const storedLogs = await this.ctx.storage.get<LogLine[]>('logs');
      if (storedLogs) this.logs = storedLogs;
      
      const storedStatus = await this.ctx.storage.get<string>('status');
      if (storedStatus) this.currentStatus = storedStatus;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/log') {
      const body = await request.json() as LogLine;
      
      this.logs.push(body);
      if (this.logs.length > 1000) {
        this.logs.shift();
      }
      
      // Save periodically or on certain events in real implementation
      await this.ctx.storage.put('logs', this.logs);

      this.broadcast(JSON.stringify({ type: 'log', ...body }));
      
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/status') {
      const body = await request.json() as StatusUpdate;
      this.currentStatus = body.status;
      
      await this.ctx.storage.put('status', this.currentStatus);

      this.broadcast(JSON.stringify({ 
        type: 'status', 
        status: body.status, 
        step: body.step,
        timestamp: new Date().toISOString()
      }));

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    
    if (request.method === 'POST' && url.pathname === '/complete') {
        const body = await request.json() as { status: 'passed' | 'failed', duration_ms: number };
        this.currentStatus = body.status;
        await this.ctx.storage.put('status', this.currentStatus);
        
        this.broadcast(JSON.stringify({
            type: 'complete',
            status: body.status,
            duration_ms: body.duration_ms
        }));
        
        return new Response(JSON.stringify({ success: true }));
    }

    if (request.method === 'GET' && url.pathname === '/logs') {
      return new Response(JSON.stringify({ logs: this.logs }), { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/websocket') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);
      
      // Send buffered logs to new connection
      for (const log of this.logs) {
          server.send(JSON.stringify({ type: 'log', ...log }));
      }
      server.send(JSON.stringify({ type: 'status', status: this.currentStatus, timestamp: new Date().toISOString() }));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Not Found', { status: 404 });
  }
  
  private broadcast(msg: string) {
      for (const ws of this.sessions) {
          try {
              ws.send(msg);
          } catch (e) {
              // Ignore
          }
      }
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {}

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }
}
