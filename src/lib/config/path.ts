/* Dotted config paths ("preferences.theme", "modelProviders.0.config.baseURL")
 * are walked segment by segment over a plain object. A segment named
 * __proto__, constructor or prototype walks off the config and onto
 * Object.prototype — writing there pollutes every object in the server
 * process. No real config key uses these names, so they are refused outright.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeConfigPath(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0) return false;
  return key
    .split('.')
    .every((part) => part.length > 0 && !FORBIDDEN_SEGMENTS.has(part));
}
