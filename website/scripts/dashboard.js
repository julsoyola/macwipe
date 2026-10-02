(() => {
  "use strict";

  const categories = MacwipeData;
  const { formatMB, createChat } = MacwipeUI;
  const allItems = Object.values(categories).flatMap(
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
  const openDetails = createChat(document.querySelector("#details-dialog"));

  function updateSelection() {
    const count = selected.size;
    const summary = `Selected: ${count} ${count === 1 ? "item" : "items"} · ${formatMB(selectedMB)}`;
    if (selectionStatus.textContent !== summary)
      selectionStatus.textContent = summary;
    reviewButton.disabled = count === 0;
    const allChecked = categories[currentCategory].items.every((item) =>
      selected.has(item.id),
    );
    const label = allChecked ? "Deselect all" : "Select all";
    if (selectAllButton.textContent !== label)
      selectAllButton.textContent = label;
  }

  function setSelected(item, checked) {
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
    checkbox.dataset.item = item.id;
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
    document.title = `macwipe · ${category.title} · Demo`;
    heading.textContent = category.title;
    description.textContent = category.description;
    caption.textContent = `Example ${category.title.toLowerCase()} items`;
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
    const items = categories[currentCategory].items;
    const checked = !items.every((item) => selected.has(item.id));
    items.forEach((item) => setSelected(item, checked));
    updateSelection();
  }

  function review() {
    if (!selected.size) return;
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

  const actions = {
    // Data is static; preview refreshes state without rebuilding rows.
    preview: refreshSelection,
    "select-all": selectAll,
    review,
    simulate: () => {
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

  switchCategory("storage");
})();
