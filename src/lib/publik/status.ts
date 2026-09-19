import { publikBalance } from './balance';
import {
  disclosureAccepted,
  hasAppToken,
  publikProvider,
  readState,
} from './provision';
import { PublikStatus } from './types';

/* What the client is told. The key never leaves the server; the renderer
   gets state and money only. */
export async function getPublikStatus(
  opts: { refreshBalance?: boolean } = {},
): Promise<PublikStatus> {
  const state = readState();
  const provider = publikProvider();
  const available = hasAppToken() || Boolean(provider);

  let snap = publikBalance.peek();
  if (provider && opts.refreshBalance !== false) {
    snap = await publikBalance.read(
      String(provider.config.baseURL),
      String(provider.config.apiKey),
    );
  }

  const claimUrl = snap.claimUrl ?? state?.claimUrl ?? null;
  const addCreditUrl = snap.addCreditUrl ?? state?.addCreditUrl ?? null;
  const claimState = snap.claimState ?? state?.claimState ?? null;

  return {
    available,
    state: provider
      ? 'active'
      : !available
        ? 'unavailable'
        : (state?.state ?? 'pending'),
    connected: Boolean(provider),
    providerId: provider?.id ?? null,
    disclosureVersion: state?.disclosureVersion ?? null,
    disclosureCurrent: disclosureAccepted(state),
    claimUrl,
    addCreditUrl,
    /* exactly one actionable link, chosen by claim state (CONTRACT §1) */
    topUpUrl:
      snap.topUpUrl ??
      (claimState === 'claimed'
        ? (addCreditUrl ?? claimUrl)
        : (claimUrl ?? addCreditUrl)),
    claimState,
    balanceMicros: snap.balanceMicros ?? state?.starterMicros ?? null,
    starterRemainingMicros: snap.starterRemainingMicros,
    starterGrantMicros: state?.starterMicros ?? null,
    creditError: snap.creditError,
    ctaSeen: Boolean(state?.ctaSeenAt),
    week: {
      usedMicros: snap.weekUsedMicros,
      budgetMicros: snap.weekBudgetMicros,
      resetsAt: snap.weekResetsAt,
    },
    lastError: state?.lastError ?? null,
  };
}
