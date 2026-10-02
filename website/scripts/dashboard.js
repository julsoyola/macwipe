(() => {
  "use strict";

  const isNative = !!window.webkit?.messageHandlers?.macwipeBridge;
  const categories = isNative
    ? {
        storage: {
          title: "Storage",
          description: "Actual files scanned from system paths",
          items: [],
        },
        caches: {
          title: "Caches",
          description: "Actual files scanned from system paths",
          items: [],
        },
        downloads: {
          title: "Downloads",
          description: "Actual files scanned from system paths",
          items: [],
        },
      }
    : MacwipeData;
  const { formatMB, createChat } = MacwipeUI;
  let allItems = Object.values(categories).flatMap(
    (category) => category.items,
  );
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const selected = new Set();
  const cachedRows = new Map();
  const checkboxById = new Map();
  let currentCategory = null;
  let selectedMB = 0;

  // Resolve persistent DOM nodes once; event handlers reuse these references.
  const tableBody = document.querySelector("#item-table-body");
  const fileList = document.querySelector("#file-list");
  const navButtons = document.querySelectorAll("[data-category]");
  const heading = document.querySelector("#dashboard-heading");
  const description = document.querySelector("#category-description");
  const caption = document.querySelector("#list-caption");
  const selectionStatus = document.querySelector("#selection-status");
  const selectAllButton = document.querySelector("#btn-select-all");
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

  function updateSelection() {
    const count = selected.size;
    const summary = `Selected: ${count} ${count === 1 ? "item" : "items"} · ${formatMB(selectedMB)}`;
    if (selectionStatus.textContent !== summary)
      selectionStatus.textContent = summary;
    reviewButton.disabled = count === 0;
    const selectableItems = categories[currentCategory].items.filter(
      (item) => item.canClean !== false,
    );
    selectAllButton.disabled = selectableItems.length === 0;
    const allChecked =
      selectableItems.length > 0 &&
      selectableItems.every((item) => selected.has(item.id));
    const label = allChecked ? "Deselect all" : "Select all";
    if (selectAllButton.textContent !== label)
      selectAllButton.textContent = label;
  }

  function setSelected(item, checked) {
    if (item.canClean === false) return;
    if (selected.has(item.id) !== checked) {
      if (checked) selected.add(item.id);
      else selected.delete(item.id);
      selectedMB += checked ? item.mb : -item.mb;
    }
    const checkbox = checkboxById.get(item.id);
    if (checkbox && checkbox.checked !== checked) checkbox.checked = checked;
  }

  function refreshSelection() {
    categories[currentCategory].items.forEach((item) => {
      setSelected(item, selected.has(item.id));
    });
    updateSelection();
  }

  function createRow(item) {
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
    checkbox.setAttribute("aria-label", `Select ${item.name}`);
    checkboxById.set(item.id, checkbox);
    selectCell.append(checkbox);

    const nameCell = document.createElement("td");
    nameCell.textContent = item.name;
    const infoCell = document.createElement("td");
    infoCell.textContent = item.info || formatMB(item.mb);
    const detailsCell = document.createElement("td");
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "question-row";
    detailsButton.dataset.details = item.id;
    detailsButton.textContent = "Details";
    detailsButton.setAttribute("aria-label", `Details about ${item.name}`);
    detailsButton.setAttribute("aria-haspopup", "dialog");
    detailsButton.setAttribute("aria-controls", "details-dialog");
    detailsCell.append(detailsButton);
    row.append(selectCell, nameCell, infoCell, detailsCell);
    return row;
  }

  function switchCategory(key) {
    if (key === currentCategory || !Object.hasOwn(categories, key)) return;
    currentCategory = key;
    const category = categories[key];
    document.title = `macwipe · ${category.title} · ${isNative ? "Native" : "Demo"}`;
    heading.textContent = category.title;
    description.textContent = category.description;
    caption.textContent = `${isNative ? "Local" : "Example"} ${category.title.toLowerCase()} items`;
    navButtons.forEach((button) => {
      if (button.dataset.category === key)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    if (!cachedRows.has(key))
      cachedRows.set(key, category.items.map(createRow));
    // Build off-document and replace once. Revisit rows without recreating them.
    const fragment = document.createDocumentFragment();
    fragment.append(...cachedRows.get(key));
    tableBody.replaceChildren(fragment);
    refreshSelection();
  }

  function selectAll() {
    const items = categories[currentCategory].items.filter(
      (item) => item.canClean !== false,
    );
    const checked = !items.every((item) => selected.has(item.id));
    items.forEach((item) => setSelected(item, checked));
    updateSelection();
  }

  function review() {
    if (!selected.size) return;
    if (isNative) {
      reviewIntro.textContent = "Selected files for cleanup:";
      reviewNotice.textContent =
        "Eligible files will be moved to Trash. Downloads include only files older than 90 days. Trash will not be emptied.";
      confirmButton.hidden = false;
      confirmButton.style.display = "";
      confirmButton.textContent = "Move to Trash";
    }
    // Keep the original category/item order in the review, independent of clicks.
    const items = allItems.filter((item) => selected.has(item.id));
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const entry = document.createElement("li");
      entry.textContent = `${item.name} · ${item.info || formatMB(item.mb)}`;
      fragment.append(entry);
    });
    reviewList.replaceChildren(fragment);
    reviewTotal.textContent = formatMB(selectedMB);
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
    "scroll-up": () => scrollFiles(-1),
    "scroll-down": () => scrollFiles(1),
    preview: () => {
      if (isNative) {
        previewNote.textContent = "Scanning local files...";
        window.macwipeUI.scan();
      } else refreshSelection();
    },
    "select-all": selectAll,
    review,
    simulate: () => {
      if (isNative) {
        const grouped = new Map();
        selected.forEach((id) => {
          const item = itemById.get(id);
          if (!grouped.has(item.category)) grouped.set(item.category, []);
          grouped.get(item.category).push(item.path);
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
      // The review trigger is now disabled; return focus to a usable control.
      previewButton.focus();
    },
  };

  // Delegation keeps listener count fixed across category changes and scans.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.category) switchCategory(button.dataset.category);
    else if (button.dataset.details) {
      const item = itemById.get(button.dataset.details);
      if (item) openDetails(`Tell me about ${item.name}.`, item.details);
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

  if (isNative) {
    document.querySelector(".demo-tag").textContent = "Native · System Scan";
    previewNote.textContent = "Scanning local files...";
    document.querySelector(".dashboard > .status-strip").textContent =
      "macOS helper · Native · System Scan";
    document
      .querySelector(".table-scroll")
      .setAttribute("aria-label", "Local scanned files");
    navButtons.forEach((button) => {
      button.disabled = !Object.hasOwn(categories, button.dataset.category);
    });

    // Keep the bridge's scan snapshot and pending-operation state in sync.
    const nativeUI = window.macwipeUI;
    const receiveScanData = nativeUI.receiveScanData;
    const onCleanupComplete = nativeUI.onCleanupComplete;
    nativeUI.receiveScanData = function (payload) {
      receiveScanData.call(this, payload);
      allItems = ["caches", "logs", "trash", "downloads"].flatMap((id) => {
        const scan = payload.categories[id];
        const name = id[0].toUpperCase() + id.slice(1);
        if (scan.items.length)
          return scan.items.map((file) => ({
            id: JSON.stringify([id, file.path]),
            category: id,
            path: file.path,
            name: `${name} · ${file.name}`,
            mb: file.bytes / 1_000_000,
            info: file.formatted || formatMB(file.bytes / 1_000_000),
            details: `${file.path}. ${payload.sizeMeaning}`,
            canClean: scan.canClean && !scan.error && id !== "trash",
          }));
        // Swift does not enumerate Trash or non-eligible downloads in items.
        return [
          {
            id,
            category: id,
            name,
            mb: 0,
            info:
              scan.error ||
              `${formatMB(scan.bytes / 1_000_000)} total · No eligible files`,
            details:
              scan.error ||
              `${scan.formatted} in this category. ${scan.eligibleFormatted} eligible to move to Trash. ${payload.sizeMeaning}`,
            canClean: false,
          },
        ];
      });
      categories.storage.items = allItems;
      categories.caches.items = allItems.filter(
        (item) => item.category === "caches",
      );
      categories.downloads.items = allItems.filter(
        (item) => item.category === "downloads",
      );
      itemById.clear();
      allItems.forEach((item) => itemById.set(item.id, item));
      selected.clear();
      selectedMB = 0;
      cachedRows.clear();
      checkboxById.clear();
      const key = currentCategory;
      currentCategory = null;
      switchCategory(key);
      previewNote.textContent = allItems.some(
        (item) => payload.categories[item.category].error,
      )
        ? "Scan complete. Some categories are unavailable or incomplete."
        : "Scan complete. Review local files before cleanup.";
      if (reviewDialog.open && !confirmButton.hidden) reviewDialog.close();
    };
    nativeUI.onCleanupComplete = function (freedMB, result = {}) {
      onCleanupComplete.call(this, freedMB, result);
      reviewIntro.textContent = "Cleanup complete.";
      reviewList.replaceChildren();
      reviewTotal.textContent = formatMB(result.diskFreedMB ?? freedMB);
      reviewNotice.textContent =
        result.diskFreedMB !== undefined
          ? `${formatMB(freedMB)} moved to Trash. Disk space freed: ${formatMB(result.diskFreedMB)}.`
          : `Disk space freed: ${formatMB(freedMB)}.`;
      if (result.errors?.length)
        reviewNotice.textContent += ` ${result.errors.join(" ")}`;
      confirmButton.hidden = true;
      confirmButton.style.display = "none";
      if (!reviewDialog.open) reviewDialog.showModal();
      // The existing bridge queues the automatic Swift rescan on completion.
      nativeUI.scan();
    };
    window.addEventListener("macwipe:error", (event) => {
      previewNote.textContent = event.detail.message;
    });
  }

  switchCategory("storage");
  if (isNative) window.macwipeUI.scan();
})();
