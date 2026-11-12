/** Tiny prefixed logger — keeps bot output readable in console / Docker logs. */
const PREFIXES = {
  info: '[Livy]',
  warn: '[Livy:warn]',
  error: '[Livy:error]',
  debug: '[Livy:debug]',
};

export function log(...args) {
  console.log(PREFIXES.info, ...args);
}

export function warn(...args) {
  console.warn(PREFIXES.warn, ...args);
}

export function error(...args) {
  console.error(PREFIXES.error, ...args);
}

export function debug(...args) {
  if (process.env.LOG_LEVEL === 'debug') console.log(PREFIXES.debug, ...args);
}
