import { describe, expect, it } from 'vitest';
import {
  ConnectionLimiter,
  MAX_CONSECUTIVE_REFUSALS,
  TokenBucket,
  createHelperLimiter,
  createParticipantLimiter,
} from '../src/rate-limit';

function fakeClock(start = 1000) {
  let now = start;
  return {
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(value: number) {
      now = value;
    },
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity and then limits', () => {
    const time = fakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, time.clock());
    expect([1, 2, 3].map(() => bucket.take(time.clock()))).toEqual(['ok', 'ok', 'ok']);
    expect(bucket.take(time.clock())).toBe('limited');
  });

  it('refills with elapsed time and never beyond capacity', () => {
    const time = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 }, time.clock());
    bucket.take(time.clock());
    bucket.take(time.clock());
    expect(bucket.take(time.clock())).toBe('limited');
    time.advance(500);
    expect(bucket.take(time.clock())).toBe('ok');
    expect(bucket.take(time.clock())).toBe('limited');
    time.advance(60_000);
    expect([bucket.take(time.clock()), bucket.take(time.clock())]).toEqual(['ok', 'ok']);
    expect(bucket.take(time.clock())).toBe('limited');
  });

  it('does not mint tokens when the clock stalls or moves backwards', () => {
    const time = fakeClock(5000);
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1000 }, time.clock());
    expect(bucket.take(time.clock())).toBe('ok');
    time.set(1000);
    expect(bucket.take(time.clock())).toBe('limited');
    expect(bucket.take(time.clock())).toBe('limited');
    // The earlier high-water mark is kept, so going "back to the future" only refills real elapsed time.
    time.set(5000);
    expect(bucket.take(time.clock())).toBe('limited');
  });

  it('reports abusive only after sustained consecutive refusals, and a success resets the count', () => {
    const time = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, time.clock());
    bucket.take(time.clock());
    for (let i = 1; i < MAX_CONSECUTIVE_REFUSALS; i += 1)
      expect(bucket.take(time.clock())).toBe('limited');
    time.advance(1000);
    expect(bucket.take(time.clock())).toBe('ok');
    for (let i = 1; i < MAX_CONSECUTIVE_REFUSALS; i += 1)
      expect(bucket.take(time.clock())).toBe('limited');
    expect(bucket.take(time.clock())).toBe('abusive');
  });
});

describe('ConnectionLimiter', () => {
  it('keeps categories independent so bulk traffic cannot drain revocation', () => {
    const time = fakeClock();
    const limiter = createParticipantLimiter(time.clock);
    for (let i = 0; i < 1000; i += 1) limiter.takeCategory('signaling');
    expect(limiter.takeCategory('control')).toBe('ok');
    expect(limiter.takeCategory('clipboard')).toBe('ok');
  });

  it('keeps separate limiters isolated from each other', () => {
    const time = fakeClock();
    const a = createHelperLimiter(time.clock);
    const b = createHelperLimiter(time.clock);
    for (let i = 0; i < 100; i += 1) a.takeFrame();
    expect(a.takeFrame()).not.toBe('ok');
    expect(b.takeFrame()).toBe('ok');
  });

  it('lets a full ICE gathering and 240 events per second of input through', () => {
    const time = fakeClock();
    const limiter = createParticipantLimiter(time.clock);
    for (let i = 0; i < 60; i += 1) expect(limiter.takeCategory('signaling')).toBe('ok');
    for (let second = 0; second < 5; second += 1) {
      for (let i = 0; i < 240; i += 1) {
        expect(limiter.takeFrame()).toBe('ok');
        expect(limiter.takeCategory('input')).toBe('ok');
        time.advance(1000 / 240);
      }
    }
  });

  it('creates category buckets lazily with the configured size', () => {
    const time = fakeClock();
    const limiter = new ConnectionLimiter(
      { capacity: 1, refillPerSecond: 1 },
      { only: { capacity: 2, refillPerSecond: 1 } },
      time.clock,
    );
    expect(limiter.takeCategory('only')).toBe('ok');
    expect(limiter.takeCategory('only')).toBe('ok');
    expect(limiter.takeCategory('only')).toBe('limited');
  });
});
