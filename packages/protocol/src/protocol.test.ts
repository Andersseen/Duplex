import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  FILE_TRANSFER_PROTOCOL_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_FILE_TRANSFER_BYTES,
  controlMessageSchema,
  collaborationMessageSchema,
  pointerMessageSchema,
  MAX_COLLABORATION_BATCH_POINTS,
  createRoomId,
  fileTransferMessageSchema,
  healthResponseSchema,
  parseDuplexMessage,
  roomIdSchema,
  serverRoomMessageSchema,
  signalingMessageSchema,
} from './index';

const requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('file-transfer messages', () => {
  it('validates versioned bounded file offers and all transfer controls', () => {
    const transferId = crypto.randomUUID();
    expect(
      fileTransferMessageSchema.safeParse({
        type: 'file-offer',
        transferId,
        protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        name: 'notes.pdf',
        size: MAX_FILE_TRANSFER_BYTES,
        mimeType: 'application/pdf',
      }).success,
    ).toBe(true);
    expect(
      fileTransferMessageSchema.safeParse({
        type: 'file-offer',
        transferId,
        protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        name: '../notes.pdf',
        size: MAX_FILE_TRANSFER_BYTES + 1,
        mimeType: 'application/pdf',
      }).success,
    ).toBe(false);
    for (const type of ['file-accept', 'file-reject', 'file-cancel', 'file-complete'])
      expect(
        fileTransferMessageSchema.safeParse({
          type,
          transferId,
          protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        }).success,
      ).toBe(true);
  });
});

describe('collaboration messages', () => {
  const surfaceId = crypto.randomUUID();
  const strokeId = crypto.randomUUID();
  const base = { protocolVersion: COLLABORATION_PROTOCOL_VERSION };

  it('enforces explicit screen identity and strict media state', () => {
    expect(
      collaborationMessageSchema.safeParse({
        type: 'media-state',
        ...base,
        videoSource: 'screen',
        surfaceId,
      }).success,
    ).toBe(true);
    for (const [videoSource, id] of [
      ['screen', null],
      ['camera', surfaceId],
      ['none', surfaceId],
    ])
      expect(
        collaborationMessageSchema.safeParse({
          type: 'media-state',
          ...base,
          videoSource,
          surfaceId: id,
        }).success,
      ).toBe(false);
    expect(
      collaborationMessageSchema.safeParse({
        type: 'media-state',
        ...base,
        videoSource: 'none',
        surfaceId: null,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('validates bounded stroke messages, clear messages, and UUIDs', () => {
    const point = { x: 0.42, y: 0.73 };
    const messages = [
      { type: 'stroke-start', ...base, surfaceId, strokeId, point },
      {
        type: 'stroke-points',
        ...base,
        surfaceId,
        strokeId,
        points: [point],
      },
      { type: 'stroke-end', ...base, surfaceId, strokeId },
      { type: 'annotations-clear', ...base, surfaceId },
    ];
    for (const message of messages)
      expect(collaborationMessageSchema.safeParse(message).success).toBe(true);
    expect(
      collaborationMessageSchema.safeParse({
        type: 'stroke-points',
        ...base,
        surfaceId,
        strokeId,
        points: Array.from({ length: MAX_COLLABORATION_BATCH_POINTS + 1 }, () => point),
      }).success,
    ).toBe(false);
    expect(
      collaborationMessageSchema.safeParse({
        type: 'stroke-start',
        ...base,
        surfaceId: 'bad',
        strokeId,
        point,
      }).success,
    ).toBe(false);
    expect(
      collaborationMessageSchema.safeParse({
        ...messages[0],
        protocolVersion: COLLABORATION_PROTOCOL_VERSION + 1,
      }).success,
    ).toBe(false);
  });

  it('validates normalized pointer bounds, sequence numbers, and strict fields', () => {
    const pointer = {
      type: 'pointer',
      ...base,
      surfaceId,
      mode: 'pointer',
      x: 0.42,
      y: 0.73,
      sequence: 42,
    };
    expect(pointerMessageSchema.safeParse(pointer).success).toBe(true);
    expect(pointerMessageSchema.safeParse({ ...pointer, x: 1.01 }).success).toBe(false);
    expect(pointerMessageSchema.safeParse({ ...pointer, sequence: -1 }).success).toBe(false);
    expect(pointerMessageSchema.safeParse({ ...pointer, extra: true }).success).toBe(false);
    expect(
      pointerMessageSchema.safeParse({
        type: 'pointer-hide',
        ...base,
        surfaceId,
        sequence: 43,
      }).success,
    ).toBe(true);
  });
});

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

  it('parses mismatched protocol versions so the room can return a typed error', () => {
    const result = signalingMessageSchema.safeParse({
      type: 'join',
      payload: { roomId: createRoomId(), protocolVersion: PROTOCOL_VERSION + 1 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all server room lifecycle messages and rejects malformed or unknown messages', () => {
    const participantId = 'abcdefghijklmnop';
    for (const message of [
      { type: 'joined', payload: { participantId, polite: false, peerPresent: false } },
      { type: 'peer-joined', payload: { participantId } },
      { type: 'peer-left', payload: {} },
      { type: 'room-full', payload: { reason: 'capacity' } },
      {
        type: 'protocol-error',
        payload: {
          code: 'protocol_mismatch',
          message: 'Version mismatch',
          expectedVersion: PROTOCOL_VERSION,
        },
      },
    ]) {
      expect(serverRoomMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
    for (const message of [
      null,
      {},
      { type: 'unknown', payload: {} },
      { type: 'joined', payload: {} },
    ]) {
      expect(serverRoomMessageSchema.safeParse(message).success).toBe(false);
    }
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
