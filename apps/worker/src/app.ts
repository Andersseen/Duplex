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

/**
 * Room namespace. Every request is validated and forwarded to that room's Durable Object;
 * the Worker never holds room state itself. Future: GET /api/rooms/:roomId/ws (signaling).
 */
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
