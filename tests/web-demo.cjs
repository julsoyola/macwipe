const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const website = path.resolve(__dirname, "../website");
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "macwipe-browser-"));
const base = pathToFileURL(website + path.sep).href;
const answers = {
  data: "Nothing ever leaves your Mac. Everything processes 100% locally in your browser or local app environment without external servers or network requests.",
  local:
    "Yes. It only scans local directories on your computer that you explicitly choose to review.",
  safe: "Yes. macwipe focuses on temporary caches, stale downloads, and unneeded junk, giving you full preview control before anything is touched.",
};
const stamp = /^\[\d{1,2}:\d{2} (AM|PM)\]$/;
(async () => {
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(() => {
    window.__appActivity = { listeners: 0, timers: 0 };
    const fromApp = () => new Error().stack.includes("/website/scripts/");
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (...args) {
      if (fromApp()) window.__appActivity.listeners += 1;
      return add.apply(this, args);
    };
    for (const name of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
      const original = window[name];
      window[name] = function (...args) {
        if (fromApp()) window.__appActivity.timers += 1;
        return original.apply(this, args);
      };
    }
  });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(base + "index.html");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.locator(".download-control").getAttribute("href"),
    "downloads/macwipe-macos.zip",
  );
  assert.equal(
    await page.locator(".download-control").getAttribute("download"),
    "macwipe-macos.zip",
  );
  assert.equal(
    await page.locator(".demo-link").getAttribute("href"),
    "dashboard.html",
  );
  assert.equal(
    await page
      .locator("main")
      .evaluate((el) => getComputedStyle(el).borderTopWidth),
    "2px",
  );
  assert.equal(
    await page
      .locator("main")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 246, 236)",
  );
  assert.equal(
    await page.locator("main").evaluate((el) => getComputedStyle(el).boxShadow),
    "rgb(84, 43, 69) 4px 4px 0px 0px",
  );
  assert.equal(
    await page
      .locator(".demo-link")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(255, 255, 255)",
  );
  const button = page.locator('[data-question="data"]');
  await button.hover();
  await page.mouse.down();
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el).transform),
    "matrix(1, 0, 0, 1, 1, 1)",
  );
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el).boxShadow),
    "rgb(84, 43, 69) 2px 2px 0px 0px",
  );
  await page.mouse.up();
  await page.keyboard.press("Escape");
  for (const [key, answer] of Object.entries(answers)) {
    const trigger = page.locator(`[data-question="${key}"]`);
    await trigger.focus();
    await page.keyboard.press("Enter");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(
      await page.locator("#question-chat").evaluate((el) => el.open),
      true,
    );
    assert.equal(await page.locator("#chat-answer").textContent(), answer);
    for (const time of await page
      .locator("#question-chat .message-time")
      .allTextContents())
      assert.match(time, stamp);
    assert.equal(
      await page.locator("#question-chat input").isDisabled(),
      false,
    );
    assert.equal(
      await page.locator("#question-chat input").getAttribute("placeholder"),
      "Type a question...",
    );
    assert.equal(
      await page
        .locator("#question-chat .sender-you")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(164, 72, 117)",
    );
    assert.equal(
      await page
        .locator("#question-chat .chat-menu")
        .evaluate((el) => getComputedStyle(el).fontSize),
      "11px",
    );
    await page.locator("#question-chat .chat-menu").click();
    assert.equal(
      await page.locator("#question-chat").evaluate((el) => el.open),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () =>
          document.activeElement === document.body ||
          document
            .querySelector("#question-chat")
            .contains(document.activeElement),
      ),
      true,
    );
    if (key === "data") await page.locator("#chat-close").click();
    else if (key === "local") await page.mouse.click(4, 4);
    else await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#question-chat").evaluate((el) => el.open),
      false,
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-question]")].every(
        (el) => el.getAttribute("aria-expanded") === "false",
      ),
    );
    assert.equal(
      await trigger.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  await page.screenshot({
    path: path.join(artifacts, "landing-desktop.png"),
    fullPage: true,
  });
  await button.click();
  assert.equal(await page.locator("#chat-title").textContent(), "mac-chat");
  assert.equal(await page.locator(".supporting, .buddy-version").count(), 0);
  assert.equal(
    await page.locator("#question-chat .chat-avatar img").count(),
    1,
  );
  assert.equal(
    await page.locator("#question-chat button[type=submit]").isEnabled(),
    true,
  );
  assert.equal(
    await page
      .locator("#question-chat .chat-toolbar")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 246, 236)",
  );
  assert.ok(
    await page
      .locator("#question-chat .chat-toolbar")
      .evaluate((el) => el.getBoundingClientRect().height <= 36),
  );
  assert.doesNotMatch(
    await page.locator("#question-chat").textContent(),
    /Expressions/,
  );
  const input = page.locator("#question-chat input");
  const messages = page.locator("#question-chat .chat-transcript p");
  await input.fill("   ");
  await input.press("Enter");
  assert.equal(await messages.count(), 2);
  const beforeTime = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date()),
  );
  await input.fill("hello");
  await page.locator("#question-chat button[type=submit]").click();
  const afterTime = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date()),
  );
  assert.equal(await messages.count(), 3);
  assert.ok(
    [`[${beforeTime}] you: hello`, `[${afterTime}] you: hello`].includes(
      await messages.last().textContent(),
    ),
  );
  assert.equal(await input.inputValue(), "");
  const literal = '<img src=x onerror="window.bad=true">';
  await input.fill(literal);
  await input.press("Enter");
  assert.ok((await messages.last().textContent()).endsWith(literal));
  assert.equal(
    await page.locator("#question-chat .chat-transcript img").count(),
    0,
  );
  await page.evaluate(() => {
    const form = document.querySelector("#question-chat form");
    const input = form.querySelector("input");
    for (let index = 0; index < 25; index += 1) {
      input.value = `local message ${index}`;
      form.requestSubmit();
    }
  });
  assert.equal(await messages.count(), 29);
  assert.equal(
    await page
      .locator("#question-chat .chat-transcript")
      .evaluate(
        (el) =>
          el.scrollTop > 0 &&
          Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1,
      ),
    true,
  );
  const chatListeners = await page.evaluate(
    () => window.__appActivity.listeners,
  );
  await page.keyboard.press("Escape");
  await button.click();
  assert.equal(await messages.count(), 2);
  assert.equal(
    await page.evaluate(() => window.__appActivity.listeners),
    chatListeners,
  );
  await page.screenshot({
    path: path.join(artifacts, "chat-desktop.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.locator(".demo-link").click();
  for (const key of [
    "storage",
    "caches",
    "downloads",
    "applications",
    "startup",
    "performance",
    "privacy",
  ]) {
    await page.locator(`[data-category="${key}"]`).click();
    assert.equal(await page.locator("#item-table-body tr").count(), 3);
    assert.equal(await page.locator('[aria-current="page"]').count(), 1);
    assert.equal(
      await page
        .locator(
          '#content-pane [role="alert"], #demo-feedback, [class*="banner"]',
        )
        .count(),
      0,
    );
    assert.doesNotMatch(
      await page.locator("#content-pane").textContent(),
      /examples loaded|Preview complete|Simulation complete/,
    );
    await page.locator("#item-table-body input").first().check();
    const selection = await page.locator("#selection-status").textContent();
    await page.locator("#btn-preview-scan").click();
    assert.equal(
      await page.locator("#selection-status").textContent(),
      selection,
    );
    assert.equal(
      await page.locator("#item-table-body input").first().isChecked(),
      true,
    );
    await page.locator("#item-table-body button").first().click();
    assert.equal(
      await page.locator("#details-dialog .chat-sidebar").count(),
      1,
    );
    assert.match(
      await page.locator("#details-dialog .message-time").first().textContent(),
      stamp,
    );
    await page.mouse.click(4, 4);
    assert.equal(
      await page.locator("#details-dialog").evaluate((el) => el.open),
      false,
    );
    await page.locator("#item-table-body input").first().uncheck();
  }
  await page.locator('[data-category="storage"]').click();
  await page.locator("#btn-select-all").click();
  assert.equal(
    await page.locator("#selection-status").textContent(),
    "Selected: 3 items · 2,240 MB",
  );
  await page.locator("#btn-select-all").click();
  assert.equal(
    await page.locator("#selection-status").textContent(),
    "Selected: 0 items · 0 MB",
  );
  await page.locator("#item-table-body input").first().check();
  await page.locator('[data-category="caches"]').click();
  await page.locator("#btn-select-all").click();
  assert.equal(
    await page.locator("#selection-status").textContent(),
    "Selected: 4 items · 1,685 MB",
  );
  await page.locator("#btn-review-selected").click();
  assert.equal(await page.locator("#review-items-list li").count(), 4);
  assert.equal(
    await page.locator("#review-total-size").textContent(),
    "1,685 MB",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#selection-status").textContent(),
    "Selected: 4 items · 1,685 MB",
  );
  await page.locator("#btn-review-selected").click();
  await page.locator("#review-simulate-btn").click();
  assert.equal(
    await page.locator("#selection-status").textContent(),
    "Selected: 0 items · 0 MB",
  );
  assert.equal(await page.locator("#btn-review-selected").isDisabled(), true);
  assert.equal(
    await page
      .locator("#btn-preview-scan")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-desktop.png"),
    fullPage: true,
  });
  await page.locator('[data-category="storage"]').click();
  const listenersBefore = await page.evaluate(
    () => window.__appActivity.listeners,
  );
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#item-table-body tr")];
    const body = document.querySelector("#item-table-body");
    let replacements = 0;
    const observer = new MutationObserver((records) => {
      replacements += records.length;
    });
    observer.observe(body, { childList: true });
    document.querySelector("#btn-select-all").click();
    document.querySelector("#btn-preview-scan").click();
    document.querySelector("#btn-select-all").click();
    window.__rowCheck = {
      rows,
      observer,
      get replacements() {
        return replacements;
      },
    };
  });
  assert.equal(await page.evaluate(() => window.__rowCheck.replacements), 0);
  await page.evaluate(() => {
    window.__rowCheck.observer.disconnect();
    const buttons = [...document.querySelectorAll("[data-category]")];
    for (let index = 0; index < 100; index += 1)
      buttons[index % buttons.length].click();
    buttons[0].click();
  });
  assert.equal(
    await page.evaluate(() =>
      window.__rowCheck.rows.every(
        (row, index) =>
          row === document.querySelector("#item-table-body").children[index],
      ),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.__appActivity.listeners),
    listenersBefore,
  );
  assert.equal(await page.evaluate(() => window.__appActivity.timers), 0);
  await page.evaluate(() => {
    window.__idleMutations = 0;
    window.__idleObserver = new MutationObserver((records) => {
      window.__idleMutations += records.length;
    });
    window.__idleObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await page.evaluate(() => window.__idleMutations), 0);
  await page.evaluate(() => window.__idleObserver.disconnect());
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const file of ["index.html", "dashboard.html"]) {
      await page.goto(base + file);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${file}: page overflow at ${width}`,
      );
      if (file === "index.html")
        await page.locator('[data-question="safe"]').click();
      else await page.locator("#item-table-body button").first().click();
      const dialog = page.locator("dialog[open]");
      const box = await dialog.boundingBox();
      assert.ok(
        box.x >= 0 && box.x + box.width <= width,
        `modal width ${width}`,
      );
      assert.ok(
        box.y >= 0 && box.y + box.height <= 850,
        `modal height ${width}`,
      );
      assert.equal(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
        `modal overflow ${width}`,
      );
      if (width === 375)
        await page.screenshot({
          path: path.join(artifacts, `${file.split(".")[0]}-mobile.png`),
          fullPage: true,
        });
      await page.keyboard.press("Escape");
    }
  }
  for (const file of fs
    .readdirSync(website)
    .filter((file) => file.endsWith(".html"))) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(website, file), "utf8"),
      /simulation-banner|demo-feedback|examples loaded/,
    );
  }
  for (const file of ["index_2.html", "dashboard_2.html"]) {
    await page.goto(base + file);
    await page.waitForURL(base + file.replace("_2", ""));
  }
  for (const directory of [
    website,
    path.join(website, "scripts"),
    path.join(website, "styles"),
  ]) {
    for (const file of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, file);
      if (fs.statSync(fullPath).isFile())
        assert.doesNotMatch(
          fs.readFileSync(fullPath, "utf8"),
          /\p{Extended_Pictographic}/u,
        );
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  await browser.close();
  console.log(
    "PASS: exact FAQ copy, timestamps, chat styling, close/button/backdrop/Escape, focus return, palette/borders/shadows/active state, all categories, no banners, preview selection preservation, totals/review/simulation, four viewports, no JS errors or network requests.",
  );
  console.log(
    "PASS: stable row identity, zero table replacements for selection/preview, fixed listener count across 100 category switches, zero app timers or idle DOM mutations, legacy redirects.",
  );
  console.log(
    "PASS: mac-chat title, SVG icons, no emojis/sidebar version/subtext, compact cream toolbar, Send/Enter, local timestamps, plain-text messages, blank rejection, automatic scroll, no listener growth on reopen.",
  );
  console.log(`Screenshots: ${artifacts}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
