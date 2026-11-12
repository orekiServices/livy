import type { DatabaseAdapter } from './adapter.js';
import { JsonAdapter } from './json.js';
import { MemoryAdapter } from './memory.js';
import { SqliteAdapter } from './sqlite.js';
import type { AppConfig } from '../types/index.js';

export type { DatabaseAdapter } from './adapter.js';
export { MemoryAdapter } from './memory.js';
export { JsonAdapter } from './json.js';
export { SqliteAdapter } from './sqlite.js';

/**
 * Adapter factory. Postgres/MySQL drivers are loaded lazily via dynamic
 * import so they stay optional dependencies — the core server runs
 * without them.
 */
export async function createAdapter(config: AppConfig): Promise<DatabaseAdapter> {
  switch (config.dbType) {
    case 'memory':
      return new MemoryAdapter();
    case 'json':
      return new JsonAdapter(config.dbUrl);
    case 'sqlite':
      return new SqliteAdapter(config.dbUrl);
    case 'postgres': {
      const { PostgresAdapter } = await import('./postgres.js');
      return new PostgresAdapter(config.dbUrl, config.dbPoolSize);
    }
    case 'mysql': {
      const { MysqlAdapter } = await import('./mysql.js');
      return new MysqlAdapter(config.dbUrl, config.dbPoolSize);
    }
    default:
      throw new Error(`Unsupported DB_TYPE: ${config.dbType}`);
  }
}
