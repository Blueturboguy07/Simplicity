import fs from 'node:fs';
import configManager from '@/lib/config';
import { ConfigModelProvider } from '@/lib/config/types';
import { hashObj } from '@/lib/utils/hash';
import { publikBalance } from './balance';
import {
  DISCLOSURE_VERSION,
  PUBLIK_BASE_URL_DEFAULT,
  PUBLIK_MODEL_DEFAULTS,
  PublikState,
  PublikTier,
} from './types';

/* The publik connection of the desktop app (publikhq.com/skills/setup.md).
 *
 * The desktop shell runs the publik module (desktop/publik.mjs) before the
 * window opens: Sign in with publik, then Get a plan / Connect your plan /
 * Use my own key. The module mints this computer's install key (POST
 * /installs) and keeps it in its credential file, with the person's choice.
 * This server never mints. It reads that file, hands the key to the app's
 * credential store (config.json modelProviders[]) when the person connected
 * their plan, and records a decline back into the file so the next start
 * honours it.
 *
 * Rules, each pinned by provision.test.ts:
 *   - No request is ever made here: no fetch, no mint.
 *   - A user-entered key always wins; an existing publik connection follows
 *     the module's key; a declined install stays declined. Never overwrite.
 *   - The key lands in modelProviders[] through configManager
 *     .addModelProvider(); the `config.publik` block holds state only.
 *   - Without PUBLIK_CREDENTIAL_FILE (dev, Docker, source builds) every
 *     path here is a no-op: the app behaves as before, with the user's own
 *     providers.
 */

export type ProvisionDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type ProvisionResult =
  | 'active'
  | 'no-token'
  | 'declined'
  | 'disconnected'
  | 'consent-required'
  | 'failed';

export const PUBLIK_PROVIDER_TYPE = 'publik';
export const PUBLIK_PROVIDER_NAME = 'publik API';

export type InstallChoice = 'publik' | 'own_key';

/* The module's credential file: desktop/publik.mjs writes it (mode 0600),
   the shell passes its path as PUBLIK_CREDENTIAL_FILE. */
export type InstallCredential = {
  key: string;
  base_url: string;
  install_id: string;
  claim_url: string | null;
  choice: InstallChoice | null;
};

export const credentialFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.PUBLIK_CREDENTIAL_FILE || '';

export function readInstallCredential(
  env: NodeJS.ProcessEnv = process.env,
): InstallCredential | null {
  const file = credentialFile(env);
  if (!file) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof c?.key !== 'string' || !c.key.startsWith('pk_')) return null;
    return {
      key: c.key,
      base_url:
        typeof c.base_url === 'string' && /^https?:\/\//.test(c.base_url)
          ? c.base_url.replace(/\/$/, '')
          : PUBLIK_BASE_URL_DEFAULT,
      install_id: typeof c.install_id === 'string' ? c.install_id : '',
      claim_url: typeof c.claim_url === 'string' ? c.claim_url : null,
      choice: c.choice === 'publik' || c.choice === 'own_key' ? c.choice : null,
    };
  } catch {
    return null;
  }
}

/* The person's answer, in the module's file, so the next start of the app
   honours it (the module's own setChoice()). Every other field stays. */
export function writeChoice(
  choice: InstallChoice | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = credentialFile(env);
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.key !== 'string') return;
    fs.writeFileSync(file, JSON.stringify({ ...raw, choice }, null, 2), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows */
    }
  } catch {
    /* no credential on this computer: nothing to record */
  }
}

export const hasInstallCredential = (
  env: NodeJS.ProcessEnv = process.env,
) => readInstallCredential(env) !== null;

const publikProviders = (): ConfigModelProvider[] =>
  (configManager.getConfig('modelProviders', []) as ConfigModelProvider[]).filter(
    (p) => p.type === PUBLIK_PROVIDER_TYPE,
  );

export const publikProvider = (): ConfigModelProvider | undefined =>
  publikProviders()[0];

export const readState = (): PublikState | undefined =>
  configManager.getConfig('publik', undefined);

const writeState = (patch: Partial<PublikState>) => {
  const next = { ...(readState() ?? {}), ...patch } as PublikState;
  /* `undefined` is how a caller clears a field — strip so config.json never
     carries a literal null where the type says string. */
  for (const k of Object.keys(next) as (keyof PublikState)[]) {
    if (next[k] === undefined) delete next[k];
  }
  configManager.updateConfig('publik', next);
};

export const disclosureAccepted = (state = readState()) =>
  (state?.disclosureVersion ?? 0) >= DISCLOSURE_VERSION;

/* The alias list the provider serves: names an older install stored first,
   the compiled defaults for anything else. */
export const publikModels = (): Record<PublikTier, string> => ({
  ...PUBLIK_MODEL_DEFAULTS,
  ...(readState()?.models ?? {}),
});

const removePublikProviders = () => {
  for (const p of publikProviders()) configManager.removeModelProvider(p.id);
};

/* The stored connection follows the module's key: a key the module minted
   again (after a revoke) replaces the old one, and a second publik entry
   (the config manager creates one from PUBLIK_API_KEY when the key changed)
   is folded into the first. A user-entered provider is never touched. */
