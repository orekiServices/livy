/**
 * Builds the identifier passed to NodeLink's /v4/loadtracks.
 *
 * Rules:
 *  - URLs are passed through untouched (NodeLink resolves them directly).
 *  - Queries that already carry a known NodeLink search prefix
 *    (ytsearch:, scsearch:, spsearch:, …) are passed through untouched.
 *  - Everything else gets the configured default source prefix.
 */
import { config } from '../config.js';

export const SEARCH_PREFIXES = [
  'ytsearch:', 'ytmsearch:', 'scsearch:', 'search:', 'spsearch:', 'amsearch:',
  'dzsearch:', 'tdsearch:', 'bcsearch:', 'admsearch:', 'audiomack:',
  'gaanasearch:', 'jssearch:', 'lfsearch:', 'pdsearch:', 'vksearch:',
  'mcsearch:', 'ncsearch:', 'nicovideo:', 'bilibili:', 'shsearch:', 'szsearch:',
  'ebox:', 'jukebox:', 'slsearch:', 'qbsearch:', 'ymsearch:', 'ausearch:',
  'azsearch:', 'agsearch:', 'bksearch:', 'lmsearch:', 'pipertts:', 'gtts:',
  'speak:', 'ftts:', 'flowery:', 'gdsearch:',
  'ytrec:', 'sprec:', 'dzrec:', 'tdrec:', 'jsrec:', 'vkrec:',
];

export function isUrl(text) {
  return /^https?:\/\//i.test(String(text ?? '').trim());
}

export function hasSearchPrefix(text) {
  const lower = String(text ?? '').trim().toLowerCase();
  return SEARCH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function buildIdentifier(query, defaultSource = config.defaultSearchSource) {
  const text = String(query ?? '').trim();
  if (!text) return '';
  if (isUrl(text) || hasSearchPrefix(text)) return text;
  const source = defaultSource.endsWith(':') ? defaultSource : `${defaultSource}:`;
  return `${source}${text}`;
}
