import { randomUUID } from 'node:crypto';

/** Generate a unique id for domain entities. */
export function newId(): string {
  return randomUUID();
}

/** Slugify a station name into a URL-safe identifier. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'station';
}
