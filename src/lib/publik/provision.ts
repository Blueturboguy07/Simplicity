import os from 'node:os';
import configManager from '@/lib/config';
import { ConfigModelProvider } from '@/lib/config/types';
import { publikBalance } from './balance';
import {
  DISCLOSURE_VERSION,
  InstallResponse,
  PUBLIK_APP_SLUG,
  PUBLIK_BASE_URL_DEFAULT,
  PUBLIK_KEY_RE,
  PUBLIK_MODEL_DEFAULTS,
  PublikState,
  PublikTier,
} from './types';

/* First-launch provisioning against `POST /installs` (CONTRACT §3.2).
 *
 * Rules, each pinned by provision.test.ts:
 *   - Consent precedes mint [S4]: nothing is sent until the disclosure has
 *     been accepted (`acceptDisclosure`). Never at server boot.
 *   - A user-entered key always wins; an existing publik connection is left
 *     alone; a declined install stays declined. Never overwrite.
 *   - The key lands in the app's existing credential store (config.json
 *     modelProviders[]) through configManager.addModelProvider(); the
 *     `config.publik` block holds state only, never the key.
 *   - `base_url` and `models` from the response are honoured over the
 *     compiled defaults.
 *   - Without PUBLIK_APP_TOKEN (dev, Docker, source builds) every path here
 *     is a no-op.
 *   - Never throws: an offline first launch is normal.
 */

export type ProvisionDeps = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  installId?: () => string;
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

export const publikProvider = (): ConfigModelProvider | undefined =>
  (configManager.getConfig('modelProviders', []) as ConfigModelProvider[]).find(
    (p) => p.type === PUBLIK_PROVIDER_TYPE,
  );

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

export const hasAppToken = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.PUBLIK_APP_TOKEN);

export const disclosureAccepted = (state = readState()) =>
  (state?.disclosureVersion ?? 0) >= DISCLOSURE_VERSION;

const osName = (): 'macos' | 'windows' | 'linux' => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
};

