import { describe, expect, it } from 'vitest';
import {
  balanceLine,
  bannerFor,
  CTA_ADD_LABEL,
  CTA_LINK_LABEL,
  CTA_MANAGE_LABEL,
  CTA_PICK_LABEL,
  planCta,
  publikLink,
  topUpCta,
  WHY_IT_COSTS,
} from './cta';
import { PUBLIK_ACCOUNT_URL, PublikStatus } from './types';

/* CONTRACT §12 (founder, 2026-09-19) pinned at the function level, so the
   card, the Settings card, the chat error block and the banner cannot
   drift from each other. */

const status = (over: Partial<PublikStatus> = {}): PublikStatus => ({
  available: true,
  state: 'active',
  connected: true,
  providerId: 'p1',
  disclosureVersion: 1,
  disclosureCurrent: true,
  claimUrl: 'https://publikhq.com/claim/HK7F-2QWD',
  addCreditUrl: 'https://publikhq.com/dashboard/api/add',
  topUpUrl: 'https://publikhq.com/claim/HK7F-2QWD',
  claimState: 'anonymous',
  balanceMicros: 250000,
  starterRemainingMicros: 250000,
  starterGrantMicros: 250000,
  creditError: null,
  ctaSeen: false,
  week: { usedMicros: null, budgetMicros: null, resetsAt: null },
  lastError: null,
  ...over,
});

describe('publikLink — only publikhq.com may be opened', () => {
  it.each([
    'https://publikhq.com/claim/HK7F-2QWD',
    'https://publikhq.com/dashboard/api/add',
    'https://www.publikhq.com/developers#plans',
  ])('keeps %s', (u) => {
    expect(publikLink(u)).toBe(u);
  });

  it.each([
    'https://publikhq.com.evil.example/claim/x',
    'https://evilpublikhq.com/claim/x',
    'https://example.com/claim/x',
    'http://publikhq.com/claim/x',
    'javascript:alert(1)',
    'https://user:pw@publikhq.com/claim/x',
    '/claim/x',
    '',
    null,
    undefined,
    42,
  ])('drops %s', (u) => {
    expect(publikLink(u)).toBeNull();
  });
});

describe('planCta — the primary button', () => {
  it('first-run, anonymous: "Link this computer & pick a plan" → the response claim_url', () => {
    expect(planCta(status(), 'first-run')).toEqual({
      label: CTA_LINK_LABEL,
      href: 'https://publikhq.com/claim/HK7F-2QWD',
    });
  });

  it('settings, anonymous: "Pick a plan" → the same claim_url', () => {
    expect(planCta(status(), 'settings')).toEqual({
      label: CTA_PICK_LABEL,
      href: 'https://publikhq.com/claim/HK7F-2QWD',
    });
  });

  it('claimed: "Manage plan" → https://publikhq.com/dashboard/api on both surfaces', () => {
    const s = status({ claimState: 'claimed' });
    expect(planCta(s, 'first-run')).toEqual({
      label: CTA_MANAGE_LABEL,
      href: 'https://publikhq.com/dashboard/api',
    });
    expect(planCta(s, 'settings')).toEqual({
      label: CTA_MANAGE_LABEL,
      href: 'https://publikhq.com/dashboard/api',
    });
    expect(PUBLIK_ACCOUNT_URL).toBe('https://publikhq.com/dashboard/api');
  });

  it('an off-domain claim_url is dropped; the button falls back to the dashboard', () => {
    const cta = planCta(
      status({ claimUrl: 'https://evil.example/claim/HK7F-2QWD' }),
      'first-run',
    );
    expect(cta.href).toBe(PUBLIK_ACCOUNT_URL);
    expect(cta.href).not.toContain('evil.example');
  });

  it('a missing claim_url still lands on publikhq.com', () => {
    expect(planCta(status({ claimUrl: null }), 'first-run').href).toBe(
      PUBLIK_ACCOUNT_URL,
    );
  });
});

