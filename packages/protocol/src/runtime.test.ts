import { describe, expect, it } from 'vitest';
import { createRoomId, roomIdSchema, signalingMessageSchema } from './index';

// Own file so nothing has parsed (and possibly code-generated) before Function is instrumented.
describe('protocol runtime configuration', () => {
  it('validates without ever generating code, which a CSP without unsafe-eval forbids', () => {
    const original = globalThis.Function;
    let attempts = 0;
    globalThis.Function = new Proxy(original, {
      apply(target, thisArg, args: unknown[]) {
        attempts += 1;
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      construct(target, args: unknown[], newTarget) {
        attempts += 1;
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    let results: boolean[];
    try {
      results = [
        roomIdSchema.safeParse(createRoomId()).success,
        roomIdSchema.safeParse('1').success,
        signalingMessageSchema.safeParse({ type: 'leave', payload: {} }).success,
        signalingMessageSchema.safeParse({ type: 'nope' }).success,
      ];
    } finally {
      globalThis.Function = original;
    }
    expect(results).toEqual([true, false, true, false]);
    expect(attempts).toBe(0);
  });
});
