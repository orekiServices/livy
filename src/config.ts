import { z } from "zod";
import type { LivyConfig } from "./types.js";

const EnvSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.coerce.number().int().min(1).max(65535).default(2333),
	NODE_ENV: z.string().default("development"),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	API_KEY: z.string().optional(),
	DATABASE_TYPE: z.enum(["memory", "sqlite", "postgres"]).default("memory"),
	DATABASE_PATH: z.string().default("./data/livy.db"),
	DATABASE_URL: z.string().optional(),
	MAX_LISTENERS_PER_STATION: z.coerce.number().int().positive().default(100),
	STREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
	USE_NATIVE_AUDIO: z
		.string()
		.default("true")
		.transform((v) => v.toLowerCase() !== "false" && v !== "0"),
	CORS_ORIGINS: z.string().default("*"),
	RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
	RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
	DEFAULT_SEARCH_SOURCE: z.string().default("http"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parse and validate environment variables into a typed LivyConfig. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LivyConfig {
	const parsed = EnvSchema.parse(env);
	return {
		host: parsed.HOST,
		port: parsed.PORT,
		nodeEnv: parsed.NODE_ENV,
		logLevel: parsed.LOG_LEVEL,
		apiKey: parsed.API_KEY && parsed.API_KEY.length > 0 ? parsed.API_KEY : null,
		databaseType: parsed.DATABASE_TYPE,
		databasePath: parsed.DATABASE_PATH,
		databaseUrl: parsed.DATABASE_URL ?? null,
		maxListenersPerStation: parsed.MAX_LISTENERS_PER_STATION,
		streamTimeoutMs: parsed.STREAM_TIMEOUT_MS,
		useNativeAudio: parsed.USE_NATIVE_AUDIO,
		corsOrigins: parsed.CORS_ORIGINS.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		rateLimitMax: parsed.RATE_LIMIT_MAX,
		rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
		defaultSearchSource: parsed.DEFAULT_SEARCH_SOURCE,
	};
}

/** Redacted view of config safe to expose via API. */
export function publicConfig(config: LivyConfig): Record<string, unknown> {
	return {
		host: config.host,
		port: config.port,
		nodeEnv: config.nodeEnv,
		databaseType: config.databaseType,
		maxListenersPerStation: config.maxListenersPerStation,
		streamTimeoutMs: config.streamTimeoutMs,
		useNativeAudio: config.useNativeAudio,
		authEnabled: config.apiKey !== null,
	};
}
