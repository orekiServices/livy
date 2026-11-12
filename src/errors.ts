/** Typed application errors mapped to HTTP responses by the error middleware. */

export class LivyError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;

	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = "LivyError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

export class NotFoundError extends LivyError {
	constructor(resource: string, id: string) {
		super(404, "NOT_FOUND", `${resource} not found: ${id}`);
	}
}

export class ValidationError extends LivyError {
	constructor(message: string, details?: unknown) {
		super(400, "VALIDATION_ERROR", message, details);
	}
}

export class ConflictError extends LivyError {
	constructor(message: string) {
		super(409, "CONFLICT", message);
	}
}

export class UnauthorizedError extends LivyError {
	constructor(message = "Unauthorized") {
		super(401, "UNAUTHORIZED", message);
	}
}

export class StreamError extends LivyError {
	constructor(message: string, details?: unknown) {
		super(502, "STREAM_ERROR", message, details);
	}
}

export class CapacityError extends LivyError {
	constructor(message: string) {
		super(429, "CAPACITY_EXCEEDED", message);
	}
}
