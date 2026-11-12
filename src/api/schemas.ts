import { z } from "zod";

export const CreateStationSchema = z.object({
	name: z.string().min(1).max(120),
	slug: z.string().min(1).max(64).optional(),
	description: z.string().max(2000).optional(),
	streamUrl: z.string().url().optional(),
	fallbackUrls: z.array(z.string().url()).max(20).optional(),
	coverUrl: z.string().url().optional(),
	tags: z.array(z.string().max(40)).max(20).optional(),
	isPublic: z.boolean().optional(),
});

export const UpdateStationSchema = CreateStationSchema.partial();

export const CreateStreamSourceSchema = z.object({
	name: z.string().min(1).max(120),
	url: z.string().url(),
	protocol: z.enum(["http", "https", "hls", "icecast", "shoutcast"]).optional(),
	codec: z.enum(["mp3", "aac", "flac", "opus", "vorbis", "unknown"]).optional(),
	priority: z.number().int().min(0).max(10000).optional(),
	enabled: z.boolean().optional(),
});

export const UpdateStreamSourceSchema = CreateStreamSourceSchema.partial();

export const PlaylistEntrySchema = z.object({
	url: z.string().url(),
	title: z.string().max(500).optional(),
	duration: z.number().positive().optional(),
});

export const CreatePlaylistSchema = z.object({
	name: z.string().min(1).max(120),
	entries: z.array(PlaylistEntrySchema).max(5000).optional(),
});

export const PaginationQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(50),
	search: z.string().max(200).optional(),
});

export const ImportStationSchema = z.object({
	version: z.literal(1),
	station: z.object({
		name: z.string().min(1),
		slug: z.string().min(1),
		description: z.string().nullable().optional(),
		streamUrl: z.string().nullable().optional(),
		fallbackUrls: z.array(z.string()).default([]),
		coverUrl: z.string().nullable().optional(),
		tags: z.array(z.string()).default([]),
		isPublic: z.boolean().default(true),
	}),
	streams: z
		.array(
			z.object({
				name: z.string(),
				url: z.string(),
				protocol: z.enum(["http", "https", "hls", "icecast", "shoutcast"]).default("http"),
				codec: z.enum(["mp3", "aac", "flac", "opus", "vorbis", "unknown"]).default("unknown"),
				priority: z.number().default(100),
				enabled: z.boolean().default(true),
			}),
		)
		.default([]),
	playlists: z
		.array(
			z.object({
				name: z.string(),
				entries: z.array(PlaylistEntrySchema).default([]),
			}),
		)
		.default([]),
});
