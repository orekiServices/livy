import type { Context, Next } from "hono";
import { UnauthorizedError } from "../errors.js";
import type { Logger } from "../logger.js";

/** Request logging middleware (structured, one line per request). */
export function requestLogger(logger: Logger) {
	return async (c: Context, next: Next) => {
		const start = performance.now();
		await next();
		const ms = Math.round(performance.now() - start);
		logger.debug("http", {
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			ms,
		});
	};
}

/** Bearer-token auth middleware. Skips when no API key is configured. */
export function requireAuth(apiKey: string | null) {
	return async (c: Context, next: Next) => {
		if (!apiKey) return next();
		const header = c.req.header("Authorization") ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (token !== apiKey) {
			throw new UnauthorizedError("Missing or invalid API key");
		}
		return next();
	};
}

/** CORS middleware — permissive by default, configurable origins. */
export function cors(origins: string[]) {
	return async (c: Context, next: Next) => {
		const origin = c.req.header("Origin");
		const allowed =
			origins.includes("*") || (origin !== undefined && origins.includes(origin))
				? (origin ?? "*")
				: (origins[0] ?? "*");
		c.header("Access-Control-Allow-Origin", allowed);
		c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
		c.header("Access-Control-Max-Age", "86400");
		if (c.req.method === "OPTIONS") {
			return c.body(null, 204);
		}
		return next();
	};
}
