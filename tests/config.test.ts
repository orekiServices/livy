import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbType).toBe('memory');
    expect(config.lavalinkEnabled).toBe(true);
  });

  it('parses environment overrides', () => {
    const config = loadConfig({ PORT: '8080', DB_TYPE: 'sqlite', DB_URL: ':memory:', LAVALINK_ENABLED: 'false' });
    expect(config.port).toBe(8080);
    expect(config.dbType).toBe('sqlite');
    expect(config.dbUrl).toBe(':memory:');
    expect(config.lavalinkEnabled).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow();
    expect(() => loadConfig({ DB_TYPE: 'oracle' })).toThrow();
  });
});
