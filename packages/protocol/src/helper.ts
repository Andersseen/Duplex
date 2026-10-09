import { z } from 'zod';
import { roomIdSchema } from './room';
import { inputMessageSchema } from './input';
import { controlRevocationReasonSchema, controlScopeSchema } from './control';

export const HELPER_PAIRING_PREFIX = 'duplex-pair-v1.';
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid pairing credential.');
const apiOriginSchema = z.url().superRefine((value, context) => {
  try {
    const url = new URL(value);
    const developmentHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      context.addIssue({
        code: 'custom',
        message: 'Origin must not include credentials, path, query or fragment.',
      });
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && developmentHost))
      context.addIssue({ code: 'custom', message: 'Pairing origin must use HTTPS.' });
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid API origin.' });
  }
});

export const helperPairingBundleSchema = z
  .object({
    version: z.literal(1),
    apiOrigin: apiOriginSchema,
    roomId: roomIdSchema,
    token: tokenSchema,
  })
  .strict();
export type HelperPairingBundle = z.infer<typeof helperPairingBundleSchema>;

export function encodeHelperPairingBundle(input: HelperPairingBundle): string {
  const value = helperPairingBundleSchema.parse(input);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${HELPER_PAIRING_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

export function decodeHelperPairingBundle(input: string): HelperPairingBundle {
  if (!input.startsWith(HELPER_PAIRING_PREFIX)) throw new Error('Invalid helper pairing code.');
  const payload = input.slice(HELPER_PAIRING_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('Invalid helper pairing code.');
  try {
    const binary = atob(
      payload.replaceAll('-', '+').replaceAll('_', '/') +
        '='.repeat((4 - (payload.length % 4)) % 4),
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return helperPairingBundleSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      ) as unknown,
    );
  } catch {
    throw new Error('Invalid helper pairing code.');
  }
}

export const helperSessionMetadataSchema = z
  .object({
    controlSessionId: z.uuid(),
    surfaceId: z.uuid(),
    scopes: z.array(controlScopeSchema).min(1).max(2),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(
    (session) => new Set(session.scopes).size === session.scopes.length,
    'Scopes must be unique.',
  );

const helperScopesSchema = z
  .array(controlScopeSchema)
  .max(2)
  .refine((values) => new Set(values).size === values.length, 'Scopes must be unique.');

/** Messages the native helper sends to the room. Only safe, coarse control-plane state. */
export const helperOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('helper-ready') }).strict(),
  z
    .object({ type: z.literal('helper-capabilities'), availableScopes: helperScopesSchema })
    .strict(),
  z.object({ type: z.literal('helper-stop-control'), controlSessionId: z.uuid() }).strict(),
]);
export type HelperOutboundMessage = z.infer<typeof helperOutboundMessageSchema>;

/** Messages the room sends to the native helper. */
export const helperBridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('helper-ready') }).strict(),
  z
    .object({ type: z.literal('helper-session-authorized'), session: helperSessionMetadataSchema })
    .strict(),
  z
    .object({
      type: z.literal('helper-session-revoked'),
      controlSessionId: z.uuid(),
      reason: controlRevocationReasonSchema,
    })
    .strict(),
  z.object({ type: z.literal('helper-input'), input: inputMessageSchema }).strict(),
]);
export type HelperBridgeMessage = z.infer<typeof helperBridgeMessageSchema>;
