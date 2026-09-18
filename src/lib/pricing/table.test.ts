import { describe, expect, it } from 'vitest';
import {
  estimateCostUSD,
  resolvePricingKey,
  FREE_PROVIDER_TYPES,
  MODEL_PRICING,
  PUBLIK_ALIAS_SERVED,
  PUBLIK_PRICE_FACTOR,
} from './table';

/* Pins the pricing math the cost meter depends on: resolvePricingKey's
   per-provider key mapping (gemini's 'models/' prefix strip, groq's
   provider-prefixing, xai's grok-4.1 → grok-4.1-fast rename, free providers
   short-circuiting to null) and estimateCostUSD's known-value arithmetic
   (uncached vs. cached input split, unpriced/free → null). */

describe('resolvePricingKey', () => {
  it('passes openai and anthropic keys through unchanged', () => {
    expect(resolvePricingKey('openai', 'gpt-5.1')).toBe('gpt-5.1');
    expect(resolvePricingKey('anthropic', 'claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    );
  });

  it('strips the catalog\'s "models/" prefix for gemini', () => {
    expect(resolvePricingKey('gemini', 'models/gemini-2.5-pro')).toBe(
      'gemini-2.5-pro',
    );
  });

  it('leaves a gemini key with no prefix untouched', () => {
    expect(resolvePricingKey('gemini', 'gemini-2.5-flash')).toBe(
      'gemini-2.5-flash',
    );
  });

  it('prefixes groq keys with groq/ to match the pricing table', () => {
    expect(resolvePricingKey('groq', 'openai/gpt-oss-120b')).toBe(
      'groq/openai/gpt-oss-120b',
    );
    expect(resolvePricingKey('groq', 'openai/gpt-oss-20b')).toBe(
      'groq/openai/gpt-oss-20b',
    );
  });

  it('reroutes xai\'s bare "grok-4.1" catalog key onto the priced -fast SKU', () => {
    expect(resolvePricingKey('xai', 'grok-4.1')).toBe('grok-4.1-fast');
  });

  it('passes other xai keys through unchanged', () => {
    expect(resolvePricingKey('xai', 'grok-4')).toBe('grok-4');
    expect(resolvePricingKey('xai', 'grok-4.3')).toBe('grok-4.3');
  });

  it('returns null for every free provider type, regardless of model key', () => {
    for (const providerType of FREE_PROVIDER_TYPES) {
      expect(resolvePricingKey(providerType, 'some-model')).toBeNull();
    }
  });

  it('falls back to the bare model key for an unrecognized provider type', () => {
    expect(resolvePricingKey('mystery-provider', 'some-model')).toBe(
      'some-model',
    );
  });
});

describe('estimateCostUSD', () => {
  it('returns null when the pricing key is null (free provider)', () => {
    expect(
      estimateCostUSD(null, { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull();
  });

  it('returns null when the pricing key has no entry in the table', () => {
    expect(
      estimateCostUSD('not-a-real-model', {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeNull();
  });

  it('computes a known-value case with no caching (gpt-5.1)', () => {
    // 1M input @ $1.25/M + 1M output @ $10.00/M = $11.25
    const cost = estimateCostUSD('gpt-5.1', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(11.25, 10);
  });

  it('splits cached vs. uncached input at the cached rate (gpt-4o-mini)', () => {
    // 2M input tokens, 1M of them cached, 500K output.
    // uncached 1M @ $0.15/M = $0.15
    // cached   1M @ $0.075/M = $0.075
    // output 500K @ $0.6/M = $0.30
    // total = $0.525
    const cost = estimateCostUSD('gpt-4o-mini', {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(0.525, 10);
  });

  it('falls back to the uncached input rate when a model publishes no cached rate', () => {
    // grok-4 has no cachedInputPerMTok — cached tokens must still bill at the
    // regular input rate rather than silently being priced at 0.
    const p = MODEL_PRICING['grok-4'];
    expect(p.cachedInputPerMTok).toBeUndefined();

    const cost = estimateCostUSD('grok-4', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    });
    // All 1M input tokens (cached + uncached) bill at $3.00/M since there's
    // no discounted cache rate to apply.
    expect(cost).toBeCloseTo(3.0, 10);
  });

  it('computes a known-value case for a groq-prefixed key', () => {
    // 500K input @ $0.15/M + 200K output @ $0.60/M = $0.075 + $0.12 = $0.195
    const cost = estimateCostUSD('groq/openai/gpt-oss-120b', {
      inputTokens: 500_000,
      outputTokens: 200_000,
    });
    expect(cost).toBeCloseTo(0.195, 10);
  });

  it('returns 0 for a zero-usage call against a priced model', () => {
    const cost = estimateCostUSD('gpt-5.1', {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('never lets cached tokens exceed input tokens produce a negative uncached remainder', () => {
    // A defensively malformed usage report (cached > input) must not go
    // negative and inflate/deflate the bill in surprising ways.
    const cost = estimateCostUSD('gpt-5.1', {
      inputTokens: 100,
      cachedInputTokens: 1000,
      outputTokens: 0,
    });
    // uncachedInput clamps to 0, so only the (inflated) cached portion bills
    // at the cached rate.
    expect(cost).toBeCloseTo((1000 / 1e6) * 0.125, 10);
  });
});

describe('publik API pricing', () => {
  it('maps a publik alias onto its own priced row, and publik is never Free', () => {
    expect(resolvePricingKey('publik', 'publik-balanced')).toBe(
      'publik/publik-balanced',
    );
    expect(FREE_PROVIDER_TYPES.has('publik')).toBe(false);
    for (const alias of Object.keys(PUBLIK_ALIAS_SERVED)) {
      expect(MODEL_PRICING[`publik/${alias}`]).toBeDefined();
      expect(MODEL_PRICING[PUBLIK_ALIAS_SERVED[alias]]).toBeDefined();
    }
  });

  it('charges exactly PUBLIK_PRICE_FACTOR × the served model list price for the same tokens', () => {
    expect(PUBLIK_PRICE_FACTOR).toBe(0.5);
    const usage = {
      inputTokens: 2_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 300_000,
    };
    for (const [alias, served] of Object.entries(PUBLIK_ALIAS_SERVED)) {
      const list = estimateCostUSD(served, usage)!;
      const charged = estimateCostUSD(
        resolvePricingKey('publik', alias),
        usage,
      )!;
      expect(list).toBeGreaterThan(0);
      expect(charged).toBeCloseTo(list * PUBLIK_PRICE_FACTOR, 10);
    }
  });

  it('known value: publik-balanced, 1M in + 1M out = half of $14.00', () => {
    const cost = estimateCostUSD('publik/publik-balanced', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(7.0, 10);
  });
});
