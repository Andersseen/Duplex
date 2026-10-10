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

describe('/api/rooms/:roomId/helper/ws', () => {
  const productionEnv = { ...env, ENVIRONMENT: 'production' } as Cloudflare.Env;

  it('validates the room id and requires a WebSocket upgrade before reaching the room', async () => {
    const invalid = await app.request('/api/rooms/1/helper/ws', {}, productionEnv);
    expect(invalid.status).toBe(400);

    const plain = await app.request(`/api/rooms/${createRoomId()}/helper/ws`, {}, productionEnv);
    expect(plain.status).toBe(426);
    expect(apiErrorSchema.parse(await plain.json()).error).toBe('websocket_required');
  });

  it('rejects missing, malformed and unknown bearer tokens without revealing why', async () => {
    const roomId = createRoomId();
    const attempt = (headers: Record<string, string>) =>
      app.request(
        `/api/rooms/${roomId}/helper/ws`,
        { headers: { Upgrade: 'websocket', ...headers } },
        productionEnv,
      );

    expect((await attempt({})).status).toBe(401);
    expect((await attempt({ Authorization: 'Bearer short' })).status).toBe(401);
    expect((await attempt({ Authorization: `Basic ${'a'.repeat(43)}` })).status).toBe(401);
    expect((await attempt({ Authorization: `Bearer ${'a'.repeat(43)}` })).status).toBe(401);
  });

  it('does not accept a helper token minted for a different room', async () => {
    const roomA = createRoomId();
    const roomB = createRoomId();
    const response = await app.request(
      `/api/rooms/${roomA}/ws`,
      { headers: { Upgrade: 'websocket' } },
      { ...env, ENVIRONMENT: 'development' },
    );
    const owner = (response as Response & { webSocket: WebSocket }).webSocket;
    owner.accept();
    const messages: { type: string; payload?: { token?: string } }[] = [];
    owner.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as (typeof messages)[number]);
    });
    owner.send(
      JSON.stringify({
        type: 'join',
        payload: { roomId: roomA, protocolVersion: PROTOCOL_VERSION },
      }),
    );
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'joined')).toBe(true);
    });
    owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'helper-pairing-created')).toBe(true);
    });
    const token = messages.find((m) => m.type === 'helper-pairing-created')?.payload?.token;

    const crossRoom = await app.request(
      `/api/rooms/${roomB}/helper/ws`,
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${String(token)}` } },
      productionEnv,
    );
    expect(crossRoom.status).toBe(401);
    owner.close();
  });

  it('forwards non-signaling room requests that are not WebSocket upgrades', async () => {
    const response = await app.request(`/api/rooms/${createRoomId()}/anything`, {}, productionEnv);
    expect(response.status).toBe(426);
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

  function nextMessage(socket: WebSocket, label = 'room message'): Promise<{ type: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label}.`));
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

  it('assigns complementary roles from the remaining participant attachment after replacement', async () => {
    const roomId = createRoomId();
    const a = await connect(roomId);
    const aJoined = nextMessage(a);
    join(a, roomId);
    const firstRole = (await aJoined) as unknown as { type: string; payload: { polite: boolean } };
    expect(firstRole.type).toBe('joined');
    expect(firstRole.payload.polite).toBe(false);
    await nextMessage(a);
    const b = await connect(roomId);
    const aPeerJoined = nextMessage(a);
    const bJoined = nextMessage(b);
    join(b, roomId);
    await aPeerJoined;
    const secondRole = (await bJoined) as unknown as { type: string; payload: { polite: boolean } };
    expect(secondRole.type).toBe('joined');
    expect(secondRole.payload.polite).toBe(true);
    await nextMessage(b);

    const aLeaves = nextMessage(b);
    a.close(1000, 'left');
    expect((await aLeaves).type).toBe('peer-left');
    const c = await connect(roomId);
    const bPeerJoined = nextMessage(b);
    const cJoined = nextMessage(c);
    join(c, roomId);
    await bPeerJoined;
    const cMessage = (await cJoined) as unknown as { payload: { polite: boolean } };
    expect(cMessage.payload.polite).toBe(false);
    await nextMessage(c);

    const bLeaves = nextMessage(c);
    b.close(1000, 'left');
    expect((await bLeaves).type).toBe('peer-left');
    const d = await connect(roomId);
    const cPeerJoined = nextMessage(c);
    const dJoined = nextMessage(d);
    join(d, roomId);
    await cPeerJoined;
    const dMessage = (await dJoined) as unknown as { payload: { polite: boolean } };
    expect(dMessage.payload.polite).toBe(true);
    await nextMessage(d);
    c.close();
    d.close();
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

  it('issues one-use pairing credentials only to the owner and excludes helpers from room capacity', async () => {
    const roomId = createRoomId();
    const unjoined = await connect(roomId);
    const unjoinedResponse = nextMessage(unjoined);
    unjoined.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    expect((await unjoinedResponse).type).toBe('protocol-error');
    unjoined.close();
    const owner = await connect(roomId);
    const joined = nextMessage(owner);
    join(owner, roomId);
    await joined;
    await nextMessage(owner);
    const peer = await connect(roomId);
    const peerJoined = nextMessage(peer);
    const ownerPeerJoined = nextMessage(owner);
    join(peer, roomId);
    await Promise.all([peerJoined, ownerPeerJoined]);
    await nextMessage(peer);

    const noPeerLeak = expectNoMessage(peer);
    const credentialResult = nextMessage(owner, 'helper-pairing-created');
    owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    const pairing = (await credentialResult) as {
      type: string;
      payload: { token: string; expiresAt: number };
    };
    expect(pairing.type).toBe('helper-pairing-created');
    expect(pairing.payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairing.payload.expiresAt).toBeGreaterThan(Date.now());
    await noPeerLeak;

    const replacementCredential = nextMessage(owner, 'replacement helper-pairing-created');
    owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    const replacementPairing = (await replacementCredential) as {
      type: string;
      payload: { token: string; expiresAt: number };
    };
    expect(replacementPairing.payload.token).not.toBe(pairing.payload.token);
    const invalidated = await app.request(
      `/api/rooms/${roomId}/helper/ws`,
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${pairing.payload.token}` } },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(invalidated.status).toBe(401);
    const wrongRoom = await app.request(
      `/api/rooms/${createRoomId()}/helper/ws`,
      {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${replacementPairing.payload.token}`,
        },
      },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(wrongRoom.status).toBe(401);

    const paired = nextMessage(owner, 'helper-paired');
    const helperResponse = await app.request(
      `/api/rooms/${roomId}/helper/ws`,
      {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${replacementPairing.payload.token}`,
        },
      },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(helperResponse.status).toBe(101);
    const helper = (helperResponse as Response & { webSocket: WebSocket }).webSocket;
    helper.accept();
    expect((await paired).type).toBe('helper-paired');

    helper.send(JSON.stringify({ type: 'helper-ready' }));
    const controlSessionId = crypto.randomUUID();
    const surfaceId = crypto.randomUUID();
    const authorization = nextMessage(helper, 'helper-session-authorized');
    const noAuthorizationLeak = expectNoMessage(peer);
    owner.send(
      JSON.stringify({
        type: 'helper-session-authorized',
        session: {
          controlSessionId,
          surfaceId,
          scopes: ['pointer'],
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    expect((await authorization).type).toBe('helper-session-authorized');
    await noAuthorizationLeak;
    const revocation = nextMessage(helper, 'helper-session-revoked');
    owner.send(
      JSON.stringify({ type: 'helper-session-revoked', controlSessionId, reason: 'user' }),
    );
    expect((await revocation).type).toBe('helper-session-revoked');

    const replay = await app.request(
      `/api/rooms/${roomId}/helper/ws`,
      {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${replacementPairing.payload.token}`,
        },
      },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(replay.status).toBe(401);
    await expectNoMessage(peer);

    const third = await connect(roomId);
    const roomFull = nextMessage(third);
    join(third, roomId);
    expect((await roomFull).type).toBe('room-full');
    const disconnect = nextMessage(owner, 'helper-disconnected');
    helper.close(1000, 'test done');
    expect((await disconnect).type).toBe('helper-disconnected');
    owner.close();
    peer.close();
    third.close();
  });

  it('routes helper capability, stop and input traffic only between a participant and its own helper', async () => {
    const roomId = createRoomId();
    const owner = await connect(roomId);
    const ownerJoined = nextMessage(owner);
    join(owner, roomId);
    await ownerJoined;
    await nextMessage(owner);
    const peer = await connect(roomId);
    const peerJoined = nextMessage(peer);
    const ownerPeerJoined = nextMessage(owner);
    join(peer, roomId);
    await Promise.all([peerJoined, ownerPeerJoined]);
    await nextMessage(peer);

    const created = nextMessage(owner, 'helper-pairing-created');
    owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    const pairing = (await created) as { type: string; payload: { token: string } };
    const paired = nextMessage(owner, 'helper-paired');
    const response = await app.request(
      `/api/rooms/${roomId}/helper/ws`,
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${pairing.payload.token}` } },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(response.status).toBe(101);
    const helper = (response as Response & { webSocket: WebSocket }).webSocket;
    helper.accept();
    await paired;

    const input = {
      type: 'input-pointer-move',
      protocolVersion: 1,
      controlSessionId: crypto.randomUUID(),
      surfaceId: crypto.randomUUID(),
      sequence: 1,
      x: 0.25,
      y: 0.75,
    };

    // helper -> owner only; the peer never sees helper traffic.
    const capabilities = nextMessage(owner, 'helper-capabilities');
    const noPeerCapability = expectNoMessage(peer);
    helper.send(JSON.stringify({ type: 'helper-capabilities', availableScopes: ['pointer'] }));
    expect(await capabilities).toEqual({
      type: 'helper-capabilities',
      payload: { availableScopes: ['pointer'] },
    });
    await noPeerCapability;

    const sessionId = crypto.randomUUID();
    const stop = nextMessage(owner, 'helper-stop-control');
    const noPeerStop = expectNoMessage(peer);
    helper.send(JSON.stringify({ type: 'helper-stop-control', controlSessionId: sessionId }));
    expect(await stop).toEqual({
      type: 'helper-stop-control',
      payload: { controlSessionId: sessionId },
    });
    await noPeerStop;

    // owner -> its helper only; never to the peer browser.
    const delivered = nextMessage(helper, 'helper-input');
    const noPeerInput = expectNoMessage(peer);
    owner.send(JSON.stringify({ type: 'helper-input', input }));
    expect(await delivered).toEqual({ type: 'helper-input', input });
    await noPeerInput;

    // A participant without a paired helper cannot address anyone else's helper.
    const noHelperDelivery = expectNoMessage(helper);
    const noOwnerEcho = expectNoMessage(owner);
    peer.send(JSON.stringify({ type: 'helper-input', input }));
    await noHelperDelivery;
    await noOwnerEcho;
    peer.send(
      JSON.stringify({
        type: 'helper-session-authorized',
        session: {
          controlSessionId: sessionId,
          surfaceId: input.surfaceId,
          scopes: ['pointer'],
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    await expectNoMessage(helper);

    // Schema-invalid and unsupported keyboard payloads are refused before routing.
    const rejected = nextMessage(peer, 'protocol error');
    peer.send(
      JSON.stringify({
        type: 'helper-input',
        input: { ...input, type: 'input-keyboard', code: 'KeyNotSupported', state: 'down' },
      }),
    );
    expect((await rejected).type).toBe('protocol-error');

    // Padding an otherwise valid envelope past the input size cap is rejected.
    const oversized = nextMessage(owner, 'oversized input rejection');
    owner.send(JSON.stringify({ type: 'helper-input', input }) + ' '.repeat(2048));
    expect((await oversized).type).toBe('protocol-error');
    await expectNoMessage(helper);

    helper.close(1000, 'done');
    owner.close();
    peer.close();
  });

  it('refuses a direct non-WebSocket request at the room object', async () => {
    const stub = env.CALL_ROOM.get(env.CALL_ROOM.idFromName(createRoomId()));

    const response = await stub.fetch('https://room.test/api/rooms/x/ws');
    expect(response.status).toBe(426);

    const helper = await stub.fetch('https://room.test/api/rooms/x/helper/ws');
    expect(helper.status).toBe(426);
  });

  it('closes participants that send binary frames, oversized frames or a second join', async () => {
    const roomId = createRoomId();
    const binary = await connect(roomId);
    const binaryClosed = new Promise<number>((resolve) => {
      binary.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    binary.send(new Uint8Array([1, 2, 3]));
    expect(await binaryClosed).toBe(1009);

    const oversized = await connect(createRoomId());
    const oversizedClosed = new Promise<number>((resolve) => {
      oversized.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    oversized.send('x'.repeat(128 * 1024 + 1));
    expect(await oversizedClosed).toBe(1009);

    const repeat = await connect(roomId);
    const joined = nextMessage(repeat);
    join(repeat, roomId);
    await joined;
    await nextMessage(repeat);
    const closed = new Promise<number>((resolve) => {
      repeat.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    join(repeat, roomId);
    expect(await closed).toBe(1008);
  });

  it('tells the remaining participant when its peer leaves explicitly', async () => {
    const roomId = createRoomId();
    const first = await connect(roomId);
    const firstJoined = nextMessage(first);
    join(first, roomId);
    await firstJoined;
    await nextMessage(first);
    const second = await connect(roomId);
    const secondJoined = nextMessage(second);
    join(second, roomId);
    await secondJoined;

    const peerLeft = nextMessage(first, 'peer-left');
    second.send(JSON.stringify({ type: 'leave', payload: {} }));
    // The first participant may see peer-joined before peer-left.
    let message = await peerLeft;
    if (message.type === 'peer-joined') message = await nextMessage(first, 'peer-left');
    expect(message.type).toBe('peer-left');
    first.close();
  });

  it('refuses malformed helper messages and helper attempts to inject participant traffic', async () => {
    const roomId = createRoomId();
    const owner = await connect(roomId);
    const ownerJoined = nextMessage(owner);
    join(owner, roomId);
    await ownerJoined;
    await nextMessage(owner);
    const peer = await connect(roomId);
    const peerJoined = nextMessage(peer);
    const ownerPeerJoined = nextMessage(owner);
    join(peer, roomId);
    await Promise.all([peerJoined, ownerPeerJoined]);
    await nextMessage(peer);

    for (const bad of [
      { type: 'offer', payload: { sdp: 'v=0' } },
      { type: 'helper-input', input: { type: 'input-scroll' } },
      { type: 'helper-capabilities', availableScopes: ['pointer'], displays: [{ id: 1 }] },
      { type: 'helper-capabilities', availableScopes: ['clipboard'] },
      { type: 'control-revoked' },
    ]) {
      const created = nextMessage(owner, 'helper-pairing-created');
      owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
      const pairing = (await created) as { type: string; payload: { token: string } };
      const paired = nextMessage(owner, 'helper-paired');
      const response = await app.request(
        `/api/rooms/${roomId}/helper/ws`,
        { headers: { Upgrade: 'websocket', Authorization: `Bearer ${pairing.payload.token}` } },
        { ...env, ENVIRONMENT: 'production' },
      );
      const helper = (response as Response & { webSocket: WebSocket }).webSocket;
      helper.accept();
      await paired;
      const closed = new Promise<number>((resolve) => {
        helper.addEventListener('close', (event) => {
          resolve(event.code);
        });
      });
      const noPeerLeak = expectNoMessage(peer);
      const disconnected = nextMessage(owner, 'helper-disconnected');
      helper.send(JSON.stringify(bad));
      expect(await closed, JSON.stringify(bad)).toBe(1008);
      // The owner only learns the helper went away; nothing the helper sent is relayed.
      expect((await disconnected).type).toBe('helper-disconnected');
      await noPeerLeak;
    }
    peer.close();
  });

  it('rejects expired helper pairing credentials', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const roomId = createRoomId();
      const owner = await connect(roomId);
      const joined = nextMessage(owner);
      join(owner, roomId);
      await joined;
      await nextMessage(owner);
      const created = nextMessage(owner, 'helper-pairing-created');
      owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
      const pairing = (await created) as { type: string; payload: { token: string } };
      clock.mockReturnValue(now + 2 * 60 * 1000 + 1);
      const expired = await app.request(
        `/api/rooms/${roomId}/helper/ws`,
        { headers: { Upgrade: 'websocket', Authorization: `Bearer ${pairing.payload.token}` } },
        { ...env, ENVIRONMENT: 'production' },
      );
      expect(expired.status).toBe(401);
      owner.close();
    } finally {
      clock.mockRestore();
    }
  });

  it('closes the paired helper when its owner explicitly leaves the room', async () => {
    const roomId = createRoomId();
    const owner = await connect(roomId);
    const joined = nextMessage(owner);
    join(owner, roomId);
    await joined;
    await nextMessage(owner);
    const pairingCreated = nextMessage(owner, 'helper-pairing-created');
    owner.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
    const pairing = (await pairingCreated) as { type: string; payload: { token: string } };
    const paired = nextMessage(owner, 'helper-paired');
    const response = await app.request(
      `/api/rooms/${roomId}/helper/ws`,
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${pairing.payload.token}` } },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(response.status).toBe(101);
    const helper = (response as Response & { webSocket: WebSocket }).webSocket;
    helper.accept();
    await paired;
    const helperClosed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Owner leave did not close its helper.'));
      }, 1000);
      helper.addEventListener(
        'close',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
    owner.send(JSON.stringify({ type: 'leave', payload: {} }));
    await helperClosed;
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
