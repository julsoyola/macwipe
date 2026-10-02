const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__messages = [];
      window.webkit = { messageHandlers: { macwipeBridge: {
        postMessage(message) { window.__messages.push(message); },
      } } };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, "../website/dashboard.html")).href);
    assert.deepEqual(await page.evaluate(() => window.__messages), [{ action: "requestScan" }]);
    assert.equal(await page.locator(".demo-tag").textContent(), "Native · System Scan");
    assert.equal(await page.locator("#item-table-body input").count(), 0);
    const keys = ["caches", "downloads", "applications", "startup", "performance", "privacy"];
    const categories = Object.fromEntries(keys.map((category) => {
      const file = { id: `${category}:/fixture/${category}/file`, category,
        path: `/fixture/${category}/file`, name: `${category} file`,
        bytes: 1_000_000, formatted: "1 MB", canClean: true };
      return [category, { bytes: 1_000_000, eligibleBytes: 1_000_000,
        formatted: "1 MB", eligibleFormatted: "1 MB", canClean: true, items: [file] }];
    }));
    categories.storage = { ...categories.caches, items: [categories.caches.items[0], categories.downloads.items[0]] };
    const payload = { categories, sizeMeaning: "Logical file bytes." };
    await page.evaluate((value) => window.macwipeUI.receiveScanData(value), payload);
    await page.locator("#item-table-body input").first().check();
    await page.locator('button[data-category="caches"]').click();
    assert.equal(await page.locator("#item-table-body input").isChecked(), true);
    await page.locator("#item-table-body input").uncheck();
    await page.locator('button[data-category="storage"]').click();
    assert.equal(await page.locator("#item-table-body input").first().isChecked(), false);
    for (const key of keys) {
      await page.locator(`button[data-category="${key}"]`).click();
      assert.equal(await page.locator("#item-table-body input").isEnabled(), true);
      assert.equal(await page.locator("#item-table-body input").getAttribute("data-path"), `/fixture/${key}/file`);
      await page.locator("#item-table-body input").check();
    }
    assert.equal(await page.locator("#selection-status").textContent(), "Selected: 6 items · 6 MB");
    await page.locator("#btn-review-selected").click();
    assert.equal(await page.locator("#review-items-list li").count(), 6);
    await page.keyboard.press("Escape");
    assert.equal((await page.evaluate(() => window.__messages)).length, 1);
    const rejected = await page.evaluate(() => window.macwipeUI.delete([{ id: "privacy", paths: ["/forged"] }]));
    assert.equal(rejected, false);
    assert.equal((await page.evaluate(() => window.__messages)).length, 1);
    await page.locator("#btn-review-selected").click();
    await page.locator("#review-simulate-btn").click();
    assert.deepEqual((await page.evaluate(() => window.__messages)).at(-1), {
      action: "deleteFiles", categories: keys.map((id) => ({ id, paths: [`/fixture/${id}/file`] })),
    });
    await page.evaluate(() => window.macwipeUI.onCleanupComplete(5, { diskFreedMB: 0, errors: ["Fixture failure."] }));
    assert.equal(await page.locator("#review-dialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#review-total-size").textContent(), "0 MB");
    assert.match(await page.locator("#review-notice").textContent(), /Fixture failure/);
    const empty = { categories: Object.fromEntries(Object.keys(categories).map((key) => [key, { items: [], canClean: false }])), sizeMeaning: "Logical file bytes." };
    await page.evaluate((value) => window.macwipeUI.receiveScanData(value), empty);
    await page.keyboard.press("Escape");
    for (const key of ["storage", ...keys]) {
      await page.locator(`button[data-category="${key}"]`).click();
      assert.equal(await page.locator("#item-table-body input").count(), 0);
      assert.match(await page.locator("#item-table-body").textContent(), /No accessible eligible items/);
    }
    assert.equal(await page.locator("#selection-status").textContent(), "Selected: 0 items · 0 MB");
    assert.equal(await page.locator("#btn-review-selected").isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: every native tab, shared-row selection, exact file paths, deduplicated review, cancellation, rejected forged paths, completion errors, fresh empty scans, zero mock fallback, no JS errors.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
