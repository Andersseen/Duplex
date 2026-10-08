import { z } from 'zod';
import { roomIdSchema } from './room';
import { helperSessionMetadataSchema } from './helper';

const SDP_LIMIT = 64 * 1024;

export const joinMessageSchema = z
  .object({
    type: z.literal('join'),
    payload: z
      .object({
        roomId: roomIdSchema,
        protocolVersion: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const leaveMessageSchema = z
  .object({ type: z.literal('leave'), payload: z.object({}).strict() })
  .strict();

export const refreshRtcConfigMessageSchema = z
  .object({ type: z.literal('refresh-rtc-config'), payload: z.object({}).strict() })
  .strict();

export const helperPairingCreateMessageSchema = z
  .object({ type: z.literal('helper-pairing-create'), payload: z.object({}).strict() })
  .strict();
export const helperSessionAuthorizedMessageSchema = z
  .object({
    type: z.literal('helper-session-authorized'),
    session: helperSessionMetadataSchema,
  })
  .strict();
export const helperSessionRevokedMessageSchema = z
  .object({
    type: z.literal('helper-session-revoked'),
    controlSessionId: z.uuid(),
    reason: z.enum([
      'user',
      'expired',
      'disconnected',
      'surface-ended',
      'helper-disconnected',
      'superseded',
    ]),
  })
  .strict();

export const offerMessageSchema = z
  .object({
    type: z.literal('offer'),
    payload: z.object({ sdp: z.string().min(1).max(SDP_LIMIT) }).strict(),
  })
  .strict();

export const answerMessageSchema = z
  .object({
    type: z.literal('answer'),
    payload: z.object({ sdp: z.string().min(1).max(SDP_LIMIT) }).strict(),
  })
  .strict();

export const iceCandidateMessageSchema = z
  .object({
    type: z.literal('ice-candidate'),
    payload: z
      .object({
        /** `null` marks the end of candidates. */
        candidate: z
          .object({
            candidate: z.string().max(8 * 1024),
            sdpMid: z.string().nullable(),
            sdpMLineIndex: z.number().int().nonnegative().nullable(),
            usernameFragment: z.string().nullable().optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const clientSignalingMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  leaveMessageSchema,
  refreshRtcConfigMessageSchema,
  helperPairingCreateMessageSchema,
  helperSessionAuthorizedMessageSchema,
  helperSessionRevokedMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export const joinedMessageSchema = z
  .object({
    type: z.literal('joined'),
    payload: z
      .object({
        participantId: z.string().min(16).max(64),
        polite: z.boolean(),
        peerPresent: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const peerJoinedMessageSchema = z
  .object({
    type: z.literal('peer-joined'),
    payload: z.object({ participantId: z.string().min(16).max(64) }).strict(),
  })
  .strict();

export const peerLeftMessageSchema = z
  .object({ type: z.literal('peer-left'), payload: z.object({}).strict() })
  .strict();

export const roomFullMessageSchema = z
  .object({
    type: z.literal('room-full'),
    payload: z.object({ reason: z.literal('capacity') }).strict(),
  })
  .strict();

export const protocolErrorMessageSchema = z
  .object({
    type: z.literal('protocol-error'),
    payload: z
      .object({
        code: z.enum(['protocol_mismatch', 'invalid_message', 'not_joined']),
        message: z.string().min(1).max(160),
        expectedVersion: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

const rtcIceServerSchema = z
  .object({
    urls: z.union([z.url(), z.array(z.url()).min(1).max(16)]),
    username: z.string().min(1).max(256).optional(),
    credential: z.string().min(1).max(512).optional(),
  })
  .strict();

export const rtcConfigMessageSchema = z
  .object({
    type: z.literal('rtc-config'),
    payload: z
      .object({
        iceServers: z.array(rtcIceServerSchema).min(1).max(8),
        expiresAt: z.number().int().positive(),
        relayAvailable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const helperPairingCreatedMessageSchema = z
  .object({
    type: z.literal('helper-pairing-created'),
    payload: z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export const helperPairedMessageSchema = z
  .object({
    type: z.literal('helper-paired'),
    payload: z.object({}).strict(),
  })
  .strict();
export const helperDisconnectedMessageSchema = z
  .object({
    type: z.literal('helper-disconnected'),
    payload: z.object({}).strict(),
  })
  .strict();

export const serverRoomMessageSchema = z.discriminatedUnion('type', [
  joinedMessageSchema,
  peerJoinedMessageSchema,
  peerLeftMessageSchema,
  roomFullMessageSchema,
  protocolErrorMessageSchema,
  rtcConfigMessageSchema,
  helperPairingCreatedMessageSchema,
  helperPairedMessageSchema,
  helperDisconnectedMessageSchema,
]);

export const serverSignalingMessageSchema = z.union([
  serverRoomMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

/** Legacy name retained for consumers that parse client signaling messages. */
export const signalingMessageSchema = clientSignalingMessageSchema;

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type LeaveMessage = z.infer<typeof leaveMessageSchema>;
export type OfferMessage = z.infer<typeof offerMessageSchema>;
export type AnswerMessage = z.infer<typeof answerMessageSchema>;
export type IceCandidateMessage = z.infer<typeof iceCandidateMessageSchema>;
export type SignalingMessage = z.infer<typeof clientSignalingMessageSchema>;
export type RtcConfigMessage = z.infer<typeof rtcConfigMessageSchema>;
export type HelperPairingCreatedMessage = z.infer<typeof helperPairingCreatedMessageSchema>;
export type ServerSignalingMessage = z.infer<typeof serverSignalingMessageSchema>;
export type RoomServerMessage = z.infer<typeof serverRoomMessageSchema>;
