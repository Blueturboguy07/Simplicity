import { WalletResponse } from './types';

/* The balance line is header-driven: every metered call stamps
   `x-publik-balance` (available micros after admission) and the week
   fields (CONTRACT §1). Streams settle after their headers are sent, so
   the value seen at stream start still includes the hold; `GET /wallet`
   is the reconciliation path and the fallback when nothing has been
   observed yet. One cache per server process — the key never leaves it. */

export type BalanceSnapshot = {
  balanceMicros: number | null;
  starterRemainingMicros: number | null;
  claimState: 'anonymous' | 'claimed' | null;
  weekUsedMicros: number | null;
  weekBudgetMicros: number | null;
  weekResetsAt: string | null;
  claimUrl: string | null;
  addCreditUrl: string | null;
  servedModel: string | null;
  lastChargeMicros: number | null;
  seenAt: number;
};

const empty = (): BalanceSnapshot => ({
  balanceMicros: null,
  starterRemainingMicros: null,
  claimState: null,
  weekUsedMicros: null,
  weekBudgetMicros: null,
  weekResetsAt: null,
  claimUrl: null,
  addCreditUrl: null,
  servedModel: null,
  lastChargeMicros: null,
  seenAt: 0,
});

const int = (v: string | null | undefined): number | null =>
  v != null && /^\d+$/.test(v) ? Number(v) : null;

export const FRESH_MS = 60_000;

export class PublikBalanceCache {
  private snap: BalanceSnapshot = empty();

  observe(headers: Headers) {
    const balance =
      int(headers.get('x-publik-balance')) ??
      /* one-release alias (R25 N3) */
      int(headers.get('x-publik-balance-micros'));
    if (balance === null) return; /* not a gateway response */

    this.snap.balanceMicros = balance;
    this.snap.seenAt = Date.now();

    const starter = int(headers.get('x-publik-starter-remaining'));
    this.snap.starterRemainingMicros = starter ?? 0;

    const claim = headers.get('x-publik-claim-state');
    if (claim === 'anonymous' || claim === 'claimed') {
      this.snap.claimState = claim;
    }

    const used = int(headers.get('x-publik-week-used'));
    if (used !== null) this.snap.weekUsedMicros = used;
    const budget = headers.get('x-publik-week-budget');
    if (budget !== null) this.snap.weekBudgetMicros = int(budget);
    const resets = headers.get('x-publik-week-resets-at');
    if (resets) this.snap.weekResetsAt = resets;

    const model = headers.get('x-publik-model');
    if (model) this.snap.servedModel = model;
    const charge = int(headers.get('x-publik-charge-micros'));
    if (charge !== null) this.snap.lastChargeMicros = charge;
  }

  applyWallet(w: WalletResponse) {
    const balance = w.balance_micros ?? w.available_micros;
    if (typeof balance === 'number') this.snap.balanceMicros = balance;
    if (w.claim_state === 'anonymous' || w.claim_state === 'claimed') {
      this.snap.claimState = w.claim_state;
    }
    if (typeof w.starter?.remaining_micros === 'number') {
      this.snap.starterRemainingMicros = w.starter.remaining_micros;
    }
    if (w.week) {
      if (typeof w.week.used_micros === 'number')
        this.snap.weekUsedMicros = w.week.used_micros;
      this.snap.weekBudgetMicros =
        typeof w.week.budget_micros === 'number' ? w.week.budget_micros : null;
      if (w.week.resets_at) this.snap.weekResetsAt = w.week.resets_at;
    }
    if (w.claim_url !== undefined) this.snap.claimUrl = w.claim_url ?? null;
    if (w.add_credit_url !== undefined)
      this.snap.addCreditUrl = w.add_credit_url ?? null;
    this.snap.seenAt = Date.now();
  }

  peek(): BalanceSnapshot {
    return { ...this.snap };
  }

  reset() {
    this.snap = empty();
  }

  /* Fresh header value if we have one, else one `GET /wallet` (3 s budget).
     Never throws: the balance line is decoration, not a gate. */
  async read(
    baseURL: string,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<BalanceSnapshot> {
    if (
      this.snap.balanceMicros !== null &&
      Date.now() - this.snap.seenAt < FRESH_MS
    ) {
      return this.peek();
    }
    try {
      const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/wallet`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        const body = (await res.json()) as WalletResponse;
        this.applyWallet(body);
      }
    } catch {
      /* offline — last known value stands */
    }
    return this.peek();
  }
}

export const publikBalance = new PublikBalanceCache();
