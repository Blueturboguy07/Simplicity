import {
  resolvePricingKey,
  estimateCostUSD,
  FREE_PROVIDER_TYPES,
} from './table';

/* One meter per turn. Every LLM call attached to it pushes a raw record;
   aggregation groups by providerId + model so parallel calls (council
   members, widgets running alongside the writer — see SPEC 2) never race a
   shared "current phase" flag. Keeping that grouping key stable is also what
   lets a later council orchestrator share this exact meter across all of its
   member + chair calls and still get a clean per-model breakdown. */

export type LLMUsage = {
  providerType: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

export type UsageBreakdownEntry = {
  label: string; // friendly name (catalog row name) or model key
  model: string;
  providerId: string;
  /* Not in the original spec sketch — added so the UI can resolve a
     ProviderLogo without re-deriving provider type from providerId. */
  providerType: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null; // null = unpriced/free
  free: boolean;
};

export type UsageSummary = {
  totalCost: number; // sum of priced entries only
  breakdown: UsageBreakdownEntry[];
  free: boolean; // true when NO priced entry contributed cost
};

type Group = UsageBreakdownEntry & { cachedInputTokens: number };

export class UsageMeter {
  private records: LLMUsage[] = [];

  /** Optional: resolves a friendly label (e.g. a catalog row name) for a
   *  record; falls back to the raw model key when it returns nothing. */
  constructor(private labeler?: (u: LLMUsage) => string) {}

  record(u: LLMUsage) {
    this.records.push(u);
  }

  summarize(): UsageSummary {
    const groups = new Map<string, Group>();

    for (const r of this.records) {
      const key = `${r.providerId}::${r.model}`;
      const isFree = FREE_PROVIDER_TYPES.has(r.providerType);

      const g: Group =
        groups.get(key) ??
        ({
          label: this.labeler?.(r) || r.model,
          model: r.model,
          providerId: r.providerId,
          providerType: r.providerType,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cost: isFree ? null : 0,
          free: isFree,
        } satisfies Group);

      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.cachedInputTokens += r.cachedInputTokens ?? 0;

      if (!isFree) {
        const pricingKey = resolvePricingKey(r.providerType, r.model);
        g.cost = estimateCostUSD(pricingKey, {
          inputTokens: g.inputTokens,
          outputTokens: g.outputTokens,
          cachedInputTokens: g.cachedInputTokens,
        });
      }

      groups.set(key, g);
    }

    const breakdown: UsageBreakdownEntry[] = [...groups.values()].map(
      ({ cachedInputTokens, ...entry }) => entry,
    );
    const totalCost = breakdown.reduce((sum, e) => sum + (e.cost ?? 0), 0);
    const free = breakdown.every(
      (e) => e.free || e.cost == null || e.cost === 0,
    );

    return { totalCost, breakdown, free };
  }
}
