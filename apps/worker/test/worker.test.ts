import { env } from 'cloudflare:workers';
import {
  PROTOCOL_VERSION,
  apiErrorSchema,
  createRoomId,
  healthResponseSchema,
} from '@duplex/protocol';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';

describe('GET /health', () => {
  it('returns a typed ok response', async () => {
    const response = await app.request('/health', {}, env);
    expect(response.status).toBe(200);
    const body = healthResponseSchema.parse(await response.json());
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('/api/rooms/:roomId/*', () => {
  it('rejects room ids that are not opaque 128-bit tokens', async () => {
    const response = await app.request('/api/rooms/1/ws', {}, env);
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('invalid_room_id');
  });

  it('forwards valid room ids to the CallRoom Durable Object', async () => {
    const response = await app.request(`/api/rooms/${createRoomId()}/ws`, {}, env);
    expect(response.status).toBe(501);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('not_implemented');
  });
});

describe('unknown routes', () => {
  it('return a typed 404', async () => {
    const response = await app.request('/nope', {}, env);
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('not_found');
  });
});
