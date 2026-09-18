import { describe, expect, it, vi } from 'vitest';
import { PublikBalanceCache } from './balance';

/* The balance line: x-publik-* headers first (CONTRACT §1), GET /wallet
   as the fallback (CONTRACT §3.2). */

const headers = (h: Record<string, string>) => new Headers(h);

describe('PublikBalanceCache.observe', () => {
  it('reads the contract headers off a metered response', () => {
    const c = new PublikBalanceCache();
    c.observe(
      headers({
        'x-publik-model': 'gpt-5.6-terra',
        'x-publik-balance': '181240',
        'x-publik-week-used': '68760',
        'x-publik-week-budget': 'none',
        'x-publik-week-resets-at': '2026-09-25T17:04:11Z',
        'x-publik-claim-state': 'anonymous',
        'x-publik-starter-remaining': '181240',
        'x-publik-charge-micros': '410',
      }),
    );
    const s = c.peek();
    expect(s.balanceMicros).toBe(181240);
    expect(s.weekUsedMicros).toBe(68760);
    expect(s.weekBudgetMicros).toBeNull();
    expect(s.weekResetsAt).toBe('2026-09-25T17:04:11Z');
    expect(s.claimState).toBe('anonymous');
    expect(s.starterRemainingMicros).toBe(181240);
    expect(s.servedModel).toBe('gpt-5.6-terra');
    expect(s.lastChargeMicros).toBe(410);
  });

  it('accepts the one-release x-publik-balance-micros alias', () => {
    const c = new PublikBalanceCache();
    c.observe(headers({ 'x-publik-balance-micros': '5000' }));
    expect(c.peek().balanceMicros).toBe(5000);
  });

  it('ignores responses that carry no publik balance header (a BYO provider)', () => {
    const c = new PublikBalanceCache();
    c.observe(headers({ 'x-request-id': 'abc' }));
    expect(c.peek().balanceMicros).toBeNull();
  });

  it('a numeric week budget with claim state claimed', () => {
    const c = new PublikBalanceCache();
    c.observe(
      headers({
        'x-publik-balance': '3120000',
        'x-publik-week-used': '1200000',
        'x-publik-week-budget': '4620000',
        'x-publik-claim-state': 'claimed',
      }),
    );
    const s = c.peek();
    expect(s.weekBudgetMicros).toBe(4620000);
    expect(s.claimState).toBe('claimed');
    /* starter header absent once it hits zero → 0, not "unknown" */
    expect(s.starterRemainingMicros).toBe(0);
  });
});

describe('PublikBalanceCache.read — GET /wallet fallback', () => {
  it('calls /wallet with the key when nothing has been observed', async () => {
    const c = new PublikBalanceCache();
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://publikhq.com/api/v1/wallet');
      expect(init.headers.Authorization).toBe('Bearer pk_live_x');
      return new Response(
        JSON.stringify({
          balance_micros: 930000,
          claim_state: 'claimed',
          starter: { remaining_micros: 0 },
          week: {
            used_micros: 1000,
            budget_micros: 1850000,
            resets_at: '2026-09-25T00:00:00Z',
          },
          claim_url: null,
          add_credit_url: 'https://publikhq.com/dashboard/api/add',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const s = await c.read(
      'https://publikhq.com/api/v1/',
      'pk_live_x',
      fetchImpl as any,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.balanceMicros).toBe(930000);
    expect(s.claimState).toBe('claimed');
    expect(s.weekBudgetMicros).toBe(1850000);
    expect(s.addCreditUrl).toBe('https://publikhq.com/dashboard/api/add');
    expect(s.claimUrl).toBeNull();
  });

  it('does not call /wallet when a fresh header value exists', async () => {
    const c = new PublikBalanceCache();
    c.observe(headers({ 'x-publik-balance': '42' }));
    const fetchImpl = vi.fn();
    const s = await c.read(
      'https://publikhq.com/api/v1',
      'k',
      fetchImpl as any,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.balanceMicros).toBe(42);
  });

  it('never throws when the gateway is unreachable', async () => {
    const c = new PublikBalanceCache();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const s = await c.read(
      'https://publikhq.com/api/v1',
      'k',
      fetchImpl as any,
    );
    expect(s.balanceMicros).toBeNull();
  });
});