const deviceName = (): string | undefined => {
  try {
    const name = os
      .hostname()
      .replace(/\.local$/, '')
      .trim();
    return name ? name.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
};

const tierModels = (
  models: InstallResponse['models'],
): Partial<Record<PublikTier, string>> | undefined => {
  if (!models || typeof models !== 'object') return undefined;
  const out: Partial<Record<PublikTier, string>> = {};
  for (const tier of ['fast', 'balanced', 'smart'] as PublikTier[]) {
    const v = models[tier];
    if (typeof v === 'string' && /^[a-z0-9._:/-]{1,64}$/i.test(v))
      out[tier] = v;
  }
  return Object.keys(out).length ? out : undefined;
};

/* The alias list the provider serves: response-supplied names first, the
   compiled defaults for anything the response left out. */
export const publikModels = (): Record<PublikTier, string> => ({
  ...PUBLIK_MODEL_DEFAULTS,
  ...(readState()?.models ?? {}),
});

const mint = async (
  installId: string,
  deps: ProvisionDeps,
): Promise<{
  status: number;
  body: InstallResponse | null;
  retryAfter: string | null;
}> => {
  const env = deps.env ?? process.env;
  const token = env.PUBLIK_APP_TOKEN!;
  const baseURL = (env.PUBLIK_API_BASE_URL || PUBLIK_BASE_URL_DEFAULT).replace(
    /\/$/,
    '',
  );

  const res = await (deps.fetch ?? fetch)(`${baseURL}/installs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_token: token,
      app_slug: PUBLIK_APP_SLUG,
      app_version:
        env.PUBLIK_APP_VERSION || process.env.NEXT_PUBLIC_VERSION || '0.0.0',
      os: osName(),
      os_version: os.release(),
      arch: process.arch,
      device_name: deviceName(),
      install_id: installId,
      disclosure_version: readState()?.disclosureVersion ?? DISCLOSURE_VERSION,
      dialects: ['chat_completions'],
    }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
  });

  let body: InstallResponse | null = null;
  try {
    body = (await res.json()) as InstallResponse;
  } catch {
    body = null;
  }
  return {
    status: res.status,
    body,
    retryAfter: res.headers.get('retry-after'),
  };
};

/* Idempotent. Safe to call on every boot, from the accept/retry routes and
   after a `key_revoked` answer. Returns the reason it did nothing so the
   caller (and the tests) can tell the cases apart. */
export async function ensureProvisioned(
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const env = deps.env ?? process.env;

  /* 1. Never overwrite. */
  if (publikProvider()) return 'active';
  const state = readState();
  if (state?.state === 'declined') return 'declined';
  if (state?.state === 'disconnected') return 'disconnected';
  if (!hasAppToken(env)) return 'no-token';
  /* 2. Consent precedes mint. */
  if (!disclosureAccepted(state)) return 'consent-required';

  const newId = deps.installId ?? (() => crypto.randomUUID());
  let installId = state?.installId ?? newId();
  if (!state?.installId) writeState({ installId, state: 'pending' });

  const baseURL = (env.PUBLIK_API_BASE_URL || PUBLIK_BASE_URL_DEFAULT).replace(
    /\/$/,
    '',
  );

  try {
    let { status, body, retryAfter } = await mint(installId, deps);

    /* Replay [B1]: the server knows this install_id but cannot return the
       old secret. We have no credential (or we would have returned at
       step 1), so mint a fresh install once. */
    if (status === 200 && (!body || body.key == null)) {
      installId = newId();
      writeState({ installId, state: 'pending' });
      ({ status, body, retryAfter } = await mint(installId, deps));
    }

    if (status === 401 || status === 403) {
      writeState({ state: 'pending', lastError: 'app token rejected' });
      return 'failed';
    }
    if (status === 429) {
      writeState({
        state: 'pending',
        lastError: 'too many installs right now',
        retryAfter: retryAfter ?? undefined,
      });
      return 'failed';
    }
    if (status !== 201 && status !== 200) {
      throw new Error(`installs returned ${status}`);
    }
    if (
      !body ||
      typeof body.key !== 'string' ||
      !PUBLIK_KEY_RE.test(body.key)
    ) {
      throw new Error('installs returned a malformed key');
    }

    /* 3. The existing credential store, through the existing API. The
          response's base_url wins over the compiled default [S8]. */
    configManager.addModelProvider(PUBLIK_PROVIDER_TYPE, PUBLIK_PROVIDER_NAME, {
      apiKey: body.key,
      baseURL:
        typeof body.base_url === 'string' && /^https?:\/\//.test(body.base_url)
          ? body.base_url.replace(/\/$/, '')
          : baseURL,
    });

    const starter =
      body.starter_micros ?? body.balance_micros ?? body.starting_credit_micros;
    writeState({
      state: 'active',
      installId,
      claimUrl: typeof body.claim_url === 'string' ? body.claim_url : undefined,
      claimCode:
        typeof body.claim_code === 'string' ? body.claim_code : undefined,
      claimState: body.claim_state === 'claimed' ? 'claimed' : 'anonymous',
      models: tierModels(body.models),
      starterMicros: typeof starter === 'number' ? starter : undefined,
      mintedAt: (deps.now ?? (() => new Date()))().toISOString(),
      lastError: undefined,
      retryAfter: undefined,
    });
    publikBalance.reset();
    if (body.wallet) publikBalance.applyWallet(body.wallet);
    else if (typeof starter === 'number') {
      /* The first-run card's balance line (CONTRACT §12.1 (a)) reads the
         mint response until the first metered call stamps headers. */
      publikBalance.applyWallet({
        balance_micros: starter,
        claim_state: body.claim_state ?? 'anonymous',
        claim_url: body.claim_url,
        starter: { remaining_micros: starter },
      });
    }
    return 'active';
  } catch (err: any) {
    /* Offline first launch is normal (the splash may still be downloading
       SearXNG). Leave the wizard on BYO; try again from the Retry line.
       Only the HTTP status text is stored — never a body, never a key. */
    const message =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'publik API did not answer in time'
        : String(err?.message ?? err).slice(0, 120);
    writeState({ state: 'pending', lastError: message });
    return 'failed';
  }
}

/* The disclosure's "Continue" button. Recording acceptance is what unlocks
   the mint; the two happen together so the wizard sees `active` on return. */
export async function acceptDisclosure(deps: ProvisionDeps = {}) {
  writeState({ disclosureVersion: DISCLOSURE_VERSION });
  return ensureProvisioned(deps);
}

/* The first-run card's "Later" (and its plan button): records that the
   balance line, the justification and the CTA were shown (CONTRACT §12.4,
   "never a silent starter"). Touches nothing else — the key stays, the
   starter stays, and the button stays in Settings. */
export function acknowledgeCta(deps: ProvisionDeps = {}) {
  if (!readState()) return;
  writeState({ ctaSeenAt: (deps.now ?? (() => new Date()))().toISOString() });
}

/* "Use my own key instead" — from the wizard, from Settings' delete, or
   from a 402 card. Removes the connection and pins the choice. */
export function declinePublik() {
  const existing = publikProvider();
  if (existing) configManager.removeModelProvider(existing.id);
  publikBalance.reset();
  writeState({ state: 'declined', lastError: undefined });
}

/* "Reconnect" after a decline or a disconnect: back to pending with a fresh
   install identity (the old one was either never minted or was revoked by
   the user's own hand), then the disclosure shows again. */
export function resetPublik() {
  const existing = publikProvider();
  if (existing) configManager.removeModelProvider(existing.id);
  publikBalance.reset();
  /* No disclosureVersion: acceptance is per install, so the sheet shows
     again before anything is sent. */
  configManager.updateConfig('publik', {
    installId: crypto.randomUUID(),
    state: 'pending',
  } satisfies PublikState);
}

/* Retry after an offline / rate-limited mint — same install id, same
   consent. */
export async function retryPublik(deps: ProvisionDeps = {}) {
  const state = readState();
  if (state?.state === 'pending')
    writeState({ lastError: undefined, retryAfter: undefined });
  return ensureProvisioned(deps);
}

/* `401 key_revoked` semantics (CONTRACT §1 [B2]):
     reprovision:true  — the idle sweep took the key; mint again with the
                         SAME install_id, silently. Consent already given.
     reprovision:false — the user revoked this computer from the dashboard
                         (or an uninstaller hook); drop the dead key and
                         stop. Reconnect is a user action. */
export async function handleKeyRevoked(
  reprovision: boolean,
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const existing = publikProvider();
  if (existing) configManager.removeModelProvider(existing.id);
  publikBalance.reset();
  if (!reprovision) {
    writeState({
      state: 'disconnected',
      lastError: 'removed from your publik account',
    });
    return 'disconnected';
  }
  writeState({ state: 'pending', lastError: undefined });
  return ensureProvisioned(deps);
}
