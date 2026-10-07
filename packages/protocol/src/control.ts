import { z } from 'zod';

/**
 * Remote-control negotiation. Control is always requested, explicitly granted,
 * temporary and revocable. These messages carry no input events and no credentials:
 * a short-lived scoped token for the native helper will be issued out of band.
 */
const requestIdSchema = z.uuid();

export const controlScopeSchema = z.enum(['pointer', 'keyboard']);
export type ControlScope = z.infer<typeof controlScopeSchema>;

export const controlRequestMessageSchema = z.object({
  type: z.literal('control-request'),
  payload: z.object({
    requestId: requestIdSchema,
    scopes: z.array(controlScopeSchema).min(1).max(2),
  }),
});

export const controlGrantedMessageSchema = z.object({
  type: z.literal('control-granted'),
  payload: z.object({
    requestId: requestIdSchema,
    scopes: z.array(controlScopeSchema).min(1).max(2),
    /** Unix epoch milliseconds. Every grant expires. */
    expiresAt: z.number().int().positive(),
  }),
});

export const controlRejectedMessageSchema = z.object({
  type: z.literal('control-rejected'),
  payload: z.object({ requestId: requestIdSchema }),
});

export const controlRevokedMessageSchema = z.object({
  type: z.literal('control-revoked'),
  payload: z.object({
    requestId: requestIdSchema,
    reason: z.enum(['user', 'expired', 'disconnected']),
  }),
});

export const controlMessageSchema = z.discriminatedUnion('type', [
  controlRequestMessageSchema,
  controlGrantedMessageSchema,
  controlRejectedMessageSchema,
  controlRevokedMessageSchema,
]);

export type ControlRequestMessage = z.infer<typeof controlRequestMessageSchema>;
export type ControlGrantedMessage = z.infer<typeof controlGrantedMessageSchema>;
export type ControlRejectedMessage = z.infer<typeof controlRejectedMessageSchema>;
export type ControlRevokedMessage = z.infer<typeof controlRevokedMessageSchema>;
export type ControlMessage = z.infer<typeof controlMessageSchema>;
