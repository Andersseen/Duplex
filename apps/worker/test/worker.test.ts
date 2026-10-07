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

  it('requires WebSocket upgrade before forwarding a valid room id', async () => {
    const response = await app.request(`/api/rooms/${createRoomId()}/ws`, {}, env);
    expect(response.status).toBe(426);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('websocket_required');
  });
});

describe('CallRoom WebSocket signaling', () => {
  async function connect(roomId: string): Promise<WebSocket> {
    const response = await app.request(
      `/api/rooms/${roomId}/ws`,
      { headers: { Upgrade: 'websocket' } },
      env,
    );
    expect(response.status).toBe(101);
    const socket = (response as Response & { webSocket: WebSocket | null }).webSocket;
    if (!socket) throw new Error('CallRoom did not return the client WebSocket.');
    socket.accept();
    return socket;
  }

  function nextMessage(socket: WebSocket): Promise<{ type: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for room message.'));
      }, 1000);
      socket.addEventListener(
        'message',
        (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(String(event.data)) as { type: string });
        },
        { once: true },
      );
    });
  }

  function expectNoMessage(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (): void => {
        clearTimeout(timeout);
        reject(new Error('The sender received its own signaling message.'));
      };
      const timeout = setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        resolve();
      }, 30);
      socket.addEventListener('message', onMessage, { once: true });
    });
  }

  function join(socket: WebSocket, roomId: string, protocolVersion = PROTOCOL_VERSION): void {
    socket.send(JSON.stringify({ type: 'join', payload: { roomId, protocolVersion } }));
  }

  it('admits two participants, relays negotiation only to the peer, rejects a third and frees capacity', async () => {
    const roomId = createRoomId();
    const first = await connect(roomId);
    const firstJoined = nextMessage(first);
    join(first, roomId);
    expect((await firstJoined).type).toBe('joined');

    const second = await connect(roomId);
    const firstPeerJoined = nextMessage(first);
    const secondJoined = nextMessage(second);
    join(second, roomId);
    expect((await firstPeerJoined).type).toBe('peer-joined');
    expect((await secondJoined).type).toBe('joined');

    const third = await connect(roomId);
    const full = nextMessage(third);
    join(third, roomId);
    expect((await full).type).toBe('room-full');

    const relayedOffer = nextMessage(second);
    const noOfferEcho = expectNoMessage(first);
    first.send(JSON.stringify({ type: 'offer', payload: { sdp: 'v=0 offer' } }));
    expect((await relayedOffer).type).toBe('offer');
    await noOfferEcho;
    const relayedAnswer = nextMessage(first);
    second.send(JSON.stringify({ type: 'answer', payload: { sdp: 'v=0 answer' } }));
    expect((await relayedAnswer).type).toBe('answer');
    const relayedIce = nextMessage(second);
    first.send(JSON.stringify({ type: 'ice-candidate', payload: { candidate: null } }));
    expect((await relayedIce).type).toBe('ice-candidate');

    const peerLeft = nextMessage(first);
    second.close(1000, 'left');
    expect((await peerLeft).type).toBe('peer-left');
    const replacement = await connect(roomId);
    const thirdJoined = nextMessage(replacement);
    join(replacement, roomId);
    expect((await thirdJoined).type).toBe('joined');
    first.close();
    third.close();
    replacement.close();
  });

  it('returns a typed rejection for protocol mismatch and malformed input', async () => {
    const roomId = createRoomId();
    const mismatch = await connect(roomId);
    const mismatchEvent = nextMessage(mismatch);
    join(mismatch, roomId, PROTOCOL_VERSION + 1);
    expect((await mismatchEvent).type).toBe('protocol-error');
    mismatch.close();

    const malformed = await connect(createRoomId());
    const malformedEvent = nextMessage(malformed);
    malformed.send('{');
    expect((await malformedEvent).type).toBe('protocol-error');
    malformed.close();
  });
});

describe('unknown routes', () => {
  it('return a typed 404', async () => {
    const response = await app.request('/nope', {}, env);
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('not_found');
  });
});
