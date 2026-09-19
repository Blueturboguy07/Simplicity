// Drives the real onboarding UI in a headless browser: waits for the
// "Choose a provider" screen, clicks Install on the Ollama row, waits for
// the request to settle, and reports whether the failure was surfaced
// (inline banner and/or toast) or silent (button just reverts to idle).
//
// Prints one JSON line to stdout. Exit code is always 0 from this script;
// oracle.sh interprets the JSON and decides the oracle's own exit code.
import { chromium } from 'playwright';

const url = process.env.ORACLE_URL || 'http://localhost:3131/';
const timeoutMs = Number(process.env.ORACLE_TIMEOUT_MS || 45000);

const result = {
  ok: false,
  reachedProviderScreen: false,
  clickedInstall: false,
  buttonReverted: false,
  bannerPresent: false,
  bannerText: null,
  toastPresent: false,
  toastText: null,
  error: null,
};

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // The wizard runs a scripted 2500ms + 600ms + 1500ms sequence of timers
    // before the provider step (setupState 2) mounts. Wait for its heading.
    await page.waitForSelector('text=Choose a provider', { timeout: timeoutMs });
    result.reachedProviderScreen = true;

    // The Ollama row, located by its blurb text (stable regardless of the
    // button's own state) and walked up to the row's own container so the
    // button can be re-found after its accessible name changes (it becomes
    // an unlabeled spinner icon while loading -- a name-based locator would
    // stop matching anything the instant the click lands).
    const ollamaRow = page
      .locator('p', { hasText: 'Free — runs on your computer' })
      .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
    await ollamaRow.waitFor({ state: 'visible', timeout: timeoutMs });
    const installButton = ollamaRow.locator('button').first();
    await installButton.waitFor({ state: 'visible', timeout: timeoutMs });

    await installButton.click();
    result.clickedInstall = true;

    // The instant the click lands, install() sets `progress`, which swaps
    // the whole select+button block for a percent bar (see ProviderPicker) --
    // the button element itself is removed from the DOM, not just relabeled.
    // Give React a moment to flush that state update before polling for it.
    await page.waitForTimeout(300);

    // Wait for the button to come back (install()'s `finally` clears
    // `progress`/`loading`, which restores it) -- that is "settled",
    // success or failure alike. Poll rather than a fixed sleep so a fast
    // failure doesn't cost the full budget and a slow one still gets it.
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    while (Date.now() < deadline) {
      const buttonBack = await ollamaRow.locator('button').count().catch(() => 0);
      if (buttonBack > 0) {
        settled = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    result.buttonReverted = settled;

    // Inline banner: the red alert box ProviderPicker renders from
    // installError state (see the component's AlertCircle + dismiss button).
    // Scoped to the Ollama row -- the onboarding "What's an API key?" info
    // box (unrelated, always present) uses the same aria-label="Dismiss" on
    // its own close button, so an unscoped query would false-positive on it.
    const banner = ollamaRow.locator('button[aria-label="Dismiss"]').first();
    const bannerCount = await banner.count().catch(() => 0);
    if (bannerCount > 0) {
      result.bannerPresent = true;
      const bannerRoot = ollamaRow
        .locator('div')
        .filter({ has: page.locator('button[aria-label="Dismiss"]') })
        .last();
      result.bannerText = (await bannerRoot.innerText().catch(() => null))?.trim() ?? null;
    }

    // Toast: sonner renders into [data-sonner-toaster], each toast has
    // [data-sonner-toast]. It auto-dismisses after a few seconds, so this
    // is a best-effort snapshot taken right after the button settles.
    const toastCount = await page
      .locator('[data-sonner-toast]')
      .count()
      .catch(() => 0);
    if (toastCount > 0) {
      result.toastPresent = true;
      result.toastText = await page
        .locator('[data-sonner-toast]')
        .first()
        .innerText()
        .catch(() => null);
    }

    result.ok = true;
  } catch (err) {
    result.error = err?.message ?? String(err);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result));
})();
