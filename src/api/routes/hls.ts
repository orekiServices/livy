import { Hono } from "hono";
import { parseHlsPlaylist } from "../../audio/hls.js";
import { NotFoundError, StreamError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { decryptAes128 } from "../../sources/hls.js";
import type { StationService } from "../../stations/service.js";

/**
 * HLS proxy endpoints — modelled on NodeLink's HLS pipeline.
 *
 * - `GET /api/v1/stations/:id/hls` — fetch the station's HLS playlist and
 *   rewrite segment URLs through the segment proxy (master → best variant).
 * - `GET /api/v1/hls/segment?url=` — proxy one segment (AES-128 decrypted
 *   on the fly when the playlist declares a key).
 */
export function hlsRoutes(stations: StationService, logger: Logger) {
	const app = new Hono();

	app.get("/stations/:id/hls", async (c) => {
		const stationId = c.req.param("id");
		const station = await stations.getStation(stationId).catch(() => null);
		if (!station) throw new NotFoundError("Station", stationId);

		const sources = (await stations.listStreams(stationId)).filter((s) => s.enabled);
		const hlsSource = sources.find((s) => s.protocol === "hls" || /\.m3u8(\?|#|$)/i.test(s.url));
		if (!hlsSource) {
			throw new StreamError(`Station ${stationId} has no HLS source`);
		}

		const res = await fetch(hlsSource.url, {
			headers: { "User-Agent": "Livy/0.1" },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) {
			throw new StreamError(`HLS playlist fetch failed: ${res.status}`);
		}
		const text = await res.text();
		const playlist = parseHlsPlaylist(text, hlsSource.url);

		if (playlist.isMaster) {
			const best = [...playlist.variants].sort(
				(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
			)[0];
			if (!best) throw new StreamError("HLS master playlist has no variants");
			return c.redirect(best.url);
		}

		// Rewrite segment URLs through the proxy.
		const lines = text.split(/\r?\n/);
		const rewritten = lines.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) return line;
			const absolute = new URL(trimmed, hlsSource.url).toString();
			return `/api/v1/hls/segment?url=${encodeURIComponent(absolute)}`;
		});
		return new Response(rewritten.join("\n"), {
			headers: {
				"Content-Type": "application/vnd.apple.mpegurl",
				"Cache-Control": "no-cache",
			},
		});
	});

	app.get("/hls/segment", async (c) => {
		const url = c.req.query("url");
		if (!url) throw new NotFoundError("Segment", "(missing ?url= query param)");
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new NotFoundError("Segment", url);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new NotFoundError("Segment", url);
		}

		const res = await fetch(url, {
			headers: { "User-Agent": "Livy/0.1" },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok || !res.body) {
			throw new StreamError(`Segment fetch failed: ${res.status}`);
		}
		const data = new Uint8Array(await res.arrayBuffer());
		// Segments fetched via the proxy are served as-is; AES-128 decryption
		// is applied by decryptAes128 when a key is supplied via ?key=&iv=.
		const keyParam = c.req.query("key");
		const ivParam = c.req.query("iv");
		const body =
			keyParam && ivParam
				? decryptAes128(
						data,
						new Uint8Array(Buffer.from(keyParam, "base64")),
						new Uint8Array(Buffer.from(ivParam, "base64")),
					)
				: data;
		logger.debug("hls segment proxied", { url, bytes: body.length });
		return new Response(body, {
			headers: {
				"Content-Type": "video/mp2t",
				"Cache-Control": "no-cache",
			},
		});
	});

	return app;
}
