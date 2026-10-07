import { PROTOCOL_VERSION, roomIdSchema } from '@duplex/protocol';
import type { ApiError, HealthResponse } from '@duplex/protocol';
import { Hono } from 'hono';

export const app = new Hono<{ Bindings: Cloudflare.Env }>();

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
  const stub = c.env.CALL_ROOM.get(c.env.CALL_ROOM.idFromName(roomId.data));
  return stub.fetch(c.req.raw);
});

app.notFound((c) => {
  const body: ApiError = { error: 'not_found', message: 'Not found.' };
  return c.json(body, 404);
});
