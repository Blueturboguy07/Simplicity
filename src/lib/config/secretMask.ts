/* How a stored secret (an API key) is shown outside the server process.
 *
 * GET /api/config and the provider routes never return a key in clear text.
 * A set key comes back as MASK_PREFIX plus its last four characters (only
 * when the key is long enough that four characters reveal little), so
 * Settings can say "set, ends in …abcd". Sending the mask — or an empty
 * field — back on save keeps the stored key (see secrets.ts).
 *
 * No imports: this file is shared by the server routes and the Settings UI.
 */
export const MASK_PREFIX = '••••••••';

const TAIL_MIN_LENGTH = 12;

export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  const tail = value.length >= TAIL_MIN_LENGTH ? value.slice(-4) : '';
  return MASK_PREFIX + tail;
}

export const isMaskedSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(MASK_PREFIX);

/* The visible tail of a masked value ("abcd"), or '' when none is shown. */
export const maskedTail = (value: string) =>
  isMaskedSecret(value) ? value.slice(MASK_PREFIX.length) : '';
