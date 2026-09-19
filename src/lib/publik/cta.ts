import { formatMicros, PUBLIK_ACCOUNT_URL, PublikStatus } from './types';

/* The in-app plan CTA and its justification (CONTRACT §12, founder
 * 2026-09-19; SDK convention §6). Pure functions, shared by the first-run
 * card, the Settings card, the chat error block and the balance banner so
 * every surface says the same thing and cta.test.ts pins it once.
 *
 * Copy rule (CONTRACT §1): "publik API", dollars, never tokens, never a
 * made-up unit, never the provider's name. The free amount always comes
 * from the server (starter_micros / x-publik-starter-remaining) — never a
 * constant in this file. */

/* The one-sentence justification. Sentences from the site's
   lib/publik-api/why-it-costs.ts, so the argument here is the argument on
   the dashboard, the claim page and the 402 body. */
export const WHY_IT_COSTS =
  "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.";

export const CTA_LINK_LABEL = 'Link this computer & pick a plan';
export const CTA_PICK_LABEL = 'Pick a plan';
export const CTA_MANAGE_LABEL = 'Manage plan';
export const CTA_ADD_LABEL = 'Add a plan or pack';
export const CTA_LATER_LABEL = 'Later';
export const WHY_IT_COSTS_LABEL = 'Why it costs money';

/* Starter share below which the banner shows (CONTRACT §12 / task rule 3). */
export const LOW_STARTER_SHARE = 0.2;

/* Only publikhq.com may be opened from a publik button. The gateway is
   the only source of these URLs, but a response is still input: an
   off-domain, non-https or malformed link is dropped, never rendered. */
export const publikLink = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'publikhq.com' && !host.endsWith('.publikhq.com')) return null;
  if (u.username || u.password) return null;
  return u.toString();
};

export type PlanCta = { label: string; href: string };

/* The primary button.
     first-run card, anonymous → "Link this computer & pick a plan" → claim_url
     settings card, anonymous  → "Pick a plan"                      → claim_url
     either, claimed           → "Manage plan"                      → dashboard
   Without a usable claim_url the dashboard's own claim box is the way to
   link the computer, so the button still lands on publikhq.com. */
export const planCta = (
  status: Pick<PublikStatus, 'claimState' | 'claimUrl'>,
  surface: 'first-run' | 'settings' = 'first-run',
): PlanCta => {
  if (status.claimState === 'claimed') {
    return { label: CTA_MANAGE_LABEL, href: PUBLIK_ACCOUNT_URL };
  }
  const claim = publikLink(status.claimUrl);
  const label = surface === 'first-run' ? CTA_LINK_LABEL : CTA_PICK_LABEL;
  return { label, href: claim ?? PUBLIK_ACCOUNT_URL };
};

/* The balance line, (a) in CONTRACT §12.1: "<amount> of free starter usage"
   from the mint response, then live from the headers. */
export const balanceLine = (
  status: Pick<
    PublikStatus,
    'claimState' | 'balanceMicros' | 'starterRemainingMicros'
  >,
): string | null => {
  const anonymous = status.claimState !== 'claimed';
  if (anonymous) {
    const starter = status.starterRemainingMicros ?? status.balanceMicros;
    if (starter === null) return null;
    return `${formatMicros(starter)} of free starter usage`;
  }
  if (status.balanceMicros === null) return null;
  return `${formatMicros(status.balanceMicros)} of usage available`;
};

/* The one actionable link on a money message (CONTRACT §1: exactly one,
   top_up_url), labelled by claim state. */
export const topUpCta = (
  status: Pick<PublikStatus, 'claimState' | 'topUpUrl' | 'claimUrl'>,
  topUpUrl?: string | null,
): PlanCta => {
  const claimed = status.claimState === 'claimed';
  const href =
    publikLink(topUpUrl) ??
    publikLink(status.topUpUrl) ??
    publikLink(status.claimUrl) ??
    PUBLIK_ACCOUNT_URL;
  return { label: claimed ? CTA_ADD_LABEL : CTA_LINK_LABEL, href };
};

export type PublikBanner = {
  kind: 'credit' | 'low-starter';
  message: string;
  link: PlanCta;
};

/* Non-blocking banner (task rule 3): a 402 arrived, or the wallet shows the
   starter under 20% of what was granted with nothing else to draw on.
   Message and link both come from the response; the app adds no pricing
   claim of its own. */
export const bannerFor = (
  status: Pick<
    PublikStatus,
    | 'connected'
    | 'claimState'
    | 'claimUrl'
    | 'topUpUrl'
    | 'balanceMicros'
    | 'starterRemainingMicros'
    | 'starterGrantMicros'
    | 'creditError'
  >,
): PublikBanner | null => {
  if (!status.connected) return null;

  if (status.creditError) {
    return {
      kind: 'credit',
      message: status.creditError.message,
      link: topUpCta(status, status.creditError.topUpUrl),
    };
  }

  const remaining = status.starterRemainingMicros;
  const grant = status.starterGrantMicros;
  if (remaining === null || grant === null || grant <= 0) return null;
  if (remaining >= grant * LOW_STARTER_SHARE) return null;
  /* A plan or pack in the wallet means the starter running low is not
     news — the balance line already shows what is left. */
  if (status.balanceMicros !== null && status.balanceMicros > remaining)
    return null;

  const next =
    status.claimState === 'claimed'
      ? 'Add a plan or a pack at the link below, or use your own key in Settings.'
      : 'Link this computer and pick a plan at the link below, or use your own key in Settings.';
  return {
    kind: 'low-starter',
    message: `${formatMicros(remaining)} of free starter usage left. ${next}`,
    link: topUpCta(status),
  };
};
