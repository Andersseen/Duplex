import { PROTOCOL_VERSION, roomIdSchema } from '@duplex/protocol';
import type { ApiError, HealthResponse } from '@duplex/protocol';
import { Hono } from 'hono';

export const app = new Hono<{ Bindings: Cloudflare.Env }>();

function isAllowedWebSocketOrigin(origin: string | undefined, env: Cloudflare.Env): boolean {
  if (!origin) return env.ENVIRONMENT !== 'production';
  const configured = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  if (env.ENVIRONMENT === 'production') return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

app.get('/health', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'duplex-worker',
    protocolVersion: PROTOCOL_VERSION,
  };
  return c.json(body);
});

/** Room WebSocket signaling endpoint; live room state remains in the Durable Object. */
app.get('/api/rooms/:roomId/ws', async (c) => {
  const roomId = roomIdSchema.safeParse(c.req.param('roomId'));
  if (!roomId.success) {
    const body: ApiError = { error: 'invalid_room_id', message: 'Invalid room id.' };
    return c.json(body, 400);
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    const body: ApiError = {
      error: 'websocket_required',
      message: 'This endpoint requires a WebSocket upgrade.',
    };
    return c.json(body, 426, { Upgrade: 'websocket' });
  }
  if (!isAllowedWebSocketOrigin(c.req.header('Origin'), c.env)) {
    const body: ApiError = { error: 'forbidden_origin', message: 'This origin is not allowed.' };
    return c.json(body, 403);
  }
  const stub = c.env.CALL_ROOM.get(c.env.CALL_ROOM.idFromName(roomId.data));
  return stub.fetch(c.req.raw);
});

/** Other room-scoped requests also resolve to that room, with no state in this Worker. */
app.all('/api/rooms/:roomId/*', async (c) => {
  const roomId = roomIdSchema.safeParse(c.req.param('roomId'));
  if (!roomId.success) {
    const body: ApiError = { error: 'invalid_room_id', message: 'Invalid room id.' };
    return c.json(body, 400);
  }
  if (
    c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
    !isAllowedWebSocketOrigin(c.req.header('Origin'), c.env)
  ) {
    const body: ApiError = { error: 'forbidden_origin', message: 'This origin is not allowed.' };
    return c.json(body, 403);
  }
  const stub = c.env.CALL_ROOM.get(c.env.CALL_ROOM.idFromName(roomId.data));
  return stub.fetch(c.req.raw);
});

app.notFound((c) => {
  const body: ApiError = { error: 'not_found', message: 'Not found.' };
  return c.json(body, 404);
});
