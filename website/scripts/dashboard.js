(() => {
  "use strict";

  const isNative = !!window.webkit?.messageHandlers?.macwipeBridge;

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
    : MacwipeData;

  const { formatMB, createChat } = MacwipeUI;
  let allItems = Object.values(categories).flatMap(
    (category) => category.items || [],
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

  function renderHomeStorage(storage) {
    const overview = document.querySelector("#storage-overview");
    const unavailable = document.querySelector("#storage-unavailable");
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
      ...storage.segments,
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
    const summary = `Selected: ${count} ${count === 1 ? "item" : "items"} · ${formatMB(selectedMB)}`;
    if (selectionStatus.textContent !== summary)
      selectionStatus.textContent = summary;
    reviewButton.disabled = count === 0;
    const cat = categories[currentCategory];
    const selectableItems = (cat && cat.items ? cat.items : []).filter(
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
    if (!categories[currentCategory] || !categories[currentCategory].items)
      return;
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
    const isHome = key === "home";
    if (!isHome && !Object.hasOwn(categories, key)) return;
    currentCategory = key;
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

    if (!cachedRows.has(key))
      cachedRows.set(key, (category.items || []).map(createRow));

    const fragment = document.createDocumentFragment();
    fragment.append(...cachedRows.get(key));
    if (isNative && !category.items.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "No accessible eligible items found.";
      row.append(cell);
      fragment.append(row);
    }
    tableBody.replaceChildren(fragment);
    tableBody.querySelectorAll("input[data-item]").forEach((checkbox) => {
      checkboxById.set(checkbox.dataset.item, checkbox);
    });
    refreshSelection();
  }

  function selectAll() {
    const cat = categories[currentCategory];
    const items = (cat && cat.items ? cat.items : []).filter(
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
        "Selected files will be moved to Trash. Applications and support folders may contain personal data. Removing startup files does not stop running services. Close affected apps and browsers first.";
      confirmButton.hidden = false;
      confirmButton.style.display = "";
      confirmButton.textContent = "Clean Selected";
    }
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
    fileList.setAttribute("aria-label", "Local scanned files");
    document.querySelector(".dashboard > .status-strip").textContent =
      "macOS helper · Native · System Scan";

    const nativeUI = window.macwipeUI;
    const receiveScanData = nativeUI.receiveScanData;
    const onCleanupComplete = nativeUI.onCleanupComplete;

    nativeUI.receiveScanData = function (payload) {
      if (receiveScanData) receiveScanData.call(this, payload);

      for (const [key, category] of Object.entries(categories)) {
        category.items = (payload.categories[key]?.items || []).map((file) => ({
          id: file.id,
          category: file.category,
          path: file.path,
          name: file.name,
          mb: file.bytes / 1_000_000,
          info: file.formatted || formatMB(file.bytes / 1_000_000),
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
      selected.clear();
      selectedMB = 0;
      cachedRows.clear();
      checkboxById.clear();
      const key = currentCategory;
      currentCategory = null;
      switchCategory(key || "home");

      previewNote.textContent = "Scan complete. Review files before cleanup.";
      if (reviewDialog.open && !confirmButton.hidden) reviewDialog.close();
    };

    nativeUI.onCleanupComplete = function (freedMB, result = {}) {
      if (onCleanupComplete) onCleanupComplete.call(this, freedMB, result);
      reviewIntro.textContent = "Cleanup complete.";
      reviewList.replaceChildren();
      reviewTotal.textContent = formatMB(result.diskFreedMB ?? freedMB);
      reviewNotice.textContent = `Disk space freed: ${formatMB(result.diskFreedMB ?? freedMB)}.`;
      confirmButton.hidden = true;
      confirmButton.style.display = "none";
      if (!reviewDialog.open) reviewDialog.showModal();
      if (result.errors?.length)
        reviewNotice.textContent += ` ${result.errors.join(" ")}`;
      if (nativeUI.scan) nativeUI.scan();
    };
    window.addEventListener("macwipe:error", (event) => {
      previewNote.textContent = event.detail.message;
    });
  }

  renderHomeStorage(isNative ? null : window.MacwipeDemoStorage);
  switchCategory("home");
  if (isNative && window.macwipeUI?.scan) window.macwipeUI.scan();
})();
