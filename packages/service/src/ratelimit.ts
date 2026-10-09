/**
 * Per-user token buckets (design section 5, "Rate limits"). In memory and
 * per instance: the global bound is limit x max_instances. Good enough to
 * stop a runaway client in v1.
 */
import type { RateLimitClass } from './config.js';

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Take `cost` tokens from the bucket for `key`. Returns 0 when allowed, or
   * the number of seconds to wait (Retry-After) when not.
   */
  take(key: string, cls: RateLimitClass, cost = 1): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: cls.burst, at: t };
    b.tokens = Math.min(cls.burst, b.tokens + ((t - b.at) / 1000) * cls.ratePerSec);
    b.at = t;
    if (cost > cls.burst) cost = cls.burst; // an oversized batch drains the bucket instead of never fitting
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((cost - b.tokens) / cls.ratePerSec));
  }

  /** Drop buckets that have been full for a while (bounded memory). */
  sweep(maxIdleMs = 10 * 60_000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > maxIdleMs) this.buckets.delete(k);
  }
}

/** Per-user daily write counter that raises an alert line instead of blocking. */
export class DailyCounter {
  private counts = new Map<string, { day: string; n: number; alerted: boolean }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Add `n`; returns true exactly once per user per UTC day when `limit` is crossed. */
  add(user: string, n: number, limit: number): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let c = this.counts.get(user);
    if (!c || c.day !== day) c = { day, n: 0, alerted: false };
    c.n += n;
    this.counts.set(user, c);
    if (c.n > limit && !c.alerted) {
      c.alerted = true;
      return true;
    }
    return false;
  }
}
