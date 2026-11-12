/**
 * Database migration helper — initialises the configured adapter schema.
 * Run with: bun run db:migrate
 */
import { loadConfig } from "../config.js";
import { createDatabase } from "./factory.js";

const config = loadConfig();
const db = createDatabase(config);
await db.init();
const health = await db.healthCheck();
console.log(`Database (${db.type}) ready: ${health.ok} (${health.latencyMs.toFixed(2)}ms)`);
await db.close();