const syncProviders = (credential: InstallCredential) => {
  const all = configManager.getConfig(
    'modelProviders',
    [],
  ) as ConfigModelProvider[];
  const mine = all.filter((p) => p.type === PUBLIK_PROVIDER_TYPE);
  if (mine.length === 0) return;
  const [keep, ...extra] = mine;
  const config = { apiKey: credential.key, baseURL: credential.base_url };
  const stale =
    keep.config?.apiKey !== config.apiKey ||
    keep.config?.baseURL !== config.baseURL;
  if (!stale && extra.length === 0) return;
  const next = all
    .filter((p) => !extra.includes(p))
    .map((p) => (p === keep ? { ...p, config, hash: hashObj(config) } : p));
  configManager.updateConfig('modelProviders', next);
};

/* Idempotent. Safe to call on every status read and from the accept/retry
   routes. Returns the reason it did nothing so the caller (and the tests)
   can tell the cases apart. */
export async function ensureProvisioned(
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const env = deps.env ?? process.env;
  const credential = readInstallCredential(env);
  const state = readState();

  /* 1. Never overwrite. An existing connection follows the module's key. */
  if (publikProvider()) {
    if (credential) {
      syncProviders(credential);
      if (state?.state !== 'active' || state.lastError) {
        writeState({
          state: 'active',
          installId: credential.install_id || state?.installId,
          claimUrl: credential.claim_url ?? state?.claimUrl,
          lastError: undefined,
          retryAfter: undefined,
        });
      }
    }
    return 'active';
  }
  if (state?.state === 'declined') return 'declined';
  if (state?.state === 'disconnected') return 'disconnected';
  if (!credential) return 'no-token';
  /* 2. Consent precedes the connection. */
  if (!disclosureAccepted(state)) return 'consent-required';

  /* 3. The existing credential store, through the existing API. */
  configManager.addModelProvider(PUBLIK_PROVIDER_TYPE, PUBLIK_PROVIDER_NAME, {
    apiKey: credential.key,
    baseURL: credential.base_url,
  });
  writeState({
    state: 'active',
    installId: credential.install_id || state?.installId || crypto.randomUUID(),
    claimUrl: credential.claim_url ?? undefined,
    mintedAt: (deps.now ?? (() => new Date()))().toISOString(),
    lastError: undefined,
    retryAfter: undefined,
  });
  publikBalance.reset();
  writeChoice('publik', env);
  return 'active';
}

/* The disclosure's "Continue" button. Recording acceptance is what unlocks
   the connection; the two happen together so the wizard sees `active` on
   return. */
export async function acceptDisclosure(deps: ProvisionDeps = {}) {
  writeState({ disclosureVersion: DISCLOSURE_VERSION });
  return ensureProvisioned(deps);
}

/* The first-run card's "Later" (and its plan button): records that the
   balance line, the justification and the CTA were shown (CONTRACT §12.4,
   "never a silent starter"). Touches nothing else — the key stays, the
   balance stays, and the button stays in Settings. */
export function acknowledgeCta(deps: ProvisionDeps = {}) {
  if (!readState()) return;
  writeState({ ctaSeenAt: (deps.now ?? (() => new Date()))().toISOString() });
}

/* "Use my own key instead" — from the wizard, from Settings' delete, or
   from a 402 card. Removes the connection, pins the choice here and in the
   module's file, so the gate does not ask again at the next start. */
export function declinePublik(deps: ProvisionDeps = {}) {
  removePublikProviders();
  publikBalance.reset();
  writeState({ state: 'declined', lastError: undefined });
  writeChoice('own_key', deps.env ?? process.env);
}

/* "Reconnect" after a decline or a disconnect: back to pending, then the
   disclosure shows again before the connection is made. The install
   identity is the module's; the choice in the file is left as it is until
   the person continues. */
export function resetPublik(deps: ProvisionDeps = {}) {
  removePublikProviders();
  publikBalance.reset();
  const credential = readInstallCredential(deps.env ?? process.env);
  /* No disclosureVersion: acceptance is per connection, so the sheet shows
     again before anything is connected. */
  configManager.updateConfig('publik', {
    installId: credential?.install_id || crypto.randomUUID(),
    state: 'pending',
  } satisfies PublikState);
}

/* Retry from the wizard: same consent, the file is read again. */
export async function retryPublik(deps: ProvisionDeps = {}) {
  const state = readState();
  if (state?.state === 'pending')
    writeState({ lastError: undefined, retryAfter: undefined });
  return ensureProvisioned(deps);
}

/* `401 key_revoked` from the gateway: the key in the file is dead. Only the
   module can mint a new one, and it does so at the next start of the app
   (its gate sees the 401 and provisions again). Drop the dead key, say so,
   and stop; the next start reconnects. */
export async function handleKeyRevoked(
  _reprovision: boolean,
  _deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  removePublikProviders();
  publikBalance.reset();
  writeState({
    state: 'disconnected',
    lastError:
      "This computer's publik key was revoked. Restart Simplicity to connect again.",
  });
  return 'disconnected';
}
