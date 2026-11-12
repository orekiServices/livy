/**
 * Minimal structured logger — JSON lines to stdout/stderr.
 * No external dependency; swap for pino/winston in production if desired.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface Logger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
	child(bindings: Record<string, unknown>): Logger;
}

function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
	const threshold = LEVEL_ORDER[level];

	const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
		if (LEVEL_ORDER[lvl] < threshold) return;
		const entry = {
			ts: new Date().toISOString(),
			level: lvl,
			msg,
			...bindings,
			...(meta ?? {}),
		};
		const line = JSON.stringify(entry);
		if (lvl === "error" || lvl === "warn") {
			console.error(line);
		} else {
			console.log(line);
		}
	};

	return {
		debug: (msg, meta) => emit("debug", msg, meta),
		info: (msg, meta) => emit("info", msg, meta),
		warn: (msg, meta) => emit("warn", msg, meta),
		error: (msg, meta) => emit("error", msg, meta),
		child: (childBindings) => createLogger(level, { ...bindings, ...childBindings }),
	};
}

export function createAppLogger(level: LogLevel): Logger {
	return createLogger(level, { service: "livy" });
}
