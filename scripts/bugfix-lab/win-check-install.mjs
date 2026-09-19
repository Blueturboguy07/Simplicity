// Drives the real onboarding UI exactly as the reporter described: wait for
// "Choose a provider", click Install on the Ollama row, wait for it to settle,
// and repeat (ORACLE_CLICKS times -- "no matter how many times i click").
//
// It reports what it saw but makes NO verdict: the calling shell script decides
// from filesystem + port evidence outside the browser, so a UI that merely
// claims something cannot move the result.
//
// Prints one JSON line to stdout; always exits 0.
import { chromium } from 'playwright';

const url = process.env.ORACLE_URL || 'http://localhost:3131/';
const timeoutMs = Number(process.env.ORACLE_TIMEOUT_MS || 60000);
const wantClicks = Number(process.env.ORACLE_CLICKS || 3);

const result = {
  reachedProviderScreen: false,
  clicks: 0,
  sawProgressUI: false,
  buttonBack: false,
  connectedAfter: false,
  bannerText: null,
  toastText: null,
  error: null,
};

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('text=Choose a provider', { timeout: timeoutMs });
    result.reachedProviderScreen = true;

    // Anchor on the provider name cell (an exact-text <p> containing nothing
    // but "Ollama") and walk up to the row container. The row's *blurb* text
    // differs between the pre-fix and post-fix commits, so anchoring on the
    // blurb would silently mis-locate on one of them.
    const ollamaRow = page
      .getByText('Ollama', { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
    await ollamaRow.waitFor({ state: 'visible', timeout: timeoutMs });

    for (let i = 0; i < wantClicks; i++) {
      if (await ollamaRow.getByText('Connected').count().catch(() => 0)) break;

      const installButton = ollamaRow.getByRole('button', { name: /install/i }).first();
      const fallback = ollamaRow.locator('button').last();
      const target = (await installButton.count().catch(() => 0)) ? installButton : fallback;
      await target.waitFor({ state: 'visible', timeout: timeoutMs });
      await target.click();
      result.clicks += 1;

      // install() sets `progress` on click, which swaps the whole
      // select+button block for a percent bar -- the button element is removed
      // from the DOM, not relabeled. So "settled" = the button block is back
      // (install()'s finally{} cleared progress/loading), success or failure
      // alike. Grace period first so React can flush that state update, then
      // poll -- an instant failure costs ~1s, a real multi-gigabyte download
      // gets the whole budget (deliberately generous: "we waited 20 minutes
      // and nothing downloaded" is a stronger statement than "we waited 60
      // seconds", and this must not time out a genuine install and call it
      // a no-op).
      await page.waitForTimeout(800);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const bar = await ollamaRow.locator('div.rounded-full.bg-\\[\\#24A0ED\\]').count().catch(() => 0);
        // The idle Install button specifically -- not "any button": a failed
        // earlier click leaves a red banner in this same row whose Dismiss
        // button would otherwise read as "settled" while a real install is
        // still running.
        const idle = await ollamaRow.getByRole('button', { name: /install/i }).count().catch(() => 0);
        const conn = await ollamaRow.getByText('Connected').count().catch(() => 0);
        if (bar > 0 || idle === 0) result.sawProgressUI = true;
        if (conn > 0) break;
        if (idle > 0 && bar === 0) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1200);
    }

    result.buttonBack =
      (await ollamaRow.getByRole('button', { name: /install/i }).count().catch(() => 0)) > 0;
    result.connectedAfter =
      (await ollamaRow.getByText('Connected').count().catch(() => 0)) > 0;

    const banner = ollamaRow.locator('button[aria-label="Dismiss"]').first();
    if ((await banner.count().catch(() => 0)) > 0) {
      const bannerRoot = ollamaRow
        .locator('div')
        .filter({ has: page.locator('button[aria-label="Dismiss"]') })
        .last();
      result.bannerText = (await bannerRoot.innerText().catch(() => null))?.trim() ?? null;
    }
    const toasts = page.locator('[data-sonner-toast]');
    if ((await toasts.count().catch(() => 0)) > 0) {
      result.toastText = await toasts.first().innerText().catch(() => null);
    }
  } catch (err) {
    result.error = err?.message ?? String(err);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result));
})();
