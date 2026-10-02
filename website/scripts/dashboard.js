(() => {
  "use strict";

  const isNative = !!window.webkit?.messageHandlers?.macwipeBridge;
  document.body.classList.toggle("native-mode", isNative);
  let demoKept = new Set();
  if (!isNative) {
    try { demoKept = new Set(JSON.parse(localStorage.getItem("macwipe.demo.keptIDs") || "[]")); } catch {}
  }

  function itemMetadata(item) {
    const temporary = item.kind === "cache" && item.reviewClassification === "temporary";
    const classified = typeof item.kind === "string" && item.kind !== "unknown"
      && ["temporary", "review-carefully"].includes(item.reviewClassification);
    return {
      kind: item.kind || "unknown",
      reviewClassification: item.kind === "cache" && item.reviewClassification === "temporary"
        ? "temporary" : "review-carefully",
      bulkSelectionEligible: temporary && item.bulkSelectionEligible === true,
      homeRecommendationEligible: classified && item.homeRecommendationEligible === true,
      explanation: item.explanation || "",
      ownerName: item.ownerName || null,
    };
  }

  function uniqueItems(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  const categories = isNative
    ? Object.fromEntries(
        Object.entries(MacwipeData).map(([key, category]) => [
          key,
          {
            title: category.title,
            description: "Actual files scanned from system paths",
            items: [],
          },
        ]),
      )
    : Object.fromEntries(Object.entries(MacwipeData).map(([key, category]) => [
        key,
        { ...category, items: uniqueItems(category.items).map((item, originalScanIndex) => ({
          ...item, ...itemMetadata(item), originalScanIndex,
          kept: demoKept.has(item.id),
          originalCanClean: item.canClean !== false,
          canClean: item.canClean !== false && !demoKept.has(item.id),
          bytes: !item.info && Number.isFinite(item.mb) && item.mb >= 0
            ? item.mb * 1_000_000 : null,
        })) },
      ]));

  const { formatMB, createChat } = MacwipeUI;
  let allItems = uniqueItems(Object.values(categories).flatMap(
    (category) => category.items || [],
  ));
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const selected = new Set();
  const cachedRows = new Map();
  const categorySort = new Map();
  const checkboxById = new Map();
  let currentCategory = null;
  let detailsItem = null;
  let selectedMB = 0;
  let selectedSizeLabel = formatMB(0);
  let hasCompletedScan = false;

  // Resolve persistent DOM nodes once; event handlers reuse these references.
  const tableBody = document.querySelector("#item-table-body");
  const fileList = document.querySelector("#file-list");
  const navButtons = document.querySelectorAll(
    "nav [data-category], nav [data-view]",
  );
  const homeView = document.querySelector("#home-view");
  const categoryControls = document.querySelectorAll("[data-category-controls]");
  const categoryTitles = {
    applications: "Apps",
    performance: "Logs",
    privacy: "Browser data",
  };
  const heading = document.querySelector("#dashboard-heading");
  const description = document.querySelector("#category-description");
  const caption = document.querySelector("#list-caption");
  const selectionStatus = document.querySelector("#selection-status");
  const selectAllButton = document.querySelector("#btn-select-all");
  const sortButton = document.querySelector("#btn-sort-size");
  const reviewButton = document.querySelector("#btn-review-selected");
  const previewButton = document.querySelector("#btn-preview-scan");
  const reviewDialog = document.querySelector("#review-dialog");
  const reviewList = document.querySelector("#review-items-list");
  const reviewTotal = document.querySelector("#review-total-size");
  const previewNote = document.querySelector(".preview-note");
  const reviewIntro = reviewDialog.querySelector(".dialog-body > p");
  const reviewNotice = document.querySelector("#review-notice");
  const confirmButton = document.querySelector("#review-simulate-btn");
  const openDetails = createChat(document.querySelector("#details-dialog"));
  const scanStatus = document.querySelector("#scan-status");
  const scanUpdated = document.querySelector("#scan-updated");
  const scanUpdatedTime = document.querySelector("#scan-updated-time");
  const scanButtons = document.querySelectorAll('[data-action="preview"]');
  const deleteButton = document.querySelector("#btn-delete-macwipe");
  const deleteDialog = document.querySelector("#delete-macwipe-dialog");
  const deleteConfirm = document.querySelector("#delete-macwipe-confirm");
  const deleteNotice = document.querySelector("#delete-macwipe-notice");
  deleteDialog.addEventListener("close", () => deleteButton.focus());

  function renderHomeRecommendations(state = "ready") {
    document.querySelectorAll("[data-recommendation]").forEach((card) => {
      const key = card.dataset.recommendation;
      const count = card.querySelector("[data-recommendation-count]");
      const size = card.querySelector("[data-recommendation-size]");
      const button = card.querySelector("button");
      if (state !== "ready" && state !== "partial") {
        if (state === "loading") {
          count.textContent = isNative
            ? "Waiting for scan results."
            : "Refreshing example items…";
        } else {
          count.textContent = state === "error"
            ? "Recommendations are unavailable. Try Rescan."
            : "Recommendations are not available yet.";
        }
        size.textContent = "";
        button.disabled = true;
        return;
      }
      const category = categories[key];
      if (isNative && !category.available) {
        count.textContent = "Recommendations are unavailable for this category.";
        size.textContent = "";
        button.disabled = true;
        return;
      }
      let items = category.items.filter(
        (item) => item.kind !== "unmatched-support"
          && !item.kept
          && item.homeRecommendationEligible
          && (isNative
            ? item.canClean === true
            : item.canClean !== false && (key !== "downloads"
              || Number.isFinite(item.modifiedAt) && item.modifiedAt < Date.now() / 1000 - 30 * 86400)),
      );
      items = uniqueItems(items);
      if (isNative) {
        items = [...new Map(items.map((item) => [item.path, item])).values()];
      }
      const partial = isNative && (category.error || category.skippedPaths > 0);
      count.textContent = items.length
        ? `${items.length} eligible ${isNative ? "" : "example "}${items.length === 1 ? "item" : "items"}`
        : isNative ? "No eligible items found in accessible results."
          : "No eligible example items.";
      if (partial) {
        if (!items.length) count.textContent = "No eligible items returned in partial results.";
        count.textContent += " · Partial scan";
      }
      const known = items.filter((item) => Number.isFinite(item.bytes));
      const amount = known.reduce(
        (sum, item) => sum + item.bytes, 0,
      );
      const formatted = isNative
        ? amount < 1_000_000 ? `${amount.toLocaleString("en-US")} bytes`
          : formatMB(amount / 1_000_000)
        : formatMB(amount / 1_000_000);
      size.textContent = items.length && !known.length
        ? "Size unavailable"
        : !items.length && partial ? "Size unavailable"
          : `${formatted} available for review${known.length < items.length ? " · Some sizes unavailable" : ""}`;
      button.disabled = items.length === 0;
    });
  }

  function setScanState(state, message) {
    scanStatus.textContent = message;
    scanButtons.forEach((button) => {
      button.disabled = state === "loading";
    });
    if (isNative) deleteConfirm.disabled = state === "loading" || window.macwipeUI.isBusy;
    const completed = state === "ready" || state === "empty" || state === "partial";
    if (completed) hasCompletedScan = true;
    scanButtons.forEach((button) => {
      button.textContent = hasCompletedScan ? "Rescan" : "Scan";
    });
    scanUpdated.hidden = !completed;
    if (completed) {
      const now = new Date();
      scanUpdatedTime.dateTime = now.toISOString();
      scanUpdatedTime.textContent = now.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    renderHomeRecommendations(state === "empty" ? "ready" : state);
  }

  function refreshDemo(isRefresh = true) {
    setScanState("loading", "Demo · Refreshing example data…");
    try {
      renderHomeStorage(window.MacwipeDemoStorage);
      refreshSelection();
      setScanState(
        "ready",
        `Demo · Example data ${isRefresh ? "refreshed" : "loaded"}. No files are read or changed.`,
      );
    } catch {
      renderHomeStorage(null);
      setScanState("error", "Demo · Example data could not be refreshed. Try Rescan.");
    }
  }

  function renderHomeStorage(storage) {
    const overview = document.querySelector("#storage-overview");
    const unavailable = document.querySelector("#storage-unavailable");
    document.querySelector("#storage-size-note").hidden = !isNative;
    document.querySelector(".storage-disclosure").hidden = !isNative;
    if (storage && (
      !Number.isFinite(storage.totalBytes) || storage.totalBytes <= 0 ||
      !Number.isFinite(storage.availableBytes) || storage.availableBytes < 0 ||
      storage.availableBytes > storage.totalBytes ||
      typeof storage.volumeName !== "string" || !storage.volumeName.trim()
    )) {
      storage = null;
    }
    overview.hidden = !storage;
    unavailable.hidden = !!storage;
    if (!storage) return;

    const { totalBytes, availableBytes, volumeName } = storage;
    const usedBytes = totalBytes - availableBytes;
    const numberFormat = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
    });
    const formatGB = (bytes) =>
      `${numberFormat.format(bytes / 1_000_000_000)} GB`;
    const percent = Math.round((availableBytes / totalBytes) * 100);
    const chart = document.querySelector("#storage-chart");
    chart.setAttribute(
      "aria-label",
      `${volumeName}: ${formatGB(usedBytes)} used of ${formatGB(totalBytes)} total; ${formatGB(availableBytes)} available, ${percent}% of your disk.`,
    );
    document.querySelector("#storage-available").textContent =
      formatGB(availableBytes);
    document.querySelector("#storage-percent").textContent =
      `${percent}% of your disk`;
    document.querySelector("#storage-volume").textContent = volumeName;
    document.querySelector("#storage-usage").textContent =
      `${formatGB(usedBytes)} used / ${formatGB(totalBytes)} total`;

    const segments = [
      ...(isNative
        ? [{ label: "Used", bytes: usedBytes, color: "#a4527b" }]
        : storage.segments),
      { label: "Available", bytes: availableBytes, color: "#eadfe3" },
    ];
    const rings = document.createDocumentFragment();
    const legend = document.createDocumentFragment();
    let offset = 0;
    segments.forEach((segment) => {
      const share = (segment.bytes / totalBytes) * 100;
      const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      for (const [name, value] of Object.entries({
        cx: 90,
        cy: 90,
        r: 80.5,
        fill: "none",
        stroke: segment.color,
        "stroke-width": 19,
        pathLength: 100,
        "stroke-dasharray": `${share} ${100 - share}`,
        "stroke-dashoffset": -offset,
        transform: "rotate(-90 90 90)",
      })) {
        arc.setAttribute(name, value);
      }
      rings.append(arc);
      offset += share;

      const entry = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "storage-swatch";
      swatch.style.backgroundColor = segment.color;
      swatch.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = `${segment.label} · ${formatGB(segment.bytes)}`;
      entry.append(swatch, label);
      legend.append(entry);
    });
    chart.replaceChildren(rings);
    document.querySelector("#storage-legend").replaceChildren(legend);
  }

  function updateSelection() {
    const count = selected.size;
    const items = [...selected].map((id) => itemById.get(id));
    const known = items.filter((item) => Number.isFinite(item.bytes));
    selectedMB = known.reduce((sum, item) => sum + item.bytes, 0) / 1_000_000;
    selectedSizeLabel = count && !known.length ? "Size unavailable"
      : `${formatMB(selectedMB)}${known.length < count ? " · Some sizes unavailable" : ""}`;
    const summary = `Selected: ${count} ${count === 1 ? "item" : "items"} · ${selectedSizeLabel}`;
    if (selectionStatus.textContent !== summary)
      selectionStatus.textContent = summary;
    reviewButton.disabled = count === 0;
    const selectableItems = bulkSelectableItems();
    const hasRemovableItems = categories[currentCategory]?.items.some((item) => item.canClean !== false);
    selectAllButton.hidden = selectableItems.length === 0;
    selectionStatus.closest("[data-category-controls]").hidden = !hasRemovableItems;
    selectAllButton.disabled = selectableItems.length === 0;
    const allChecked =
      selectableItems.length > 0 &&
      selectableItems.every((item) => selected.has(item.id));
    const label = allChecked ? "Deselect temporary files" : "Select all temporary files";
    if (selectAllButton.textContent !== label)
      selectAllButton.textContent = label;
  }

  function setSelected(item, checked) {
    if (item.canClean === false || item.kept) return;
    if (selected.has(item.id) !== checked) {
      if (checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    const checkbox = checkboxById.get(item.id);
    if (checkbox && checkbox.checked !== checked) checkbox.checked = checked;
  }

  function refreshSelection() {
    if (!categories[currentCategory] || !categories[currentCategory].items)
      return;
    categories[currentCategory].items.forEach((item) => {
      setSelected(item, selected.has(item.id));
    });
    updateSelection();
  }

  function createRow(item) {
    const unmatched = item.kind === "unmatched-support";
    const name = unmatched && item.path
      ? item.path.split("/").filter(Boolean).at(-1) : item.name;
    const row = document.createElement("tr");
    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = item.canClean === false;
    checkbox.dataset.item = item.id;
    if (isNative) {
      checkbox.dataset.category = item.category;
      if (item.path) checkbox.dataset.path = item.path;
    }
    checkbox.setAttribute("aria-label", `Select ${name}`);
    checkboxById.set(item.id, checkbox);
    selectCell.append(checkbox);

    const nameCell = document.createElement("td");
    nameCell.textContent = name;
    if (item.kind === "older-download") {
      const note = document.createElement("small");
      note.className = "item-review-label";
      note.textContent = "Not modified in over 30 days.";
      nameCell.append(note);
    }
    if (item.canClean === false) {
      const note = document.createElement("small");
      note.className = "item-review-label";
      note.textContent = item.kept ? "Kept" : "Read-only inventory";
      nameCell.append(note);
    }
    if (unmatched) {
      const warning = document.createElement("small");
      warning.className = "item-review-label";
      warning.textContent = "Unmatched support — review carefully";
      nameCell.append(warning);
    }
    const infoCell = document.createElement("td");
    infoCell.textContent = item.info || formatMB(item.mb);
    const detailsCell = document.createElement("td");
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "question-row";
    detailsButton.dataset.details = item.id;
    detailsButton.textContent = "Details";
    detailsButton.setAttribute("aria-label", `Details about ${name}`);
    detailsButton.setAttribute("aria-haspopup", "dialog");
    detailsButton.setAttribute("aria-controls", "details-dialog");
    detailsCell.append(detailsButton);
    row.append(selectCell, nameCell, infoCell, detailsCell);
    return row;
  }

  function itemDetails(item) {
    const explanations = {
      "unmatched-support": "No matching installed app was found. This does not prove the folder is unused. It may contain settings, mods, or personal data.",
      cache: "App data listed from a cache location. Apps may recreate these files. Close affected apps before cleanup.",
      "older-download": "A downloaded file listed because it was not modified in over 30 days. Modification time does not establish when it was downloaded or last opened; keep anything you still need.",
      application: "An application listed in an application folder. Moving it to Trash does not run its vendor uninstaller and may leave support files behind.",
      "startup-file": "Startup configuration listed for review. Removing it may affect future launches and does not stop an already running service.",
      log: "Diagnostic information listed from a log location. Removing it may discard information useful for troubleshooting.",
      "browser-data": "Local browser data listed for review. Removing it may affect history, sessions, or sign-in state.",
    };
    const explanation = (Object.hasOwn(explanations, item.kind) ? explanations[item.kind] : "")
      || (!isNative && item.details)
      || "An item listed for review. Its purpose is not established; removing it may affect app behavior or personal data.";
    const size = Number.isFinite(item.bytes) && item.bytes >= 0
      ? `${item.bytes.toLocaleString("en-US")} bytes`
      : !isNative && !item.info && Number.isFinite(item.mb) && item.mb >= 0
        ? formatMB(item.mb) : "Not available";
    return [
      !isNative ? "Demo example. No files are read or changed." : "",
      explanation,
      item.explanation || "",
      `Owner: ${item.ownerName || "Owner not identified."}`,
      item.kept ? "Kept. Reverse Keep this before selecting this item for removal. Allowing a kept descendant also reverses its covering folder exclusion. Allowing a folder also reverses exclusions inside it."
        : item.canClean === false ? "Read-only inventory. Cleanup is not available for this item." : "",
      item.path ? `Path: ${item.path}` : "",
      `Logical file size: ${size}`,
      Number.isFinite(item.modifiedAt) ? `Modified: ${new Date(item.modifiedAt * 1000).toLocaleString()}` : "",
      item.info ? `Size/Info: ${item.info}` : "",
    ].filter(Boolean).join("\n");
  }

  function switchCategory(key) {
    const isHome = key === "home";
    if (!isHome && !Object.hasOwn(categories, key)) return;
    currentCategory = key;
    document.querySelector("#startup-settings").hidden = key !== "startup";
    document.body.dataset.currentView = key;
    document.querySelectorAll("[data-home-control]").forEach((control) => { control.hidden = !isHome; });
    const category = isHome
      ? { title: "Home", description: "See your space. Choose what stays." }
      : categories[key];
    const title = categoryTitles[key] || category.title;
    document.title = `macwipe · ${title} · ${isNative ? "Native" : "Demo"}`;
    heading.textContent = isHome ? "Your Mac, a little lighter." : title;
    description.textContent = category.description;
    caption.textContent = `${title} items`;
    navButtons.forEach((button) => {
      button.removeAttribute("aria-current");
    });
    const activeButton = Array.from(navButtons).find(
      (button) => (button.dataset.view || button.dataset.category) === key,
    );
    activeButton?.setAttribute("aria-current", "page");
    homeView.hidden = !isHome;
    categoryControls.forEach((control) => {
      control.hidden = isHome;
    });
    if (isHome) {
      updateSelection();
      return;
    }

    renderCategoryList(key);
  }

  function renderCategoryList(key) {
    const category = categories[key];
    if (!cachedRows.has(key)) cachedRows.set(key, new Map());
    const rows = cachedRows.get(key);
    const items = [...new Map((category.items || []).map((item) => [item.id, item])).values()];
    const fragment = document.createDocumentFragment();
    const sort = categorySort.get(key) || "none";
    sortButton.closest("th").setAttribute("aria-sort", sort);
    const sortLabel = sort === "descending" ? "Largest first"
      : sort === "ascending" ? "Smallest first" : "Original scan order";
    sortButton.setAttribute("aria-label", `Size / Info: ${sortLabel}. Activate to change order.`);
    sortButton.querySelector("span").textContent = sort === "descending" ? "▼"
      : sort === "ascending" ? "▲" : "";
    const sections = [
      ["temporary", "Temporary files", "Temporary data. Review before removing; apps may recreate it."],
      ["review-carefully", "Review carefully", "These items may contain important data or affect app behavior."],
    ];
    for (const [classification, title, explanation] of sections) {
      const sectionItems = items.filter((item) => item.reviewClassification === classification);
      sectionItems.sort((a, b) => {
        if (sort === "none") return a.originalScanIndex - b.originalScanIndex;
        const aKnown = Number.isFinite(a.bytes);
        const bKnown = Number.isFinite(b.bytes);
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        const difference = aKnown ? a.bytes - b.bytes : 0;
        return (sort === "descending" ? -difference : difference)
          || a.originalScanIndex - b.originalScanIndex;
      });
      if (!sectionItems.length) continue;
      const section = document.createElement("tr");
      section.className = "risk-section";
      const cell = document.createElement("td");
      cell.colSpan = 4;
      const heading = document.createElement("h2");
      heading.textContent = title;
      const note = document.createElement("p");
      note.textContent = explanation;
      cell.append(heading, note);
      section.append(cell);
      fragment.append(section);
      for (const item of sectionItems) {
        if (!rows.has(item.id)) rows.set(item.id, createRow(item));
        fragment.append(rows.get(item.id));
      }
    }
    if (isNative && !category.items.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = !category.available
        ? "Scan results are unavailable for this category."
        : category.error || category.skippedPaths > 0
          ? "No eligible items returned. Some paths were skipped or unreadable; results are incomplete."
          : "No accessible eligible items found.";
      row.append(cell);
      fragment.append(row);
    }
    tableBody.replaceChildren(fragment);
    tableBody.querySelectorAll("input[data-item]").forEach((checkbox) => {
      checkboxById.set(checkbox.dataset.item, checkbox);
    });
    refreshSelection();
  }

  function bulkSelectableItems() {
    const cat = categories[currentCategory];
    return (cat?.items || []).filter(
      (item) => item.canClean !== false && item.bulkSelectionEligible
        && item.reviewClassification === "temporary"
        && item.kind !== "unmatched-support",
    );
  }

  function selectAll() {
    const items = bulkSelectableItems();
    const checked = !items.every((item) => selected.has(item.id));
    items.forEach((item) => setSelected(item, checked));
    updateSelection();
  }

  function review() {
    if (!selected.size) return;
    if (isNative) {
      reviewIntro.textContent = "Selected files for cleanup:";
      reviewNotice.textContent =
        "Selected files will be moved to Trash. Applications and support folders may contain personal data. Removing startup files does not stop running services. Close affected apps and browsers first.";
      confirmButton.hidden = false;
      confirmButton.style.display = "";
      confirmButton.textContent = "Move to Trash";
    }
    const items = allItems.filter((item) => selected.has(item.id));
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const entry = document.createElement("li");
      entry.textContent = `${item.name} · ${item.info || formatMB(item.mb)}`;
      fragment.append(entry);
    });
    reviewList.replaceChildren(fragment);
    reviewTotal.textContent = selectedSizeLabel;
    reviewDialog.showModal();
  }

  function scrollFiles(direction) {
    fileList.scrollBy({
      top: direction * fileList.clientHeight * 0.75,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }

  const actions = {
    "keep-item": () => {
      if (!detailsItem) return;
      if (isNative) {
        window.macwipeUI.setKept(detailsItem.id, !detailsItem.kept);
        return;
      }
      detailsItem.kept = !detailsItem.kept;
      if (detailsItem.kept) demoKept.add(detailsItem.id);
      else demoKept.delete(detailsItem.id);
      detailsItem.canClean = detailsItem.originalCanClean && !detailsItem.kept;
      selected.delete(detailsItem.id);
      try { localStorage.setItem("macwipe.demo.keptIDs", JSON.stringify([...demoKept])); } catch {}
      cachedRows.clear();
      checkboxById.clear();
      renderCategoryList(currentCategory);
      renderHomeRecommendations();
      showItemDetails(detailsItem);
    },
    "storage-settings": () => fixedAction("openStorageSettings", "Open System Settings → General → Storage."),
    "login-settings": () => fixedAction("openLoginItems", "Open System Settings → General → Login Items."),
    "show-finder": () => {
      if (!detailsItem) return;
      if (isNative) window.macwipeUI.showInFinder(detailsItem.id);
      else document.querySelector("#details-action-status").textContent = "Demo: Show in Finder simulated. No file opened.";
    },
    "delete-macwipe": () => {
      deleteNotice.textContent = isNative
        ? ""
        : "Demo only. No application will be removed.";
      deleteConfirm.disabled = isNative && (!window.macwipeUI.removeApplication || window.macwipeUI.isBusy);
      deleteDialog.showModal();
      document.querySelector("#delete-macwipe-keep").focus();
    },
    "confirm-delete-macwipe": () => {
      if (isNative) {
        if (window.macwipeUI.removeApplication() !== false) {
          deleteNotice.textContent = "Moving macwipe to Trash…";
          scanButtons.forEach((button) => { button.disabled = true; });
        }
        return;
      }
      deleteNotice.textContent = "Simulated completion. No application was removed.";
      deleteConfirm.disabled = true;
    },
    "sort-size": () => {
      const current = categorySort.get(currentCategory) || "none";
      categorySort.set(currentCategory, current === "none" ? "descending"
        : current === "descending" ? "ascending" : "none");
      renderCategoryList(currentCategory);
    },
    "scroll-up": () => scrollFiles(-1),
    "scroll-down": () => scrollFiles(1),
    preview: () => {
      if (isNative) {
        previewNote.textContent = "Scanning local files...";
        window.macwipeUI.scan();
      } else refreshDemo();
    },
    "select-all": selectAll,
    review,
    simulate: () => {
      if (isNative) {
        const grouped = new Map();
        selected.forEach((id) => {
          const item = itemById.get(id);
          if (!item) return;
          const catKey = item.category;
          if (!grouped.has(catKey)) grouped.set(catKey, []);
          grouped.get(catKey).push(item.path);
        });
        const selectedCategories = Array.from(grouped, ([id, paths]) => ({
          id,
          paths,
        }));
        if (window.macwipeUI.delete(selectedCategories) !== false)
          reviewDialog.close();
        return;
      }
      reviewDialog.close();
      selected.forEach((id) => setSelected(itemById.get(id), false));
      updateSelection();
      previewButton.focus();
    },
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.view) switchCategory(button.dataset.view);
    else if (button.dataset.category) switchCategory(button.dataset.category);
    else if (button.dataset.details) {
      const item = itemById.get(button.dataset.details);
      if (item) {
        showItemDetails(item);
      }
    } else if (Object.hasOwn(actions, button.dataset.action)) {
      actions[button.dataset.action]();
    }
  });

  tableBody.addEventListener("change", (event) => {
    const item = itemById.get(event.target.dataset.item);
    if (!item) return;
    setSelected(item, event.target.checked);
    updateSelection();
  });

  function fixedAction(method, manual) {
    if (isNative) window.macwipeUI[method]();
    else scanStatus.textContent = `Demo: settings action simulated. ${manual}`;
  }
  function showItemDetails(item) {
    detailsItem = item;
    document.querySelector("#btn-finder").hidden = false;
    const keep = document.querySelector("#btn-keep-item");
    keep.hidden = false;
    keep.textContent = item.kept ? "Allow recommendations again" : "Keep this";
    document.querySelector("#details-action-status").textContent = "";
    openDetails(`Tell me about ${item.name}.`, itemDetails(item));
  }
  for (const event of ["action", "error"]) window.addEventListener(`macwipe:${event}`, ({ detail }) => {
    if (["showInFinder", "openLoginItems", "openStorageSettings"].includes(detail.action)) {
      document.querySelector("#details-action-status").textContent = detail.message;
      previewNote.textContent = detail.message;
    }
  });

  if (isNative) {
    document.querySelector(".demo-tag").textContent = "Native · System Scan";
    previewNote.textContent = "Scanning local files...";
    fileList.setAttribute("aria-label", "Local scanned files");
    setScanState("waiting", "Native · Waiting for scan results.");

    const nativeUI = window.macwipeUI;
    const scan = nativeUI.scan;
    const deleteFiles = nativeUI.delete;
    const receiveScanData = nativeUI.receiveScanData;
    const onCleanupComplete = nativeUI.onCleanupComplete;

    nativeUI.scan = function () {
      const started = scan.call(this);
      if (started !== false) {
        setScanState("loading", "Native · Scanning local files…");
      }
      return started;
    };
    nativeUI.delete = function (...args) {
      const started = deleteFiles.apply(this, args);
      if (started !== false) {
        setScanState("loading", "Native · Moving selected files to Trash…");
      }
      return started;
    };
    window.addEventListener("macwipe:cleanup", () => {
      setScanState("loading", "Native · Waiting for cleanup rescan…");
    });

    nativeUI.receiveScanData = function (payload) {
      if (receiveScanData) receiveScanData.call(this, payload);
      renderHomeStorage(payload.storage ?? null);

      for (const [key, category] of Object.entries(categories)) {
        const source = payload.categories[key];
        category.available = !!source;
        category.error = source?.error;
        category.skippedPaths = source?.skippedPaths || 0;
        category.items = uniqueItems(source?.items || []).map((file, originalScanIndex) => ({
          ...itemMetadata(file),
          originalScanIndex,
          id: file.id,
          category: file.category,
          path: file.path,
          modifiedAt: file.modifiedAt,
          kept: file.kept === true,
          name: file.name,
          mb: Number.isFinite(file.bytes) && file.bytes >= 0 ? file.bytes / 1_000_000 : null,
          bytes: Number.isFinite(file.bytes) && file.bytes >= 0 ? file.bytes : null,
          info: Number.isFinite(file.bytes) && file.bytes >= 0
            ? file.formatted || formatMB(file.bytes / 1_000_000) : "Size unavailable",
          details: `${file.path}. ${payload.sizeMeaning || ""}`,
          canClean: file.canClean === true,
        }));
      }
      // Storage and category tabs can share a file; review each ID only once.
      allItems = [
        ...new Map(
          Object.values(categories).flatMap((category) =>
            category.items.map((item) => [item.id, item]),
          ),
        ).values(),
      ];

      itemById.clear();
      allItems.forEach((item) => itemById.set(item.id, item));
      if (detailsItem && document.querySelector("#details-dialog").open) {
        const current = itemById.get(detailsItem.id);
        if (current) showItemDetails(current);
        else document.querySelector("#details-dialog").close();
      }
      selected.clear();
      selectedMB = 0;
      cachedRows.clear();
      checkboxById.clear();
      const key = currentCategory;
      currentCategory = null;
      switchCategory(key || "home");

      const scanned = Object.entries(payload.categories)
        .filter(([key]) => key !== "storage").map(([, category]) => category);
      const skipped = scanned.reduce(
        (sum, category) => sum + (category.skippedPaths || 0), 0,
      );
      const incomplete = scanned.some((category) => category.error) || skipped > 0
        || Object.values(categories).some((category) => !category.available
          || category.items.some((item) => item.bytes === null));
      const hasItems = scanned.some((category) =>
        category.items.some((item) => item.canClean === true),
      );
      setScanState(
        incomplete ? "partial" : hasItems ? "ready" : "empty",
        incomplete
          ? `Native · Partial scan. ${skipped ? `${skipped} paths skipped or unavailable. ` : ""}Accessible results only; full access is not established.`
          : hasItems
            ? "Native · Scan finished. Accessible results only; full access is not established."
            : "Native · No eligible items found in accessible results; full access is not established.",
      );
      previewNote.textContent = scanStatus.textContent;
      if (reviewDialog.open && !confirmButton.hidden) reviewDialog.close();
    };

    nativeUI.onCleanupComplete = function (freedMB, result = {}) {
      if (onCleanupComplete) onCleanupComplete.call(this, freedMB, result);
      reviewIntro.textContent = "Cleanup finished. Logical size moved to Trash:";
      reviewList.replaceChildren();
      const movedMB = Number.isFinite(result.movedBytes) ? result.movedBytes / 1_000_000 : freedMB;
      reviewTotal.textContent = Number.isFinite(movedMB) ? formatMB(movedMB) : "Size unavailable";
      reviewNotice.textContent = "Available-space change has not been measured. Files in Trash still occupy space.";
      confirmButton.hidden = true;
      confirmButton.style.display = "none";
      if (!reviewDialog.open) reviewDialog.showModal();
      if (result.errors?.length)
        reviewNotice.textContent += ` ${result.errors.join(" ")}`;
      if (nativeUI.scan) nativeUI.scan();
    };
    window.addEventListener("macwipe:error", (event) => {
      if (event.detail.action === "removeApplication") {
        deleteNotice.textContent = event.detail.message;
        deleteConfirm.disabled = false;
        scanButtons.forEach((button) => { button.disabled = false; });
        if (!deleteDialog.open) deleteDialog.showModal();
        return;
      }
      previewNote.textContent = event.detail.message;
      setScanState("error", `Native · ${event.detail.message}`);
    });
  }

  if (isNative) renderHomeStorage(null);
  else refreshDemo(false);
  switchCategory("home");
  if (isNative && window.macwipeUI?.scan) window.macwipeUI.scan();
})();
