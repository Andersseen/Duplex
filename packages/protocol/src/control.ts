import { z } from 'zod';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_SESSION_MAX_AGE_MS = 10 * 60 * 1000;
export const CONTROL_REQUEST_TIMEOUT_MS = 30 * 1000;

const uuid = z.uuid();
const scopes = z
  .array(z.enum(['pointer', 'keyboard']))
  .min(1)
  .max(2)
  .refine((values) => new Set(values).size === values.length, 'Scopes must be unique.');
const controlBase = {
  protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
  surfaceId: uuid,
};

export const controlCapabilityMessageSchema = z
  .object({
    type: z.literal('control-capability'),
    ...controlBase,
    helperConnected: z.boolean(),
  })
  .strict();

export const controlRequestMessageSchema = z
  .object({
    type: z.literal('control-request'),
    ...controlBase,
    requestId: uuid,
    scopes,
  })
  .strict();

export const controlGrantedMessageSchema = z
  .object({
    type: z.literal('control-granted'),
    ...controlBase,
    requestId: uuid,
    controlSessionId: uuid,
    scopes,
    expiresAt: z.number().int().positive(),
  })
  .strict();

export const controlRejectedMessageSchema = z
  .object({
    type: z.literal('control-rejected'),
    ...controlBase,
    requestId: uuid,
  })
  .strict();

export const controlRevocationReasonSchema = z.enum([
  'user',
  'expired',
  'disconnected',
  'surface-ended',
  'helper-disconnected',
  'superseded',
]);
export const controlRevokedMessageSchema = z
  .object({
    type: z.literal('control-revoked'),
    ...controlBase,
    requestId: uuid,
    controlSessionId: uuid,
    reason: controlRevocationReasonSchema,
  })
  .strict();

export const controlMessageSchema = z.discriminatedUnion('type', [
  controlCapabilityMessageSchema,
  controlRequestMessageSchema,
  controlGrantedMessageSchema,
  controlRejectedMessageSchema,
  controlRevokedMessageSchema,
]);

export type ControlScope = z.infer<typeof scopes>[number];
export type ControlRevocationReason = z.infer<typeof controlRevocationReasonSchema>;
export type ControlCapabilityMessage = z.infer<typeof controlCapabilityMessageSchema>;
export type ControlRequestMessage = z.infer<typeof controlRequestMessageSchema>;
export type ControlGrantedMessage = z.infer<typeof controlGrantedMessageSchema>;
export type ControlRejectedMessage = z.infer<typeof controlRejectedMessageSchema>;
export type ControlRevokedMessage = z.infer<typeof controlRevokedMessageSchema>;
export type ControlMessage = z.infer<typeof controlMessageSchema>;
