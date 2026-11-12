import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/api/ratelimit.js";
import { Metrics } from "../src/metrics.js";

describe("Metrics", () => {
	test("renders counters and gauges in Prometheus format", () => {
		const m = new Metrics();
		m.inc("livy_http_requests_total", 3);
		m.setGauge("livy_uptime_seconds", 42);
		const out = m.render();
		expect(out).toContain("livy_http_requests_total 3");
		expect(out).toContain("livy_uptime_seconds 42");
	});
});

describe("RateLimiter", () => {
	test("allows up to max then blocks", () => {
		const limiter = new RateLimiter(3, 60_000);
		expect(limiter.allow("1.2.3.4")).toBe(true);
		expect(limiter.allow("1.2.3.4")).toBe(true);
		expect(limiter.allow("1.2.3.4")).toBe(true);
		expect(limiter.allow("1.2.3.4")).toBe(false);
	});

	test("tracks IPs independently", () => {
		const limiter = new RateLimiter(1, 60_000);
		expect(limiter.allow("1.1.1.1")).toBe(true);
		expect(limiter.allow("2.2.2.2")).toBe(true);
		expect(limiter.allow("1.1.1.1")).toBe(false);
	});
});
