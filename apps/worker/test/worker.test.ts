import { env } from 'cloudflare:workers';
import {
  PROTOCOL_VERSION,
  apiErrorSchema,
  createRoomId,
  healthResponseSchema,
} from '@duplex/protocol';
import { describe, expect, it, vi } from 'vitest';
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

  it('allows local origins in development and rejects unapproved production origins', async () => {
    const roomId = createRoomId();
    const devResponse = await app.request(
      `/api/rooms/${roomId}/ws`,
      { headers: { Upgrade: 'websocket', Origin: 'http://localhost:5173' } },
      { ...env, ENVIRONMENT: 'development' },
    );
    expect(devResponse.status).toBe(101);
    const devSocket = (devResponse as Response & { webSocket: WebSocket }).webSocket;
    devSocket.accept();
    devSocket.close();

    const denied = await app.request(
      `/api/rooms/${roomId}/ws`,
      { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } },
      { ...env, ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://call.example.com' },
    );
    expect(denied.status).toBe(403);

    const alternatePath = await app.request(
      `/api/rooms/${createRoomId()}/not-the-signaling-path`,
      { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } },
      { ...env, ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://call.example.com' },
    );
    expect(alternatePath.status).toBe(403);

    const allowed = await app.request(
      `/api/rooms/${createRoomId()}/ws`,
      { headers: { Upgrade: 'websocket', Origin: 'https://call.example.com' } },
      { ...env, ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://call.example.com' },
    );
    expect(allowed.status).toBe(101);
    const allowedSocket = (allowed as Response & { webSocket: WebSocket }).webSocket;
    allowedSocket.accept();
    allowedSocket.close();
  });
});

describe('CallRoom WebSocket signaling', () => {
  async function connect(
    roomId: string,
    environment: Cloudflare.Env = { ...env, ENVIRONMENT: 'development' },
  ): Promise<WebSocket> {
    const response = await app.request(
      `/api/rooms/${roomId}/ws`,
      { headers: { Upgrade: 'websocket' } },
      environment,
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
    expect((await nextMessage(first)).type).toBe('rtc-config');

    const second = await connect(roomId);
    const firstPeerJoined = nextMessage(first);
    const secondJoined = nextMessage(second);
    join(second, roomId);
    expect((await firstPeerJoined).type).toBe('peer-joined');
    expect((await secondJoined).type).toBe('joined');
    expect((await nextMessage(second)).type).toBe('rtc-config');

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
    expect((await nextMessage(replacement)).type).toBe('rtc-config');
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

  it('does not issue credentials before join and returns refreshed config only to a joined participant', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
              username: 'temporary-user',
              credential: 'temporary-password',
            },
          ],
        },
        { status: 201 },
      ),
    );
    const secretEnv = {
      ...env,
      ENVIRONMENT: 'development',
      TURN_KEY_ID: 'test-key',
      TURN_KEY_API_TOKEN: 'test-api-token',
    };
    try {
      const roomId = createRoomId();
      const unjoined = await connect(roomId, secretEnv);
      const unjoinedError = nextMessage(unjoined);
      unjoined.send(JSON.stringify({ type: 'refresh-rtc-config', payload: {} }));
      expect((await unjoinedError).type).toBe('protocol-error');
      expect(fetchMock).not.toHaveBeenCalled();
      unjoined.close();

      const validRoomId = createRoomId();
      const participant = await connect(validRoomId, secretEnv);
      const initialJoined = nextMessage(participant);
      participant.send(
        JSON.stringify({
          type: 'join',
          payload: { roomId: validRoomId, protocolVersion: PROTOCOL_VERSION },
        }),
      );
      expect((await initialJoined).type).toBe('joined');
      const firstConfig = (await nextMessage(participant)) as {
        type: string;
        payload: {
          relayAvailable: boolean;
          iceServers: { username?: string; credential?: string }[];
        };
      };
      expect(firstConfig.type).toBe('rtc-config');
      expect(firstConfig.payload.relayAvailable).toBe(false);
      expect(JSON.stringify(firstConfig)).not.toContain('test-api-token');

      const noRefreshDuringCooldown = expectNoMessage(participant);
      participant.send(JSON.stringify({ type: 'refresh-rtc-config', payload: {} }));
      await noRefreshDuringCooldown;
      expect(fetchMock).not.toHaveBeenCalled();

      now.mockReturnValue(start + 60_001);
      const refreshed = nextMessage(participant);
      participant.send(JSON.stringify({ type: 'refresh-rtc-config', payload: {} }));
      expect((await refreshed).type).toBe('rtc-config');
      expect(fetchMock).not.toHaveBeenCalled();
      participant.close();
    } finally {
      now.mockRestore();
      fetchMock.mockRestore();
    }
  });
});

describe('unknown routes', () => {
  it('return a typed 404', async () => {
    const response = await app.request('/nope', {}, env);
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error).toBe('not_found');
  });
});
