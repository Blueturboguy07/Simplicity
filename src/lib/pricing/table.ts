// Prices are USD per 1,000,000 tokens. Seed/fallback values verified mid-2026
// against official pricing pages + LiteLLM model_prices_and_context_window.json
// (commit 2026-07-21).
//
// OPTIONAL LiteLLM SYNC (do NOT fetch live per-request — it's a ~1.6MB file):
//   Vendor a pinned copy of
//   https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
//   at build time and a weekly job that diffs it into this map, keeping this
//   object as last-known-good fallback + manual-override for same-day launches
//   and independently-confirmed numbers (e.g. Groq gpt-oss-120b output = $0.60,
//   not the stale $0.75 some secondary sources list). LiteLLM costs are
//   PER-TOKEN — multiply by 1_000_000 to match this table. Its keys are
//   provider-prefixed for non-first-party routes (groq/openai/gpt-oss-120b,
//   gemini/gemini-2.5-flash) — reuse resolvePricingKey() below as the mapper.

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number; // cache-read (hit) rate
  cacheWritePerMTok?: number; // Anthropic-style cache-write premium
  unconfirmed?: boolean;
  notes?: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-5.1': {
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 0.125,
    notes:
      'Retired from ChatGPT UI 2026-03-11; still API-served; off OpenAI main pricing page.',
  },
  'gpt-5-mini': {
    inputPerMTok: 0.25,
    outputPerMTok: 2.0,
    cachedInputPerMTok: 0.025,
  },
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 1.25,
  },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.075,
  },

  // Anthropic
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    notes:
      'INTRO pricing through 2026-08-31; reverts to $3.00/$15.00 (read $0.30, write $3.75) after.',
  },
  'claude-opus-4-8': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },

  // Google Gemini
  'gemini-2.5-pro': {
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 0.125,
    notes:
      'Above 200K ctx: input $2.50 / output $15.00 / cache $0.25, + $4.50/1M/hr storage.',
  },
  'gemini-2.5-flash': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cachedInputPerMTok: 0.03,
    notes: 'Audio input $1.00/1M. Cache storage $1.00/1M/hr.',
  },

  // Groq (OpenAI open-weight)
  'groq/openai/gpt-oss-120b': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.075,
  },
  'groq/openai/gpt-oss-20b': {
    inputPerMTok: 0.075,
    outputPerMTok: 0.3,
    cachedInputPerMTok: 0.0375,
  },

  // xAI  (grok-4 / grok-4.1 DEPRECATED 2026-05-15, RETIRE 2026-08-15 → auto-bill as grok-4.3 after)
  'grok-4': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    unconfirmed: true,
    notes:
      'No published cache rate. Retires 2026-08-15; calls then redirect+bill as grok-4.3.',
  },
  'grok-4.1-fast': {
    inputPerMTok: 0.2,
    outputPerMTok: 0.5,
    cachedInputPerMTok: 0.05,
    notes:
      'Only *-fast-reasoning/*-fast-non-reasoning exist; same price. Same deprecation as grok-4.',
  },
  'grok-4.3': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cachedInputPerMTok: 0.2,
    notes:
      'Current xAI flagship; replacement for grok-4 / grok-4.1 post-2026-08-15.',
  },
};

/* publik API — served models behind the three tier aliases, at the
   provider's published list price (CONTRACT §2, R24 §5; Sol is a
   promotional list through 2026-11-21), and the alias rows the meter
   actually resolves to, charged at PUBLIK_PRICE_FACTOR × list. The gateway
   settles from its own ledger; this keeps the in-app estimate within
   rounding of the real charge. */
export const PUBLIK_PRICE_FACTOR = 0.5;

const PUBLIK_SERVED: Record<string, ModelPricing> = {
  'gpt-5.6-luna': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.02,
    notes: 'Served behind publik-fast.',
  },
  'gpt-5.6-terra': {
    inputPerMTok: 2.0,
    outputPerMTok: 12.0,
    cachedInputPerMTok: 0.2,
    notes: 'Served behind publik-balanced.',
  },
  'gpt-5.6-sol': {
    inputPerMTok: 4.0,
    outputPerMTok: 20.0,
    cachedInputPerMTok: 0.4,
    notes: 'Served behind publik-smart. Promotional list through 2026-11-21.',
  },
};

export const PUBLIK_ALIAS_SERVED: Record<string, string> = {
  'publik-fast': 'gpt-5.6-luna',
  'publik-balanced': 'gpt-5.6-terra',
  'publik-smart': 'gpt-5.6-sol',
};

const publikRow = (alias: string): ModelPricing => {
  const p = PUBLIK_SERVED[PUBLIK_ALIAS_SERVED[alias]];
  return {
    inputPerMTok: p.inputPerMTok * PUBLIK_PRICE_FACTOR,
    outputPerMTok: p.outputPerMTok * PUBLIK_PRICE_FACTOR,
    cachedInputPerMTok:
      p.cachedInputPerMTok === undefined
        ? undefined
        : p.cachedInputPerMTok * PUBLIK_PRICE_FACTOR,
    notes: `publik alias; charged at ${PUBLIK_PRICE_FACTOR * 100}% of list.`,
  };
};

Object.assign(MODEL_PRICING, PUBLIK_SERVED, {
  'publik/publik-fast': publikRow('publik-fast'),
  'publik/publik-balanced': publikRow('publik-balanced'),
  'publik/publik-smart': publikRow('publik-smart'),
});

/** Provider TYPES whose calls are never metered to the user. */
export const FREE_PROVIDER_TYPES = new Set([
  'ollama',
  'claudecode',
  'lmstudio',
  'lemonade',
  'transformers',
]);

/**
 * Normalize a (providerType, catalog model key) pair to a MODEL_PRICING key.
 * Mirrors the catalog's actual keys (catalog.ts): gemini keys carry a
 * 'models/' prefix; grok-4.1 is the bare catalog key but prices under -fast.
 */
export function resolvePricingKey(
  providerType: string,
  modelKey: string,
): string | null {
  if (FREE_PROVIDER_TYPES.has(providerType)) return null;
  switch (providerType) {
    case 'openai':
    case 'anthropic':
      return modelKey; // gpt-5.1, claude-sonnet-5
    case 'gemini':
      return modelKey.replace(/^models\//, ''); // models/gemini-2.5-pro → gemini-2.5-pro
    case 'groq':
      return `groq/${modelKey}`; // openai/gpt-oss-120b → groq/openai/gpt-oss-120b
    case 'xai':
      if (modelKey === 'grok-4.1') return 'grok-4.1-fast';
      return modelKey; // grok-4, grok-4.3
    case 'publik':
      /* alias → the halved row; an unknown alias (a renamed tier from the
         install response) still prices if it maps to a served model */
      return `publik/${modelKey}`;
    default:
      return modelKey; // unknown → try exact, may miss → null cost
  }
}

/** Returns USD cost, or null when the model key is unpriced (caller shows Free/—). */
export function estimateCostUSD(
  pricingKey: string | null,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  },
): number | null {
  if (!pricingKey) return null;
  const p = MODEL_PRICING[pricingKey];
  if (!p) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  return (
    (uncachedInput / 1e6) * p.inputPerMTok +
    (cached / 1e6) * (p.cachedInputPerMTok ?? p.inputPerMTok) +
    (usage.outputTokens / 1e6) * p.outputPerMTok
  );
}
