import { z } from 'zod';

/** Native input sent over the dedicated `duplex-input` DataChannel. */
export const INPUT_PROTOCOL_VERSION = 1;
export const MAX_INPUT_MESSAGE_BYTES = 512;
/** Largest logical scroll delta (CSS-pixel-like units) accepted in one message. */
export const MAX_INPUT_SCROLL_DELTA = 2000;
export const MAX_INPUT_SEQUENCE = 2 ** 32 - 1;
/** Ceiling for accepted input messages per second; 60 Hz pointer control stays well below it. */
export const MAX_INPUT_EVENTS_PER_SECOND = 240;

const uuid = z.uuid();
const normalized = z.number().min(0).max(1);
const base = {
  protocolVersion: z.literal(INPUT_PROTOCOL_VERSION),
  controlSessionId: uuid,
  surfaceId: uuid,
  sequence: z.number().int().nonnegative().max(MAX_INPUT_SEQUENCE),
};
const scrollDelta = z.number().min(-MAX_INPUT_SCROLL_DELTA).max(MAX_INPUT_SCROLL_DELTA);

/** Physical KeyboardEvent.code values supported by the first macOS keyboard backend. */
export const SUPPORTED_KEY_CODES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
  ...'0123456789'.split('').map((digit) => `Digit${digit}`),
  'Space',
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Comma',
  'Period',
  'Slash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Minus',
  'Equal',
  'Backquote',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
] as const;
const supportedKeyCodes: ReadonlySet<string> = new Set(SUPPORTED_KEY_CODES);
const keyCode = z.string().refine((code) => supportedKeyCodes.has(code), 'Unsupported key code.');

export const inputKeyboardSchema = z
  .object({
    type: z.literal('input-keyboard'),
    ...base,
    code: keyCode,
    state: z.enum(['down', 'up']),
  })
  .strict();

export const inputPointerMoveSchema = z
  .object({ type: z.literal('input-pointer-move'), ...base, x: normalized, y: normalized })
  .strict();

export const inputPointerButtonSchema = z
  .object({
    type: z.literal('input-pointer-button'),
    ...base,
    button: z.enum(['left', 'right']),
    state: z.enum(['down', 'up']),
    x: normalized,
    y: normalized,
  })
  .strict();

export const inputScrollSchema = z
  .object({ type: z.literal('input-scroll'), ...base, deltaX: scrollDelta, deltaY: scrollDelta })
  .strict();

export const inputMessageSchema = z.discriminatedUnion('type', [
  inputPointerMoveSchema,
  inputPointerButtonSchema,
  inputScrollSchema,
  inputKeyboardSchema,
]);

export type InputPointerMove = z.infer<typeof inputPointerMoveSchema>;
export type InputPointerButton = z.infer<typeof inputPointerButtonSchema>;
export type InputScroll = z.infer<typeof inputScrollSchema>;
export type InputKeyboard = z.infer<typeof inputKeyboardSchema>;
export type InputMessage = z.infer<typeof inputMessageSchema>;
export type InputPointerButtonName = InputPointerButton['button'];
