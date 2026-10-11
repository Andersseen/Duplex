/**
 * Per-connection message rate limiting for the signaling Durable Object.
 *
 * State lives only in the Durable Object's memory and is keyed by the WebSocket itself, so it is
 * never persisted, never shared between connections, never tied to an IP address or user, and is
 * released with the socket. Hibernation resets a bucket to full, which is safe: a socket that was
 * evicted was idle.
 */

/** Monotonic milliseconds. Injectable so tests control time instead of sleeping. */
export type Clock = () => number;

export interface BucketConfig {
  /** Largest burst a connection may send before it is throttled. */
  readonly capacity: number;
  /** Sustained messages per second once the burst is spent. */
  readonly refillPerSecond: number;
}

export type TakeResult = 'ok' | 'limited' | 'abusive';

/** Consecutive refused messages after which a connection is considered to be flooding. */
export const MAX_CONSECUTIVE_REFUSALS = 25;

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private refusals = 0;

  constructor(
    private readonly config: BucketConfig,
    now: number,
  ) {
    this.tokens = config.capacity;
    this.updatedAt = now;
  }

  /** Spends one token. `limited` drops the message; `abusive` means the connection should be closed. */
  take(now: number): TakeResult {
    // A clock that stalls or steps backwards must never mint tokens.
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.updatedAt = Math.max(this.updatedAt, now);
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsedSeconds * this.config.refillPerSecond,
    );
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.refusals = 0;
      return 'ok';
    }
    this.refusals += 1;
    return this.refusals >= MAX_CONSECUTIVE_REFUSALS ? 'abusive' : 'limited';
  }
}

export type ParticipantCategory = 'signaling' | 'input' | 'clipboard' | 'control';
export type HelperCategory = 'status' | 'clipboard' | 'control';

/**
 * Every frame, valid or not, first spends from the frame bucket so malformed, binary and unknown
 * traffic cannot dodge the limit. The per-category buckets then keep a flood of one kind (ICE
 * candidates, pointer input) from starving another, notably revocation and Stop, which have their
 * own bucket that nothing else drains.
 */
const PARTICIPANT_FRAME: BucketConfig = { capacity: 500, refillPerSecond: 400 };
const HELPER_FRAME: BucketConfig = { capacity: 100, refillPerSecond: 50 };

const PARTICIPANT_CATEGORIES: Record<ParticipantCategory, BucketConfig> = {
  // Offers, answers and a full ICE gathering (host, srflx, relay, restarts) fit in the burst.
  signaling: { capacity: 100, refillPerSecond: 30 },
  // The browser caps pointer input at 240 events per second; leave headroom for jitter.
  input: { capacity: 480, refillPerSecond: 300 },
  // Clipboard actions are manual button presses.
  clipboard: { capacity: 10, refillPerSecond: 2 },
  // leave, authorize and revoke: rare, and never sharing a bucket with bulk traffic.
  control: { capacity: 20, refillPerSecond: 5 },
};
const HELPER_CATEGORIES: Record<HelperCategory, BucketConfig> = {
  status: { capacity: 20, refillPerSecond: 5 },
  clipboard: { capacity: 10, refillPerSecond: 2 },
  control: { capacity: 20, refillPerSecond: 5 },
};

export class ConnectionLimiter<Category extends string> {
  private readonly frame: TokenBucket;
  private readonly buckets = new Map<Category, TokenBucket>();

  constructor(
    frame: BucketConfig,
    private readonly categories: Record<Category, BucketConfig>,
    private readonly clock: Clock,
  ) {
    this.frame = new TokenBucket(frame, clock());
  }

  /** Charged before any parsing. Anything but `ok` is flooding well beyond every category limit. */
  takeFrame(): TakeResult {
    return this.frame.take(this.clock());
  }

  takeCategory(category: Category): TakeResult {
    const now = this.clock();
    let bucket = this.buckets.get(category);
    if (!bucket) {
      bucket = new TokenBucket(this.categories[category], now);
      this.buckets.set(category, bucket);
    }
    return bucket.take(now);
  }
}

export const createParticipantLimiter = (clock: Clock): ConnectionLimiter<ParticipantCategory> =>
  new ConnectionLimiter(PARTICIPANT_FRAME, PARTICIPANT_CATEGORIES, clock);
export const createHelperLimiter = (clock: Clock): ConnectionLimiter<HelperCategory> =>
  new ConnectionLimiter(HELPER_FRAME, HELPER_CATEGORIES, clock);

/** WebSocket close code (application range) sent when a connection floods the room. */
export const RATE_LIMIT_CLOSE_CODE = 4008;
export const RATE_LIMIT_CLOSE_REASON = 'Rate limit exceeded';
