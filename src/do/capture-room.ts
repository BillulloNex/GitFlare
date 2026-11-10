import { DurableObject } from 'cloudflare:workers';

type Peer = { role: 'station' | 'viewer'; id: string; canControl: boolean };

/** Signaling and controls only. Camera and microphone bytes use WebRTC. */
export class CaptureRoom extends DurableObject {
	private peers(): Array<{ socket: WebSocket; peer: Peer }> {
		return this.ctx.getWebSockets().map(socket => ({ socket, peer: socket.deserializeAttachment() as Peer })).filter(x => x.peer?.id);
	}

	private send(socket: WebSocket, value: unknown): void {
		try { socket.send(JSON.stringify(value)); } catch { /* disconnected */ }
	}

	private station(): WebSocket | undefined {
		return this.peers().find(x => x.peer.role === 'station')?.socket;
	}

	private viewers(): Array<{ socket: WebSocket; peer: Peer }> {
		return this.peers().filter(x => x.peer.role === 'viewer');
	}

	private broadcast(value: unknown): void {
		for (const { socket } of this.viewers()) this.send(socket, value);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'POST' && new URL(request.url).pathname === '/revoke') {
			for (const { socket } of this.peers()) socket.close(4003, 'Station removed');
			return new Response('OK');
		}
		if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
		const role = request.headers.get('X-Capture-Role');
		if (role !== 'station' && role !== 'viewer') return new Response('Forbidden', { status: 403 });
		const id = crypto.randomUUID();
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		if (role === 'station') {
			for (const { socket, peer } of this.peers()) if (peer.role === 'station') socket.close(4001, 'Station reconnected');
		}
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ role, id, canControl: request.headers.get('X-Capture-Control') === 'yes' } satisfies Peer);
		this.send(server, { type: 'hello', id, stationOnline: Boolean(this.station()) });
		if (role === 'station') this.broadcast({ type: 'station_online' });
		return new Response(null, { status: 101, webSocket: client, headers: role === 'station' ? { 'Sec-WebSocket-Protocol': 'station' } : {} });
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string' || message.length > 262_144) { socket.close(1009, 'Message too large'); return; }
		let body: Record<string, unknown>;
		try { body = JSON.parse(message) as Record<string, unknown>; } catch { return; }
		if (!body || typeof body !== 'object' || typeof body.type !== 'string') return;
		const peer = socket.deserializeAttachment() as Peer;
		if (!peer) return;
		if (peer.role === 'viewer') {
			if (body.type === 'watch') this.send(this.station()!, { type: 'watch', viewerId: peer.id });
			else if (body.type === 'signal' && body.data && typeof body.data === 'object') this.send(this.station()!, { type: 'signal', viewerId: peer.id, data: body.data });
			else if (body.type === 'control' && peer.canControl && (body.action === 'start' || body.action === 'stop')) {
				this.send(this.station()!, { type: 'control', viewerId: peer.id, action: body.action, commandId: typeof body.commandId === 'string' ? body.commandId.slice(0, 64) : '' });
			}
			return;
		}
		if (body.type === 'status' && body.data && typeof body.data === 'object') this.broadcast({ type: 'status', data: body.data });
		else if ((body.type === 'signal' || body.type === 'ack') && typeof body.viewerId === 'string') {
			const target = this.viewers().find(x => x.peer.id === body.viewerId);
			if (target) this.send(target.socket, body.type === 'signal' ? { type: 'signal', data: body.data } : { type: 'ack', action: body.action, commandId: body.commandId, error: body.error });
		}
	}

	async webSocketClose(socket: WebSocket): Promise<void> {
		const peer = socket.deserializeAttachment() as Peer;
		if (peer?.role === 'station' && !this.peers().some(x => x.peer.role === 'station' && x.socket !== socket)) this.broadcast({ type: 'station_offline' });
		else if (peer?.role === 'viewer') this.send(this.station()!, { type: 'leave', viewerId: peer.id });
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		socket.close(1011, 'Connection error');
	}
}
