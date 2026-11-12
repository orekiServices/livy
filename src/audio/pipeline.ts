import type { Logger } from "../logger.js";
import { getNativeModule } from "./native.js";

/**
 * Audio pipeline — stream piping, buffering and format handling.
 *
 * Design: upstream audio bytes are piped to listeners with minimal copying.
 * When the Rust native module is present it handles ICY metadata stripping
 * and codec probing; otherwise the TypeScript fallback does the same work.
 */

export interface PipeStats {
	bytesIn: number;
	bytesOut: number;
	metadataFrames: number;
}

/**
 * Strip ICY metadata from a chunk stream, forwarding only audio bytes.
 * Returns a ReadableStream of clean audio plus a callback for metadata.
 */
export function stripIcyMetadata(
	source: ReadableStream<Uint8Array>,
	metaint: number,
	onMetadata: (title: string) => void,
): ReadableStream<Uint8Array> {
	if (metaint <= 0) return source;

	let buffer = new Uint8Array(0);
	let bytesUntilMetadata = metaint;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const reader = source.getReader();
			try {
				const { done, value } = await reader.read();
				if (done) {
					if (buffer.length > 0) controller.enqueue(buffer);
					controller.close();
					return;
				}
				if (!value) return;

				// Append to buffer
				const merged = new Uint8Array(buffer.length + value.length);
				merged.set(buffer);
				merged.set(value, buffer.length);
				buffer = merged;

				const out: Uint8Array[] = [];
				let offset = 0;

				while (offset < buffer.length) {
					if (bytesUntilMetadata > 0) {
						const take = Math.min(bytesUntilMetadata, buffer.length - offset);
						out.push(buffer.slice(offset, offset + take));
						offset += take;
						bytesUntilMetadata -= take;
					} else {
						// Next byte is the metadata length (×16)
						const lenByte = buffer[offset] ?? 0;
						offset += 1;
						const metaLen = lenByte * 16;
						if (metaLen > 0) {
							const metaBytes = buffer.slice(offset, offset + metaLen);
							offset += metaLen;
							const title = parseIcyMetadata(metaBytes);
							if (title) onMetadata(title);
						}
						bytesUntilMetadata = metaint;
					}
				}

				buffer = buffer.slice(offset);
				for (const chunk of out) {
					if (chunk.length > 0) controller.enqueue(chunk);
				}
			} catch (err) {
				controller.error(err);
			} finally {
				reader.releaseLock();
			}
		},
		cancel() {
			// Best effort: nothing to clean up beyond the source stream.
		},
	});
}

/** Parse a raw ICY metadata block (e.g. `StreamTitle='…';`) into a title. */
export function parseIcyMetadata(block: Uint8Array): string | null {
	const text = new TextDecoder("latin1").decode(block);
	const match = /StreamTitle='([^']*)'/.exec(text);
	return match?.[1] ? match[1] : null;
}

/**
 * Probe audio info for a buffer — prefers the native module when available.
 */
export function probeAudio(
	data: Uint8Array,
	logger: Logger,
): { codec: string; sampleRate: number; channels: number; durationMs: number } | null {
	const native = getNativeModule();
	if (native?.probeAudio) {
		try {
			return native.probeAudio(data);
		} catch (err) {
			logger.debug("native probeAudio failed, falling back", { error: String(err) });
		}
	}
	return null;
}
