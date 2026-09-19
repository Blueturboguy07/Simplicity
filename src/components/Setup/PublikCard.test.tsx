import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PublikCard from './PublikCard';
import { PublikBannerView } from '@/components/Publik/PublikBanner';
import { bannerFor, WHY_IT_COSTS } from '@/lib/publik/cta';
import type { PublikStatus } from '@/lib/publik/types';

/* The first-run card right after `POST /installs` (CONTRACT §12.1),
   rendered to markup the way the wizard renders it. What the mint response
   says is what the card shows: the amount, the claim_url, nothing else. */

const mintResponse = {
  claim_url: 'https://publikhq.com/claim/HK7F-2QWD',
  claim_state: 'anonymous' as const,
  starter_micros: 250000,
  balance_micros: 250000,
};

/* GET /api/publik after the mint above (status.ts) */
const afterMint = (over: Partial<PublikStatus> = {}): PublikStatus => ({
  available: true,
  state: 'active',
  connected: true,
  providerId: 'p1',
  disclosureVersion: 1,
  disclosureCurrent: true,
  claimUrl: mintResponse.claim_url,
  addCreditUrl: null,
  topUpUrl: mintResponse.claim_url,
  claimState: mintResponse.claim_state,
  balanceMicros: mintResponse.balance_micros,
  starterRemainingMicros: mintResponse.starter_micros,
  starterGrantMicros: mintResponse.starter_micros,
  creditError: null,
  ctaSeen: false,
  week: { usedMicros: null, budgetMicros: null, resetsAt: null },
  lastError: null,
  ...over,
});

const noop = async () => undefined;

const render = (status: PublikStatus) =>
  renderToStaticMarkup(
    <PublikCard status={status} busy={false} onAction={noop} />,
  );

const unescape = (html: string) =>
  html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe('PublikCard right after provisioning', () => {
  it('(a) balance line, (b) justification, (c) primary CTA — in that order, from the response', () => {
    const html = unescape(render(afterMint()));

    const balance = html.indexOf('$0.25 of free starter usage');
    const why = html.indexOf(WHY_IT_COSTS);
    const cta = html.indexOf('Link this computer & pick a plan');
    expect(balance).toBeGreaterThan(-1);
    expect(why).toBeGreaterThan(balance);
    expect(cta).toBeGreaterThan(why);
  });

  it('the CTA is a link to the response claim_url, opened outside the app', () => {
    const html = unescape(render(afterMint()));
    expect(html).toMatch(
      /<a[^>]*data-testid="publik-plan-cta"[^>]*href="https:\/\/publikhq\.com\/claim\/HK7F-2QWD"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    );
  });

  it('the amount follows the response, never a constant', () => {
    const html = render(
      afterMint({ starterRemainingMicros: 500000, balanceMicros: 500000 }),
    );
    expect(html).toContain('$0.50 of free starter usage');
    expect(html).not.toContain('$0.25');
  });

  it('a claim_url off publikhq.com is dropped from the markup', () => {
    const html = unescape(
      render(
        afterMint({
          claimUrl: 'https://publikhq.com.evil.example/claim/HK7F-2QWD',
          topUpUrl: 'https://publikhq.com.evil.example/claim/HK7F-2QWD',
        }),
      ),
    );
    expect(html).not.toContain('evil.example');
    expect(html).toMatch(
      /data-testid="publik-plan-cta"[^>]*href="https:\/\/publikhq\.com\/dashboard\/api"/,
    );
  });

  it('offers "Later" until the CTA has been acknowledged, and keeps the primary button after', () => {
    const first = render(afterMint());
    expect(first).toMatch(/<button[^>]*>[^<]*Later<\/button>/);
    expect(first).toContain('Link this computer &amp; pick a plan');

    const later = render(afterMint({ ctaSeen: true }));
    expect(later).not.toMatch(/<button[^>]*>[^<]*Later<\/button>/);
    expect(later).toContain('Link this computer &amp; pick a plan');
    /* the justification collapses into the toggle, it does not disappear */
    expect(later).toContain('Why it costs money');
  });

  it('already claimed on the mint → "Manage plan" to the dashboard', () => {
    const html = render(afterMint({ claimState: 'claimed' }));
    expect(html).toContain('Manage plan');
    expect(html).toMatch(
      /data-testid="publik-plan-cta"[^>]*href="https:\/\/publikhq\.com\/dashboard\/api"/,
    );
    expect(html).not.toContain('Link this computer');
  });

  it('the pending face (before the mint) still shows the disclosure and "Continue with publik API"', () => {
    const html = render(
      afterMint({
        state: 'pending',
        connected: false,
        providerId: null,
        claimUrl: null,
        topUpUrl: null,
        balanceMicros: null,
        starterRemainingMicros: null,
        starterGrantMicros: null,
      }),
    );
    expect(html).toContain('Continue with publik API');
    expect(html).toContain('Use my own key instead');
    expect(html).not.toContain('data-testid="publik-plan-cta"');
  });

  it('copy rule: "publik API", dollars, no "credits", no vendor name', () => {
    const html = unescape(render(afterMint()));
    expect(html).toContain('publik API');
    expect(html).not.toMatch(/\bcredits?\b/i);
    expect(html).not.toMatch(/OpenAI|ChatGPT|Anthropic/);
    expect(html).not.toMatch(/token/i);
  });
});

describe('PublikBannerView', () => {
  it('renders the response message and exactly one link (top_up_url)', () => {
    const banner = bannerFor(
      afterMint({
        creditError: {
          message:
            'Not enough publik credit for this request. Link this computer and pick a plan at the link below, or use your own key.',
          topUpUrl: 'https://publikhq.com/claim/HK7F-2QWD',
        },
      }),
    )!;
    const html = unescape(renderToStaticMarkup(<PublikBannerView banner={banner} />));
    expect(html).toContain(banner.message);
    expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(html).toMatch(/href="https:\/\/publikhq\.com\/claim\/HK7F-2QWD"/);
  });

  it('low starter: the amount left from the wallet, one link', () => {
    const banner = bannerFor(
      afterMint({ starterRemainingMicros: 30000, balanceMicros: 30000 }),
    )!;
    const html = unescape(renderToStaticMarkup(<PublikBannerView banner={banner} />));
    expect(html).toContain('$0.03 of free starter usage left.');
    expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(html).toContain('Link this computer & pick a plan');
  });
});
