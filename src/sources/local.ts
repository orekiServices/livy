import { readFile } from "node:fs/promises";
import type { Logger } from "../logger.js";
import { makeTrackInfo, toTrackData } from "./track.js";
import type {
	SourceContext,
	SourceInstance,
	SourceResult,
	TrackInfo,
	TrackStreamResult,
	TrackUrlResult,
} from "./types.js";

/**
 * Local source — files on disk (`file://` URLs and absolute paths).
 * Modelled on NodeLink's `local` source; useful for self-hosted libraries.
 */
export class LocalSource implements SourceInstance {
	readonly name = "local";
	readonly searchTerms = ["local:"];
	readonly priority = 40;

	constructor(
		private readonly ctx: SourceContext,
		private readonly logger: Logger,
	) {}

	canHandle(identifier: string): boolean {
		return (
			identifier.startsWith("file://") ||
			identifier.startsWith("/") ||
			/^[A-Za-z]:\\/.test(identifier)
		);
	}

	async resolve(identifier: string): Promise<SourceResult> {
		const path = identifier.startsWith("file://") ? identifier.slice("file://".length) : identifier;
		try {
			const data = await readFile(path);
			if (data.length === 0) {
				return {
					loadType: "error",
					data: { tracks: [] },
					exception: { message: `Local file is empty: ${path}`, severity: "common" },
				};
			}
			const info = makeTrackInfo({
				identifier,
				uri: identifier,
				title: path.split("/").pop() ?? path,
				author: "Local",
				sourceName: "local",
				isStream: false,
				isSeekable: true,
				length: 0,
			});
			return {
				loadType: "track",
				data: { tracks: [toTrackData(info, { bytes: data.length })] },
			};
		} catch (err) {
			this.logger.debug("local resolve failed", { path, error: String(err) });
			return {
				loadType: "error",
				data: { tracks: [] },
				exception: { message: String(err), severity: "common" },
			};
		}
	}

	async search(query: string): Promise<SourceResult> {
		return this.resolve(query);
	}

	async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
		return { url: track.uri, protocol: "file" };
	}

	async loadStream(_track: TrackInfo, url: string): Promise<TrackStreamResult> {
		const path = url.startsWith("file://") ? url.slice("file://".length) : url;
		try {
			const data = await readFile(path);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(data));
					controller.close();
				},
			});
			return { stream, type: "application/octet-stream" };
		} catch (err) {
			return { exception: { message: String(err), severity: "common" } };
		}
	}
}
