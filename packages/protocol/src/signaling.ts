import { z } from 'zod';
import { roomIdSchema } from './room';

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

export const serverRoomMessageSchema = z.discriminatedUnion('type', [
  joinedMessageSchema,
  peerJoinedMessageSchema,
  peerLeftMessageSchema,
  roomFullMessageSchema,
  protocolErrorMessageSchema,
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
export type ServerSignalingMessage = z.infer<typeof serverSignalingMessageSchema>;
export type RoomServerMessage = z.infer<typeof serverRoomMessageSchema>;
