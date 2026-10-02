(() => {
  "use strict";
  // Safe if also included by a script tag in dashboard.html.
  // Native UI hooks: data-macwipe-action="scan|keep|delete" on buttons;
  // data-category="caches|logs|downloads|applications|startup|performance|privacy" on selection checkboxes;
  // data-macwipe-size="caches|logs|trash|downloads" on size labels;
  // data-macwipe-status on a status element (prefer role="status").
  // CustomEvents macwipe:scan/cleanup/keep/error expose the full results.
  if (window.macwipeUI) return;

  const allowedCategories = new Set([
    "caches", "logs", "downloads", "applications", "startup", "performance", "privacy",
  ]);
  let pendingAction = null;
  let lastScan = null;
  let requestSequence = 0;
  let activeScanID = null;
  const disabledButtons = new Set();
  const controlSelector = [
    '[data-action="preview"]',
    '#btn-explorer-scan',
    '[data-explorer-id]',
    '#btn-finder',
    '#btn-keep-item',
    '[data-macwipe-action="scan"]',
    '[data-macwipe-action="keep"]',
    '[data-macwipe-action="delete"]',
    '[data-action="scan"]',
    '[data-action="keep"]',
    '[data-action="delete"]',
    "#keep-files-btn",
    "#delete-files-btn",
    "#btn-keep-files",
    "#btn-delete-files",
    "#btn-delete-macwipe",
    "#delete-macwipe-confirm",
    "#delete-macwipe-keep",
  ].join(",");

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(`macwipe:${name}`, { detail }));
  }

  function showStatus(message) {
    const status = document.querySelector("[data-macwipe-status]");
    if (status) status.textContent = message;
  }

  function setPending(action) {
    pendingAction = action;
    if (action) {
      document.querySelectorAll(controlSelector).forEach((button) => {
        if (!button.disabled) {
          button.disabled = true;
          disabledButtons.add(button);
        }
      });
    } else {
      disabledButtons.forEach((button) => { button.disabled = false; });
      disabledButtons.clear();
    }
    emit("busy", { action });
  }

  function post(action, extra = {}) {
    if (pendingAction) return false;
    const handler = window.webkit?.messageHandlers?.macwipeBridge;
    if (!handler || typeof handler.postMessage !== "function") {
      ui.onNativeError({ action, message: "Open this dashboard in the native macwipe app." });
      return false;
    }
    setPending(action);
    try {
      handler.postMessage({ action, ...extra });
      return true;
    } catch {
      ui.onNativeError({ action, message: "The native bridge is unavailable." });
      return false;
    }
  }

  function selectedCategories() {
    // Category checkboxes: <input type="checkbox" data-category="caches">
    // Optional data-path selects one of receiveScanData(...).categories[id].items.
    const grouped = new Map();
    document.querySelectorAll('input[type="checkbox"][data-category]:checked')
      .forEach((checkbox) => {
        if (checkbox.disabled) return;
        const id = checkbox.dataset.category;
        if (!allowedCategories.has(id)) return;
        if (!checkbox.dataset.path) grouped.set(id, null);
        else if (!grouped.has(id)) grouped.set(id, [checkbox.dataset.path]);
        else if (grouped.get(id) !== null) grouped.get(id).push(checkbox.dataset.path);
      });
    return Array.from(grouped, ([id, paths]) =>
      paths === null ? id : { id, paths: [...new Set(paths)] });
  }

  function postScan(action, extra = {}) {
    if (pendingAction) return false;
    activeScanID = ++requestSequence;
    if (!post(action, { ...extra, requestID: activeScanID })) { activeScanID = null; return false; }
    return true;
  }
  function acceptScan(payload) {
    if (payload.requestID != null && payload.requestID !== activeScanID) return false;
    activeScanID = null;
    setPending(null);
    if (payload.cancelled || payload.status === "cancelled") {
      for (const id of payload.refreshed || []) {
        if (lastScan?.categories[id]) lastScan.categories[id].canClean = false;
      }
      emit("cancelled", payload);
      return false;
    }
    return true;
  }

  const ui = {
    get isBusy() { return pendingAction !== null; },

    removeApplication() {
      return post("removeApplication");
    },

    scan(scope) {
      return postScan("requestScan", scope ? { scope } : {});
    },

    showInFinder(id) { return post("showInFinder", { id }); },
    setKept(id, kept) { return post("setKept", { id, kept }); },
    openLoginItems() { return post("openLoginItems"); },
    openStorageSettings() { return post("openStorageSettings"); },
    openActivityMonitor() { return post("openActivityMonitor"); },
    receiveMetrics(payload) { emit("metrics", payload); },
    metricsVisible(visible) {
      window.webkit?.messageHandlers?.macwipeBridge?.postMessage({ action: "setMetricsVisible", visible });
    },
    explore(id) { return postScan("requestExplorer", id ? { id } : {}); },
    receiveExplorerData(payload) { if (acceptScan(payload)) emit("explorer", payload); },
    cancelScan() {
      if (activeScanID === null || !["requestScan", "requestExplorer"].includes(pendingAction)) return false;
      window.webkit.messageHandlers.macwipeBridge.postMessage({ action: "cancelScan", requestID: activeScanID });
      return true;
    },
    onScanProgress(payload) { if (payload.requestID === activeScanID) emit("progress", payload); },
    onActionComplete(result) {
      setPending(null);
      showStatus(result.message);
      emit("action", result);
    },

    keep() {
      return post("keepFiles");
    },

    delete(categories = selectedCategories()) {
      if (pendingAction) return false;
      const valid = Array.isArray(categories) && categories.length > 0
        && categories.every((entry) => {
          const id = typeof entry === "string" ? entry : entry?.id;
          const scan = lastScan?.categories?.[id];
          if (!allowedCategories.has(id) || !scan?.canClean) return false;
          if (typeof entry === "string") return true;
          return Array.isArray(entry.paths) && entry.paths.length > 0
            && entry.paths.every((path) => scan.items.some((item) => item.path === path && item.canClean === true));
        });
      if (!valid) {
        ui.onNativeError({ action: "deleteFiles", message: "Scan and select eligible items first." });
        return false;
      }
      if (!post("deleteFiles", { categories })) return false;
      lastScan = null;
      return true;
    },

    receiveScanData(payload) {
      if (!acceptScan(payload)) return false;
      lastScan = payload;
      setPending(null);
      for (const [id, category] of Object.entries(payload.categories)) {
        document.querySelectorAll(`[data-macwipe-size="${id}"]`).forEach((element) => {
          element.textContent = category.error ? "Unavailable / incomplete" : category.formatted;
        });
        document.querySelectorAll(`[data-macwipe-eligible-size="${id}"]`).forEach((element) => {
          element.textContent = category.eligibleFormatted;
        });
        // A fresh scan requires a fresh selection; stale paths are never retained.
        if (payload.refreshed && !payload.refreshed.includes(id)) continue;
        document.querySelectorAll(`input[type="checkbox"][data-category="${id}"]`)
          .forEach((checkbox) => {
            checkbox.checked = false;
            checkbox.disabled = !category.items.some((item) =>
              item.path === checkbox.dataset.path && item.canClean === true);
          });
      }
      const incomplete = Object.values(payload.categories).some((category) => category.error);
      showStatus(incomplete ? "Scan finished with unavailable or incomplete categories." : "Scan complete.");
      emit("scan", payload);
      return true;
    },

    onCleanupComplete(freedMB, result = {}) {
      // Native automatically rescans. This number means MB moved to Trash.
      activeScanID = 0;
      setPending("requestScan");
      const movedMB = Number.isFinite(freedMB) ? Math.max(0, freedMB) : 0;
      const errors = Array.isArray(result.errors) ? result.errors : [];
      showStatus(`Moved ${movedMB.toFixed(1)} MB to Trash. Available-space change has not been measured.`
        + (errors.length ? ` ${errors.length} item(s) could not be moved.` : ""));
      emit("cleanup", { ...result, movedMB, diskFreedMB: 0, errors });
    },

    onKeepConfirmed() {
      setPending(null);
      showStatus("Files kept. No files were changed.");
      emit("keep", {});
    },

    onNativeError(error) {
      activeScanID = null;
      setPending(null);
      showStatus(error.message);
      emit("error", error);
    },
  };

  window.macwipeUI = ui;
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const explicit = button.dataset.macwipeAction || button.dataset.action;
    const label = button.textContent.replace(/[\[\]]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
    let action = button.matches(controlSelector) ? explicit : null;
    if (button.matches("#keep-files-btn, #btn-keep-files") || label === "keep files") action = "keep";
    if (button.matches("#delete-files-btn, #btn-delete-files") || label === "delete files") action = "delete";
    if (!["scan", "keep", "delete"].includes(action)) return;
    event.preventDefault();
    if (action === "scan") ui.scan();
    else if (action === "keep") ui.keep();
    else ui.delete();
  });
})();
