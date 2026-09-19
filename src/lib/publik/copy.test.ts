import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* The copy rule (CONTRACT §1 [S7], mirrored from the gateway's own
   copy-guard): everywhere a user can read it the provider is "publik API";
   the strings "OpenAI API access", "ChatGPT credits", "credits" as a unit
   and any per-token dollar figure are forbidden; money is dollars, never
   tokens; and (R25 S17) no placeholder hourly cost — the disclosure states
   the rate and the "under $2 a month" line only. Scoped to this patch's
   user-facing files, comments included, so nobody can sneak it back in a
   string literal built at runtime. */

const root = path.resolve(__dirname, '../../..');
const files = [
  'src/components/Setup/PublikCard.tsx',
  'src/components/Publik/PlanCta.tsx',
  'src/components/Publik/PublikBanner.tsx',
  'src/lib/publik/cta.ts',
  'src/components/Setup/ProviderPicker.tsx',
  'src/components/Settings/Sections/Models/ModelProvider.tsx',
  'src/components/Settings/Sections/Models/AddProviderDialog.tsx',
  'src/components/MessageRenderer/UsageLine.tsx',
  'src/app/api/publik/route.ts',
  'src/app/api/chat/route.ts',
  'src/lib/publik/types.ts',
  'src/lib/publik/provision.ts',
  'src/lib/publik/errors.ts',
  'src/lib/publik/balance.ts',
  'src/lib/publik/status.ts',
  'src/lib/models/providers/publik/index.ts',
  'src/lib/models/catalog.ts',
];

const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

/* Only the lines that mention publik are held to the vendor-naming rule —
   ProviderPicker and the chat route legitimately name the user's OWN
   providers ("Paid key from platform.openai.com") on other lines. */
const publikLines = (src: string) =>
  src.split('\n').filter((l) => /publik/i.test(l));

describe('publik copy rule', () => {
  it.each(files)(
    '%s never says "OpenAI API access" / "ChatGPT" / "credits" as a unit',
    (f) => {
      const src = read(f);
      expect(src).not.toMatch(/OpenAI API access/i);
      expect(src).not.toMatch(/ChatGPT/i);
      expect(src).not.toMatch(/\bcredits\b/i);
    },
  );

  it.each(files)(
    '%s shows no per-token dollar figure and no hourly cost',
    (f) => {
      const src = read(f);
      expect(src).not.toMatch(
        /\$\s?\d[\d.,]*\s*(per|\/|a|an)\s*(million|1M|M)?\s*tok/i,
      );
      expect(src).not.toMatch(/per\s+(million|1M|1,000,000)\s+tokens/i);
      expect(src).not.toMatch(/\$\s?\d[\d.,]*\s*(per|\/|a|an)\s*hour/i);
      expect(src).not.toMatch(/hour of (searching|use)/i);
    },
  );

  it.each(files)(
    '%s names the vendor behind publik nowhere near "publik"',
    (f) => {
      for (const line of publikLines(read(f))) {
        expect(line).not.toMatch(
          /\bOpenAI\b(?!LLM|Embedding|Provider|Config|Messages)/,
        );
      }
    },
  );

  it('the disclosure states the rate and the monthly line, and links the terms', () => {
    const card = read('src/components/Setup/PublikCard.tsx');
    expect(card).toMatch(
      /50% of the model(&apos;|')s published\s+list\s+price/,
    );
    expect(card).toMatch(/Most\s+people spend under \$2 a month/);
    expect(card).toMatch(/never trains on them/);
    expect(card).toMatch(/Use my own key instead/);
    expect(card).toMatch(/Continue with publik API/);
    expect(card).toMatch(/publik API terms/);
    expect(read('src/lib/publik/types.ts')).toMatch(/publikhq\.com\/terms#api/);
  });

  it('the provider is named exactly "publik API" wherever it is labelled', () => {
    expect(read('src/lib/models/providers/publik/index.ts')).toMatch(
      /name: 'publik API'/,
    );
    expect(read('src/lib/publik/provision.ts')).toMatch(
      /PUBLIK_PROVIDER_NAME = 'publik API'/,
    );
    expect(read('src/components/Setup/ProviderPicker.tsx')).not.toMatch(
      /Publik API|PUBLIK API/,
    );
  });

  it('the plan CTA (CONTRACT §12) carries the one justification and the exact labels', () => {
    const cta = read('src/lib/publik/cta.ts');
    expect(cta).toMatch(/A provider charges for every request the app makes/);
    expect(cta).toMatch(/passes it on at half the provider's list price/);
    expect(cta).toMatch(/Nothing is charged behind your back/);
    expect(cta).toMatch(/CTA_LINK_LABEL = 'Link this computer & pick a plan'/);
    expect(cta).toMatch(/CTA_PICK_LABEL = 'Pick a plan'/);
    expect(cta).toMatch(/CTA_MANAGE_LABEL = 'Manage plan'/);
    expect(cta).toMatch(/WHY_IT_COSTS_LABEL = 'Why it costs money'/);
    /* the amount is never in the copy: it comes from the response */
    expect(cta).not.toMatch(/\$0\.\d\d/);
    expect(read('src/components/Publik/PlanCta.tsx')).not.toMatch(/\$\d/);
  });

  it('the disclosure never hardcodes the free-balance amount', () => {
    const card = read('src/components/Setup/PublikCard.tsx');
    expect(card).not.toMatch(/first \$\d/i);
    expect(card).not.toMatch(/\$0\.(25|50) (is|on us|free)/i);
  });
});
