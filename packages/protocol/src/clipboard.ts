import { z } from 'zod';

/** Text-only clipboard transfer over the dedicated `duplex-input` DataChannel. */
export const CLIPBOARD_PROTOCOL_VERSION = 1;
/** Largest clipboard payload, in UTF-8 bytes. Longer text is rejected, never truncated. */
export const MAX_CLIPBOARD_TEXT_BYTES = 4096;
/**
 * Largest serialized clipboard frame. Accepted text contains no control characters other than
 * tab, CR and LF, so JSON escaping can at most double the text.
 */
export const MAX_CLIPBOARD_MESSAGE_BYTES = 16 * 1024;
/** How long the controlled user has to approve a request to read their clipboard. */
export const CLIPBOARD_APPROVAL_TIMEOUT_MS = 30 * 1000;
/** How long the controller waits for any clipboard operation to finish. */
export const CLIPBOARD_OPERATION_TIMEOUT_MS = 35 * 1000;
/** Minimum spacing between accepted clipboard operations in one control session. */
export const CLIPBOARD_MIN_INTERVAL_MS = 500;

const MAX_SEQUENCE = 2 ** 32 - 1;
const uuid = z.uuid();
const encoder = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether `value` is clipboard text Duplex will carry: non-empty, within the byte bound,
 * well-formed Unicode and free of control characters other than tab, CR and LF.
 */
export function isAcceptableClipboardText(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CLIPBOARD_TEXT_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return false;
  if (LONE_SURROGATE.test(value)) return false;
  return encoder.encode(value).byteLength <= MAX_CLIPBOARD_TEXT_BYTES;
}

export const clipboardTextSchema = z
  .string()
  .refine(isAcceptableClipboardText, 'Unsupported clipboard text.');

const base = {
  protocolVersion: z.literal(CLIPBOARD_PROTOCOL_VERSION),
  controlSessionId: uuid,
  surfaceId: uuid,
  /** Per-direction, strictly increasing within one control session. */
  sequence: z.number().int().nonnegative().max(MAX_SEQUENCE),
  transferId: uuid,
};

export const clipboardOutcomeSchema = z.enum([
  'delivered',
  'declined',
  'unavailable',
  'empty',
  'too-large',
  'denied',
  'busy',
  'failed',
]);

/** Controller → controlled: place this text on the controlled computer's clipboard. */
export const clipboardWriteSchema = z
  .object({ type: z.literal('clipboard-write'), ...base, text: clipboardTextSchema })
  .strict();

/** Controller → controlled: ask to read the controlled clipboard once. The user must approve. */
export const clipboardReadRequestSchema = z
  .object({ type: z.literal('clipboard-read-request'), ...base })
  .strict();

/** Controlled → controller: the approved clipboard text. */
export const clipboardTextMessageSchema = z
  .object({ type: z.literal('clipboard-text'), ...base, text: clipboardTextSchema })
  .strict();

/** Controlled → controller: how a write or read ended, without any clipboard content. */
export const clipboardStatusSchema = z
  .object({ type: z.literal('clipboard-status'), ...base, outcome: clipboardOutcomeSchema })
  .strict();

export const clipboardMessageSchema = z.discriminatedUnion('type', [
  clipboardWriteSchema,
  clipboardReadRequestSchema,
  clipboardTextMessageSchema,
  clipboardStatusSchema,
]);

// ----- Room ↔ paired helper (the participant's own helper only) -----------------------------

const helperBase = { controlSessionId: uuid, surfaceId: uuid, transferId: uuid };

export const helperClipboardWriteSchema = z
  .object({ type: z.literal('helper-clipboard-write'), ...helperBase, text: clipboardTextSchema })
  .strict();
export const helperClipboardReadSchema = z
  .object({ type: z.literal('helper-clipboard-read'), ...helperBase })
  .strict();

export const helperClipboardOutcomeSchema = z.enum([
  'ok',
  'denied',
  'unavailable',
  'empty',
  'too-large',
  'failed',
]);
/** The helper's answer. `text` is present only for a successful read. */
export const helperClipboardResultSchema = z
  .object({
    type: z.literal('helper-clipboard-result'),
    controlSessionId: uuid,
    transferId: uuid,
    outcome: helperClipboardOutcomeSchema,
    text: clipboardTextSchema.optional(),
  })
  .strict()
  .refine((result) => result.outcome === 'ok' || result.text === undefined, {
    message: 'Text is only valid with a successful read.',
  });

export type ClipboardOutcome = z.infer<typeof clipboardOutcomeSchema>;
export type ClipboardWrite = z.infer<typeof clipboardWriteSchema>;
export type ClipboardReadRequest = z.infer<typeof clipboardReadRequestSchema>;
export type ClipboardTextMessage = z.infer<typeof clipboardTextMessageSchema>;
export type ClipboardStatus = z.infer<typeof clipboardStatusSchema>;
export type ClipboardMessage = z.infer<typeof clipboardMessageSchema>;
export type HelperClipboardWrite = z.infer<typeof helperClipboardWriteSchema>;
export type HelperClipboardRead = z.infer<typeof helperClipboardReadSchema>;
export type HelperClipboardResult = z.infer<typeof helperClipboardResultSchema>;
export type HelperClipboardOutcome = z.infer<typeof helperClipboardOutcomeSchema>;
