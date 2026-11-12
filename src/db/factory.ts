import type { LivyConfig } from "../types.js";
import type { DatabaseAdapter } from "./adapter.js";
import { MemoryAdapter } from "./memory.js";
import { PostgresAdapter } from "./postgres.js";
import { SqliteAdapter } from "./sqlite.js";

/** Create the configured database adapter. */
export function createDatabase(config: LivyConfig): DatabaseAdapter {
	switch (config.databaseType) {
		case "sqlite":
			return new SqliteAdapter(config.databasePath);
		case "postgres":
			if (!config.databaseUrl) {
				throw new Error("DATABASE_URL is required when DATABASE_TYPE=postgres");
			}
			return new PostgresAdapter(config.databaseUrl);
		default:
			return new MemoryAdapter();
	}
}
