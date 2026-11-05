import { providers } from '@/lib/models/providers';
import { ConfigModelProvider } from './types';
import { isMaskedSecret, maskSecret, MASK_PREFIX } from './secretMask';

/* Server side of secretMask.ts: which config fields are secrets, how a
 * provider is masked for the renderer, and how a save that left a secret
 * field empty (or sent the mask back) keeps the stored value. */

/* The provider's own schema marks secrets as `type: 'password'`. apiKey is
   always treated as one, even for an unknown provider type. */
export function secretFieldKeys(type: string): string[] {
  const keys = new Set<string>(['apiKey']);
  try {
    for (const f of providers[type]?.getProviderConfigFields() ?? []) {
      if (f.type === 'password') keys.add(f.key);
    }
  } catch {
    /* unknown provider: apiKey only */
  }
  return [...keys];
}

/* publik keys keep their public 12-char id visible (pk_live_<id>_••••); the
   secret part never leaves the server. */
const PUBLIK_KEY_RE = /^(pk_(?:live|test)_[a-z0-9]{12})_[a-z0-9]+$/;

const maskOne = (type: string, value: unknown) => {
  if (
    type === 'publik' &&
    typeof value === 'string' &&
    PUBLIK_KEY_RE.test(value)
  ) {
    return value.replace(PUBLIK_KEY_RE, `$1_${MASK_PREFIX}`);
  }
  return maskSecret(value);
};

export function maskProviderConfig<T extends Pick<ConfigModelProvider, 'type' | 'config'>>(
  provider: T,
): T {
  const config = provider.config;
  if (!config || typeof config !== 'object') return provider;
  const masked: Record<string, any> = { ...config };
  for (const key of secretFieldKeys(provider.type)) {
    if (key in masked) masked[key] = maskOne(provider.type, masked[key]);
  }
  return { ...provider, config: masked };
}

/* A save from Settings: a secret field left empty, missing, or still holding
   the mask means "keep the key I already have". */
export function mergeSecretConfig(
  type: string,
  existing: Record<string, any> | undefined,
  incoming: Record<string, any>,
): Record<string, any> {
  const merged: Record<string, any> = { ...incoming };
  for (const key of secretFieldKeys(type)) {
    const v = incoming[key];
    const keep =
      v === undefined ||
      v === null ||
      (typeof v === 'string' && (v.trim() === '' || isMaskedSecret(v))) ||
      (type === 'publik' && typeof v === 'string' && v.endsWith(MASK_PREFIX));
    if (keep && existing && existing[key] !== undefined) {
      merged[key] = existing[key];
    }
  }
  return merged;
}
