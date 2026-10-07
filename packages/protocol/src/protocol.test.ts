import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  controlMessageSchema,
  createRoomId,
  healthResponseSchema,
  parseDuplexMessage,
  roomIdSchema,
  signalingMessageSchema,
} from './index';

const requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('room ids', () => {
  it('generates valid, unique, URL-safe ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRoomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(roomIdSchema.safeParse(id).success).toBe(true);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it.each(['', '1', 'short', 'a'.repeat(21), 'a'.repeat(23), 'a'.repeat(21) + '/'])(
    'rejects %j',
    (value) => {
      expect(roomIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('signaling messages', () => {
  it('accepts a valid join', () => {
    const result = signalingMessageSchema.safeParse({
      type: 'join',
      payload: { roomId: createRoomId(), protocolVersion: PROTOCOL_VERSION },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a join from a different protocol version', () => {
    const result = signalingMessageSchema.safeParse({
      type: 'join',
      payload: { roomId: createRoomId(), protocolVersion: PROTOCOL_VERSION + 1 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts offer, answer, leave and ice candidates', () => {
    for (const message of [
      { type: 'offer', payload: { sdp: 'v=0' } },
      { type: 'answer', payload: { sdp: 'v=0' } },
      { type: 'leave', payload: {} },
      {
        type: 'ice-candidate',
        payload: { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } },
      },
      { type: 'ice-candidate', payload: { candidate: null } },
    ]) {
      expect(signalingMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it('rejects malformed messages', () => {
    for (const message of [
      null,
      'offer',
      {},
      { type: 'offer' },
      { type: 'offer', payload: { sdp: '' } },
      { type: 'unknown', payload: {} },
      { type: 'ice-candidate', payload: { candidate: { candidate: 1 } } },
    ]) {
      expect(signalingMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe('control messages', () => {
  it('accepts a request, grant, rejection and revocation', () => {
    for (const message of [
      { type: 'control-request', payload: { requestId, scopes: ['pointer', 'keyboard'] } },
      { type: 'control-granted', payload: { requestId, scopes: ['pointer'], expiresAt: 1 } },
      { type: 'control-rejected', payload: { requestId } },
      { type: 'control-revoked', payload: { requestId, reason: 'user' } },
    ]) {
      expect(controlMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it('rejects grants without an expiry, empty scopes and unknown scopes', () => {
    for (const message of [
      { type: 'control-granted', payload: { requestId, scopes: ['pointer'] } },
      { type: 'control-request', payload: { requestId, scopes: [] } },
      { type: 'control-request', payload: { requestId, scopes: ['clipboard'] } },
      { type: 'control-request', payload: { requestId: 'not-a-uuid', scopes: ['pointer'] } },
    ]) {
      expect(controlMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe('parseDuplexMessage', () => {
  it('routes both signaling and control messages', () => {
    expect(parseDuplexMessage({ type: 'leave', payload: {} }).success).toBe(true);
    expect(parseDuplexMessage({ type: 'control-rejected', payload: { requestId } }).success).toBe(
      true,
    );
    expect(parseDuplexMessage({ type: 'nope', payload: {} }).success).toBe(false);
  });
});

describe('health response', () => {
  it('matches the shape the worker returns', () => {
    const body = { status: 'ok', service: 'duplex-worker', protocolVersion: PROTOCOL_VERSION };
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ...body, status: 'down' }).success).toBe(false);
  });
});
