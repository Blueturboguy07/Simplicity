/* publik API — the metered provider the packaged build ships with.
 *
 * Copy rule (CONTRACT §1): everywhere a user can read it this is
 * "publik API" — never the name of the model vendor behind it. Money is
 * shown in dollars, never per token. This module is dependency-free on
 * purpose: global fetch, node:crypto, node:os and the app's own config
 * store are all it touches. */

export const PUBLIK_APP_SLUG = 'simplicity';
export const PUBLIK_BASE_URL_DEFAULT = 'https://publikhq.com/api/v1';
export const PUBLIK_ACCOUNT_URL = 'https://publikhq.com/dashboard/api';
export const PUBLIK_PRICING_URL = 'https://publikhq.com/developers#plans';
export const PUBLIK_TERMS_URL = 'https://publikhq.com/terms#api';

/* Bump when the disclosure copy below changes so an existing install is
   shown the new text once. The server records the value and never rejects
   on it (CONTRACT §3.2 [S18]). */
export const DISCLOSURE_VERSION = 1;

/* Key format the gateway mints (CONTRACT §1). The parser is strict so a
   gateway that ships a different shape fails to `pending` + BYO, never to a
   broken app. */
export const PUBLIK_KEY_RE = /^pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}$/;

/* Tier aliases, never upstream slugs — the alias is the swap seam. The
   install response may rename them (`models`), which provisioning stores
   and the provider honours. */
export type PublikTier = 'fast' | 'balanced' | 'smart';
export const PUBLIK_MODEL_DEFAULTS: Record<PublikTier, string> = {
  balanced: 'publik-balanced',
  fast: 'publik-fast',
  smart: 'publik-smart',
};
export const PUBLIK_TIER_NAMES: Record<PublikTier, string> = {
  balanced: 'Balanced',
  fast: 'Fast',
  smart: 'Smart',
};
/* Picker order: balanced first so it is the wizard's default. */
export const PUBLIK_TIER_ORDER: PublikTier[] = ['balanced', 'fast', 'smart'];

export type PublikState = {
  installId: string;
  /* pending:      token present; not yet minted (disclosure not accepted,
                   or the last mint failed — `lastError` says why)
     active:       a `publik` provider entry in modelProviders[] holds the key
     declined:     the user chose their own key; never mint unless asked
     disconnected: the gateway answered key_revoked with reprovision:false
                   (the user removed this computer from their account) */
  state: 'pending' | 'active' | 'declined' | 'disconnected';
  disclosureVersion?: number;
  claimUrl?: string;
  claimCode?: string;
  addCreditUrl?: string;
  claimState?: 'anonymous' | 'claimed';
  models?: Partial<Record<PublikTier, string>>;
  starterMicros?: number;
  mintedAt?: string;
  lastError?: string;
  retryAfter?: string;
};

/* `POST /installs` 201 body, the fields this app reads (CONTRACT §3.2, R21
   §2.1). Every field but `key` is optional so a partial response still
   provisions; `key` is null on a 200 replay. */
export type InstallResponse = {
  install_id?: string;
  key: string | null;
  key_id?: string;
  base_url?: string;
  models?: Partial<Record<string, string>>;
  claim_code?: string;
  claim_url?: string;
  claim_state?: 'anonymous' | 'claimed';
  starter_micros?: number;
  balance_micros?: number;
  starting_credit_micros?: number;
  wallet?: WalletResponse;
};

/* `GET /wallet` body (CONTRACT §3.2, R21 §2.3). */
export type WalletResponse = {
  balance_micros?: number;
  available_micros?: number;
  claim_state?: 'anonymous' | 'claimed';
  starter?: { remaining_micros?: number; expires_at?: string } | null;
  plan?: { id?: string; label?: string; monthly_micros?: number } | null;
  week?: {
    used_micros?: number;
    budget_micros?: number | null;
    resets_at?: string;
  } | null;
  claim_url?: string | null;
  add_credit_url?: string | null;
  top_up_url?: string | null;
};

/* What the client reads: state and money, never the token or the key. */
export type PublikStatus = {
  available: boolean;
  state: 'unavailable' | PublikState['state'];
  connected: boolean;
  providerId: string | null;
  disclosureVersion: number | null;
  disclosureCurrent: boolean;
  claimUrl: string | null;
  addCreditUrl: string | null;
  topUpUrl: string | null;
  claimState: 'anonymous' | 'claimed' | null;
  balanceMicros: number | null;
  starterRemainingMicros: number | null;
  week: {
    usedMicros: number | null;
    budgetMicros: number | null;
    resetsAt: string | null;
  };
  lastError: string | null;
};

export const formatMicros = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
