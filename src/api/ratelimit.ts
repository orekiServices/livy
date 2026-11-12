import type { Context, Next } from "hono";
import { LivyError } from "../errors.js";

/**
 * Token-bucket rate limiter — modelled on NodeLink's rateLimitManager.
 * In-memory per-IP buckets; suitable for single-instance deployments.
 * For multi-instance, move bucket state to Redis/Postgres.
 */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; updatedAt: number }>();

	constructor(
		private readonly maxRequests: number,
		private readonly windowMs: number,
	) {}

	/** Returns true when the request is allowed. */
	allow(key: string): boolean {
		const now = Date.now();
		const bucket = this.buckets.get(key) ?? { tokens: this.maxRequests, updatedAt: now };
		// Refill proportionally to elapsed time.
		const elapsed = now - bucket.updatedAt;
		bucket.tokens = Math.min(
			this.maxRequests,
			bucket.tokens + (elapsed / this.windowMs) * this.maxRequests,
		);
		bucket.updatedAt = now;
		if (bucket.tokens < 1) {
			this.buckets.set(key, bucket);
			return false;
		}
		bucket.tokens -= 1;
		this.buckets.set(key, bucket);
		return true;
	}

	/** Evict stale buckets (call periodically). */
	sweep(): void {
		const now = Date.now();
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.updatedAt > this.windowMs * 2) this.buckets.delete(key);
		}
	}
}

export function rateLimitMiddleware(limiter: RateLimiter) {
	return async (c: Context, next: Next) => {
		const ip =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
			c.req.header("x-real-ip") ??
			"unknown";
		if (!limiter.allow(ip)) {
			throw new LivyError(429, "RATE_LIMITED", "Too many requests — slow down");
		}
		return next();
	};
}
