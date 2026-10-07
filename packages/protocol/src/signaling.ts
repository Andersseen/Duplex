import { z } from 'zod';
import { PROTOCOL_VERSION } from './version';
import { roomIdSchema } from './room';

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  payload: z.object({
    roomId: roomIdSchema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
  }),
});

export const leaveMessageSchema = z.object({
  type: z.literal('leave'),
  payload: z.object({}),
});

export const offerMessageSchema = z.object({
  type: z.literal('offer'),
  payload: z.object({ sdp: z.string().min(1) }),
});

export const answerMessageSchema = z.object({
  type: z.literal('answer'),
  payload: z.object({ sdp: z.string().min(1) }),
});

export const iceCandidateMessageSchema = z.object({
  type: z.literal('ice-candidate'),
  payload: z.object({
    /** `null` marks the end of candidates. */
    candidate: z
      .object({
        candidate: z.string(),
        sdpMid: z.string().nullable(),
        sdpMLineIndex: z.number().int().nonnegative().nullable(),
        usernameFragment: z.string().nullable().optional(),
      })
      .nullable(),
  }),
});

export const signalingMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  leaveMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type LeaveMessage = z.infer<typeof leaveMessageSchema>;
export type OfferMessage = z.infer<typeof offerMessageSchema>;
export type AnswerMessage = z.infer<typeof answerMessageSchema>;
export type IceCandidateMessage = z.infer<typeof iceCandidateMessageSchema>;
export type SignalingMessage = z.infer<typeof signalingMessageSchema>;
