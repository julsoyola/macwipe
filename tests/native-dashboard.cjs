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
    const fileMessages = () => page.evaluate(() => window.__messages.filter(message => message.action !== 'setMetricsVisible'));
    const nav = key => page.locator(`nav [data-category="${key}"]`);
    await page.goto(pathToFileURL(path.resolve(__dirname, "../website/dashboard.html")).href);
    assert.deepEqual(await fileMessages(), [{ action: "requestScan", requestID: 1 }]);
    assert.equal(await page.locator(".demo-tag").textContent(), "Native · System Scan");
    assert.equal(await page.locator("#home-view").isVisible(), true);
    assert.equal(await page.locator("#item-table-body input").count(), 0);
    assert.equal(await page.locator('#metric-example-label').isVisible(), false);
    const keys = ["caches", "downloads", "applications", "startup", "performance", "privacy"];
    const sharedFiles = [{ key: 'file:fixture:1', bytes: 1_000_000 }];
    const fixtures = Object.fromEntries(keys.map(category => {
      const readOnly = ['startup', 'performance'].includes(category);
      const file = { id: `${category}:/fixture/${category}/file`, category,
        path: category === 'applications' ? '/fixture/parent' : category === 'privacy' ? '/fixture/parent/data' : `/fixture/${category}/file`,
        name: category === 'performance' ? 'system.log' : `${category} file`,
        bytes: 1_000_000, formatted: '1 MB', canClean: !readOnly,
        kind: category === 'caches' ? 'cache' : category === 'downloads' ? 'older-download' : category === 'applications' ? 'application' : category === 'startup' ? 'startup-file' : 'log',
        reviewClassification: category === 'caches' ? 'temporary' : 'review-carefully',
        bulkSelectionEligible: category === 'caches', homeRecommendationEligible: ['caches', 'downloads'].includes(category),
        sharedFiles: ['caches', 'downloads'].includes(category) ? sharedFiles : [],
      };
      return [category, { bytes: 1_000_000, eligibleBytes: readOnly ? 0 : 1_000_000,
        measurementAvailable: true, canClean: !readOnly, items: [file] }];
    }));
    const unknown = { id: 'unknown', category: 'caches', path: '/fixture/caches/unknown', name: 'Unknown cache', bytes: 1_000_000,
      canClean: true, reviewClassification: 'temporary', bulkSelectionEligible: true, homeRecommendationEligible: true };
    fixtures.caches.items.push(unknown);
    fixtures.caches.bytes = fixtures.caches.eligibleBytes = 2_000_000;
    const categories = {};
    const storage = { volumeName: 'Fixture volume', totalBytes: 500_000_000_000, availableBytes: 200_000_000_000 };
    async function receive(scope, overrides = {}, automaticRequestID) {
      for (const key of scope) categories[key] = overrides[key] || fixtures[key];
      const requestID = automaticRequestID ?? (await fileMessages()).filter(message => message.action === 'requestScan').at(-1).requestID;
      await page.evaluate(value => window.macwipeUI.receiveScanData(value), { requestID, categories, refreshed: scope, storage, sizeMeaning: 'Logical file bytes.' });
    }
    await receive(['caches', 'downloads']);
    assert.match(await page.locator('[data-recommendation=caches] [data-recommendation-count]').textContent(), /^1 eligible item$/);
    for (const key of keys) {
      await nav(key).click();
      if (!categories[key]) {
        await page.waitForFunction(() => window.macwipeUI.isBusy);
        assert.deepEqual((await fileMessages()).at(-1).scope, [key]);
        await receive([key]);
      }
      assert.equal(await page.locator('nav [aria-current=page]').count(), 1);
      assert.equal(await page.locator('#home-view').isVisible(), false);
      assert.equal(await page.locator('#dashboard-heading').textContent(), key === 'applications' ? 'Apps' : key === 'performance' ? 'Logs' : key === 'privacy' ? 'Browser data' : key === 'startup' ? 'Startup' : key === 'caches' ? 'Caches' : 'Downloads');
      const boxes = page.locator('#item-table-body input');
      const readOnly = ['startup', 'performance'].includes(key);
      assert.equal(await boxes.first().isDisabled(), readOnly);
      assert.equal(await boxes.first().getAttribute('data-path'), fixtures[key].items[0].path);
      if (readOnly) {
        assert.equal(await page.locator('#item-table-body input:enabled').count(), 0);
        assert.equal(await page.locator('#btn-select-all').isVisible(), false);
      } else if (key === 'caches') {
        await page.locator('#btn-select-all').click();
        assert.equal(await page.locator('input[data-item=unknown]').isChecked(), false);
        await page.locator('input[data-item=unknown]').check();
      } else await boxes.first().check();
    }
    await nav('caches').click();
    assert.equal(await page.locator('input[data-item=unknown]').isChecked(), true);
    assert.equal(await page.locator('#selection-status').textContent(), 'Selected: 4 items · 3 MB');
    await page.locator('#btn-review-selected').click();
    assert.equal(await page.locator('#review-items-list li').count(), 4);
    assert.equal(await page.locator('#review-total-size').textContent(), '3 MB');
    const beforeCancel = (await fileMessages()).length;
    await page.keyboard.press('Escape');
    assert.equal((await fileMessages()).length, beforeCancel);
    assert.equal(await page.locator('#selection-status').textContent(), 'Selected: 4 items · 3 MB');
    const rejected = await page.evaluate(() => window.macwipeUI.delete([{ id: 'privacy', paths: ['/forged'] }]));
    assert.equal(rejected, false);
    assert.equal((await fileMessages()).length, beforeCancel);
    await page.locator('#btn-review-selected').click();
    await page.locator('#review-simulate-btn').click();
    assert.deepEqual((await fileMessages()).at(-1), { action: 'deleteFiles', categories: [
      { id: 'caches', paths: fixtures.caches.items.map(item => item.path) },
      ...['downloads', 'applications', 'privacy'].map(id => ({ id, paths: [fixtures[id].items[0].path] })),
    ] });
    await page.evaluate(() => window.macwipeUI.onCleanupComplete(0, { movedBytes: 0, movedCount: 0, diskFreedMB: 0, errors: ['Fixture failure.'], failures: [{ path: '/fixture/bad', message: 'Fixture failure.' }] }));
    assert.equal(await page.locator('#review-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#review-total-size').textContent(), '0 bytes');
    assert.match(await page.locator('#review-notice').textContent(), /Fixture failure/);
    assert.match(await page.locator('#cleanup-failures').textContent(), /bad: Fixture failure/);
    const empty = Object.fromEntries(keys.map(key => [key, { bytes: 0, eligibleBytes: 0, measurementAvailable: true, items: [], canClean: false }]));
    // Cleanup rescan is initiated by native and uses reserved request ID 0.
    await receive(keys, empty, 0);
    await page.keyboard.press('Escape');
    for (const key of keys) {
      await nav(key).click();
      assert.equal(await page.locator('#item-table-body input').count(), 0);
      assert.match(await page.locator('#item-table-body').textContent(), /No accessible eligible items/);
    }
    assert.equal(await page.locator('#selection-status').textContent(), 'Selected: 0 items · 0 bytes');
    assert.equal(await page.locator('#btn-review-selected').isDisabled(), true);
    await page.locator('nav [data-view=home]').click();
    assert.equal(await page.locator('#home-view').isVisible(), true);
    assert.equal(await page.locator('[data-recommendation]:visible').count(), 2);
    await page.locator('#btn-home-rescan').click();
    const request = (await fileMessages()).at(-1);
    assert.equal(request.action, 'requestScan');
    await page.evaluate(requestID => window.macwipeUI.onScanProgress({ requestID, category: 'caches', processedCount: 123 }), request.requestID);
    assert.match(await page.locator('#scan-status').textContent(), /123 entries processed/);
    await page.locator('#btn-cancel-scan').click();
    assert.deepEqual((await fileMessages()).at(-1), { action: 'cancelScan', requestID: request.requestID });
    await page.evaluate(requestID => window.macwipeUI.receiveScanData({ requestID, categories: {}, refreshed: ['caches', 'downloads'], cancelled: true }), request.requestID);
    assert.match(await page.locator('#scan-explanation').textContent(), /Scan cancelled/);
    assert.equal(await page.locator('#btn-home-rescan').isEnabled(), true);
    await page.locator('#btn-home-rescan').click();
    await page.evaluate(() => window.macwipeUI.onNativeError({ action: 'requestScan', message: 'Fixture scan failure.' }));
    assert.match(await page.locator('#scan-status').textContent(), /Fixture scan failure/);
    assert.equal(await page.locator('#btn-home-rescan').isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: scoped native scans/request IDs, exclusive Home navigation, read-only Startup/system logs, unknown metadata excluded from bulk, shared-file/overlap totals, selection/review, cancellation, forged-path rejection, cleanup/scan errors, empty cards, and no demo fallback; native calls mocked.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