describe('balanceLine — (a) from the response, never a constant', () => {
  it('anonymous: "$0.25 of free starter usage" from starter_micros', () => {
    expect(balanceLine(status())).toBe('$0.25 of free starter usage');
  });

  it('follows whatever the server granted', () => {
    expect(
      balanceLine(
        status({ starterRemainingMicros: 500000, balanceMicros: 500000 }),
      ),
    ).toBe('$0.50 of free starter usage');
    expect(
      balanceLine(status({ starterRemainingMicros: 40000, balanceMicros: 40000 })),
    ).toBe('$0.04 of free starter usage');
  });

  it('falls back to balance_micros before any header has been seen', () => {
    expect(
      balanceLine(status({ starterRemainingMicros: null, balanceMicros: 250000 })),
    ).toBe('$0.25 of free starter usage');
  });

  it('claimed: the available balance', () => {
    expect(
      balanceLine(status({ claimState: 'claimed', balanceMicros: 1850000 })),
    ).toBe('$1.85 of usage available');
  });

  it('nothing known → nothing shown (never an invented amount)', () => {
    expect(
      balanceLine(status({ starterRemainingMicros: null, balanceMicros: null })),
    ).toBeNull();
  });
});

describe('topUpCta — exactly one link on a money message', () => {
  it('prefers the 402 body top_up_url, publikhq.com only', () => {
    expect(
      topUpCta(status(), 'https://publikhq.com/dashboard/api/add').href,
    ).toBe('https://publikhq.com/dashboard/api/add');
    expect(topUpCta(status(), 'https://evil.example/pay').href).toBe(
      'https://publikhq.com/claim/HK7F-2QWD',
    );
  });

  it('labels by claim state', () => {
    expect(topUpCta(status()).label).toBe(CTA_LINK_LABEL);
    expect(topUpCta(status({ claimState: 'claimed' })).label).toBe(
      CTA_ADD_LABEL,
    );
  });
});

describe('bannerFor — non-blocking, response-driven', () => {
  it('nothing while the starter is healthy', () => {
    expect(bannerFor(status())).toBeNull();
    expect(bannerFor(status({ starterRemainingMicros: 50000 }))).toBeNull();
  });

  it('starter under 20% of the grant → the amount left and one link', () => {
    const b = bannerFor(
      status({ starterRemainingMicros: 40000, balanceMicros: 40000 }),
    );
    expect(b?.kind).toBe('low-starter');
    expect(b?.message).toMatch(/^\$0\.04 of free starter usage left\./);
    expect(b?.message).toMatch(/Link this computer and pick a plan/);
    expect(b?.link).toEqual({
      label: CTA_LINK_LABEL,
      href: 'https://publikhq.com/claim/HK7F-2QWD',
    });
  });

  it('a plan or pack on the wallet silences the low-starter banner', () => {
    expect(
      bannerFor(
        status({
          claimState: 'claimed',
          starterRemainingMicros: 40000,
          balanceMicros: 1900000,
        }),
      ),
    ).toBeNull();
  });

  it('a 402 → the response message and its top_up_url, nothing else', () => {
    const b = bannerFor(
      status({
        creditError: {
          message:
            'Not enough publik credit for this request. Link this computer and pick a plan at the link below, or use your own key.',
          topUpUrl: 'https://publikhq.com/claim/HK7F-2QWD',
        },
      }),
    );
    expect(b?.kind).toBe('credit');
    expect(b?.message).toBe(
      'Not enough publik credit for this request. Link this computer and pick a plan at the link below, or use your own key.',
    );
    expect(b?.link.href).toBe('https://publikhq.com/claim/HK7F-2QWD');
  });

  it('a 402 with an off-domain top_up_url falls back to the known claim link', () => {
    const b = bannerFor(
      status({
        creditError: { message: 'x', topUpUrl: 'https://evil.example/pay' },
      }),
    );
    expect(b?.link.href).toBe('https://publikhq.com/claim/HK7F-2QWD');
  });

  it('never for a disconnected publik (BYO / local modes untouched)', () => {
    expect(
      bannerFor(status({ connected: false, starterRemainingMicros: 1 })),
    ).toBeNull();
  });

  it('no grant on record → no threshold, no banner', () => {
    expect(
      bannerFor(status({ starterGrantMicros: null, starterRemainingMicros: 1 })),
    ).toBeNull();
  });
});

describe('the justification sentence', () => {
  it('is the one sentence, dollars not tokens, no unit called credits, no vendor', () => {
    expect(WHY_IT_COSTS).toBe(
      "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.",
    );
    expect(WHY_IT_COSTS).not.toMatch(/\bcredits?\b/i);
    expect(WHY_IT_COSTS).not.toMatch(/token/i);
    expect(WHY_IT_COSTS).not.toMatch(/OpenAI|ChatGPT|Anthropic|Google/);
  });
});
