(() => {
  "use strict";

  if (window !== window.top && !window.frameElement?.matches("iframe[data-betterld-topic-preview]")) return;
  const api = globalThis.browser || globalThis.chrome;
  const config = globalThis.BETTERLD_CONFIG;
  const entry = globalThis.BETTERLD_LIBRARY_ENTRY;
  const libraryStore = globalThis.BETTERLD_LIBRARY_STORE;
  const groups = { later: "稍后再看", favorites: "收藏" };
  const tabOrder = ["later", "favorites"];
  let library = libraryStore.empty();
  let ready = false;
  let errorMessage = "";
  let activeGroup = "later";
  let query = "";
  let folderFilter = "*";
  let folderSignature = "";
  let folderPending = false;
  let fab;
  let panel;
  let toolbar;
  let searchInput;
  let folderFilterSelect;
  let folderManager;
  let items;
  let list;
  let status;
  let tabs;
  let previousFocus;
  let fabPosition = null;
  let drag = null;
  let suppressClick = false;
  const pending = new Set();
  const failedBookmarks = new Map();
  const topicMetadata = new Map();
  let currentMetadataId;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.dataset.betterldOwned = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M6 3h12v18l-6-4-6 4V3Z");
    svg.append(path);
    return svg;
  }

  async function readLibrary() {
    try {
      const stored = await api.storage.local.get(config.libraryStorageKey);
      library = libraryStore.read(stored[config.libraryStorageKey]);
      ready = true;
      errorMessage = "";
    } catch (error) {
      ready = false;
      errorMessage = `收藏库读取失败：${error.message}`;
      console.error("[betterLD] library read failed", error);
    }
    sync();
    render();
  }

  function send(message) {
    if (globalThis.browser) return api.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      api.runtime.sendMessage(message, (response) => {
        const error = api.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  async function change(group, topic, remove) {
    const key = `${group}:${entry.key(topic)}`;
    if (!ready || pending.has(key)) return;
    pending.add(key);
    syncButtons();
    try {
      const response = await send({ type: "library-toggle", group, topic: { ...topic, ...topicMetadata.get(String(topic.id)) }, remove });
      if (!response?.ok) throw new Error(response?.error || "收藏写入没有返回结果");
      await readLibrary();
      return ready;
    } catch (error) {
      errorMessage = `保存失败：${error.message}`;
      console.error("[betterLD] library write failed", error);
      showPanel();
      return false;
    } finally {
      pending.delete(key);
      syncTopicButton();
      syncButtons();
      render();
    }
  }

  function saved(group, topic) {
    return library[group].some((item) => entry.key(item) === entry.key(topic));
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // 只同步条目按钮；分组管理与重试按钮没有 data-library-group，不属于收藏条目。
  function syncButtons(buttons = document.querySelectorAll(".betterld-library-save[data-library-group]")) {
    buttons.forEach((button) => {
      const group = button.dataset.libraryGroup;
      const id = button.dataset.libraryId;
      const selected = saved(group, { id });
      const disabled = !ready || pending.has(`${group}:${entry.key({ id })}`);
      if (button.disabled !== disabled) button.disabled = disabled;
      const pressed = String(selected);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
      const label = group === "favorites" ? button.querySelector(".d-button-label") : button;
      setText(label, selected ? (group === "later" ? "取消稍后再看" : "取消收藏") : groups[group]);
    });
  }

  function attachButton(host, group, topic) {
    let button = host.querySelector(`.betterld-library-save[data-library-group="${group}"]`);
    if (button?.dataset.libraryId === topic.id) return;
    button?.remove();
    const className = group === "favorites"
      ? "betterld-library-save betterld-library-topic-action btn btn-icon-text btn-default topic-footer-button"
      : "betterld-library-save";
    button = element("button", className);
    if (group === "favorites") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "fa d-icon svg-icon");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", "m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z");
      svg.append(path);
      button.append(svg, element("span", "d-button-label", groups[group]));
    } else button.textContent = groups[group];
    button.type = "button";
    button.dataset.libraryGroup = group;
    button.dataset.libraryId = topic.id;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      change(group, topic, button.getAttribute("aria-pressed") === "true");
    });
    if (group === "favorites") host.append(button);
    else host.insertBefore(button, host.querySelector(".betterld-topic-card__menu"));
  }

  function syncTopicButton() {
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.exec(location.pathname);
    const old = document.querySelector(".betterld-library-topic-action");
    if (!match) { old?.remove(); return; }
    // 原站到页底时会卸载正文标题，并把同一主题标题放进顶栏。
    const title = document.querySelector(`#topic-title h1[data-topic-id="${match[1]}"] .fancy-title, .d-header .header-title .topic-link[data-topic-id="${match[1]}"]`)?.textContent.trim();
    const host = document.querySelector("#topic-footer-buttons .topic-footer-main-buttons__actions");
    if (!host) { old?.remove(); return; }
    if (old && (old.parentElement !== host || old.dataset.libraryId !== match[1])) old.remove();
    if (!title) return;
    attachButton(host, "favorites", { id: match[1], title, href: `${location.origin}/t/topic/${match[1]}` });
    if (window !== window.top) {
      const footer = host.closest("#topic-footer-buttons");
      let message = footer.querySelector(":scope > .betterld-library-status");
      if (errorMessage) {
        if (!message) {
          message = element("p", "betterld-library-status");
          message.setAttribute("role", "status");
          message.dataset.error = "true";
          footer.append(message);
        }
        setText(message, errorMessage);
      } else message?.remove();
    }
  }

  function fabBounds() {
    const rect = fab.getBoundingClientRect();
    const maxX = Math.max(0, document.documentElement.clientWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    const insetX = Math.min(config.libraryViewportInsetPx, maxX / 2);
    const insetY = Math.min(config.libraryViewportInsetPx, maxY / 2);
    return { rect, left: insetX, top: insetY, right: maxX - insetX, bottom: maxY - insetY };
  }

  function moveFab(left, top) {
    const bounds = fabBounds();
    const x = Math.min(bounds.right, Math.max(bounds.left, left));
    const y = Math.min(bounds.bottom, Math.max(bounds.top, top));
    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fabPosition = {
      x: bounds.right === bounds.left ? 0 : (x - bounds.left) / (bounds.right - bounds.left),
      y: bounds.bottom === bounds.top ? 0 : (y - bounds.top) / (bounds.bottom - bounds.top)
    };
    positionPanel();
  }

  function positionPanel() {
    if (!panel || panel.hidden) return;
    const { left, top, bottom, width } = fab.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const inset = config.libraryViewportInsetPx;
    const gap = config.libraryPanelGapPx;
    const x = Math.min(document.documentElement.clientWidth - panelRect.width - inset, Math.max(inset, left + width - panelRect.width));
    const above = top - gap - panelRect.height;
    const y = above >= inset ? above : Math.min(window.innerHeight - panelRect.height - inset, bottom + gap);
    panel.style.left = `${Math.max(0, x)}px`;
    panel.style.top = `${Math.max(inset, y)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function applyFabPosition() {
    if (!fab || drag) return;
    if (fabPosition) {
      const bounds = fabBounds();
      moveFab(bounds.left + fabPosition.x * (bounds.right - bounds.left), bounds.top + fabPosition.y * (bounds.bottom - bounds.top));
    } else {
      fab.style.removeProperty("left");
      fab.style.removeProperty("top");
      fab.style.removeProperty("right");
      fab.style.removeProperty("bottom");
      positionPanel();
    }
  }

  function parseFabPosition(value) {
    if (value === undefined) return null;
    if (!value || ![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw new Error("收藏按钮位置格式异常");
    }
    return { x: value.x, y: value.y };
  }

  async function readFabPosition() {
    if (drag) return;
    try {
      const stored = await api.storage.local.get(config.libraryPositionStorageKey);
      if (drag) return;
      fabPosition = parseFabPosition(stored[config.libraryPositionStorageKey]);
      applyFabPosition();
    } catch (error) {
      errorMessage = `按钮位置读取失败：${error.message}`;
      console.error("[betterLD] library position read failed", error);
      showPanel();
    }
  }

  async function saveFabPosition() {
    try {
      await api.storage.local.set({ [config.libraryPositionStorageKey]: fabPosition });
    } catch (error) {
      errorMessage = `按钮位置保存失败：${error.message}`;
      console.error("[betterLD] library position save failed", error);
      showPanel();
    }
  }

  function bindFabMovement() {
    fab.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const rect = fab.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < config.libraryDragThresholdPx) return;
      if (!drag.moved) closePanel();
      drag.moved = true;
      fab.dataset.dragging = "true";
      moveFab(drag.left + dx, drag.top + dy);
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finished = drag;
      drag = null;
      delete fab.dataset.dragging;
      suppressClick = finished.moved;
      if (fab.hasPointerCapture(event.pointerId)) fab.releasePointerCapture(event.pointerId);
      if (!finished.moved) return;
      if (event.type === "pointerup") saveFabPosition();
      else {
        moveFab(finished.left, finished.top);
        readFabPosition();
      }
    };
    fab.addEventListener("pointerup", finish);
    fab.addEventListener("pointercancel", finish);
    fab.addEventListener("lostpointercapture", finish);
    fab.addEventListener("keydown", (event) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const rect = fab.getBoundingClientRect();
      const step = config.libraryMoveStepPx;
      moveFab(rect.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        rect.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
      saveFabPosition();
    });
    window.addEventListener("resize", applyFabPosition);
  }

  function closePanel() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    if (previousFocus?.isConnected) previousFocus.focus();
    else fab.focus();
  }

  function showPanel() {
    if (!panel) return;
    previousFocus = document.activeElement;
    panel.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    render();
    tabs.querySelector(`[data-group="${activeGroup}"]`).focus();
  }

  function emptyMessage() {
    if (!library[activeGroup].length) {
      return activeGroup === "later"
        ? "点击主题旁的「稍后再看」即可添加。"
        : "点击帖底「收藏」即可添加。";
    }
    return "没有匹配的收藏，试试清空搜索词或切换分组。";
  }

  function visibleItems() {
    const keyword = query.trim().toLowerCase();
    return library[activeGroup].filter((item) => {
      if (activeGroup === "favorites" && folderFilter !== "*" && (item.folderId ?? "") !== folderFilter) {
        return false;
      }
      return !keyword || item.title.toLowerCase().includes(keyword);
    }).sort((a, b) => b.savedAt - a.savedAt);
  }

  function folderSignatureOf() {
    return library.folders.map((folder) => `${folder.id}:${folder.name}`).join("|");
  }

  function renderToolbar() {
    if (!ready) {
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;
    if (searchInput.value !== query) searchInput.value = query;
    searchInput.placeholder = "搜索标题";
    folderFilterSelect.hidden = activeGroup !== "favorites";
    const signature = folderSignatureOf();
    if (folderFilterSelect.dataset.signature !== signature) {
      folderFilterSelect.dataset.signature = signature;
      const options = [["*", "全部分组"], ["", "未分类"], ...library.folders.map((folder) => [folder.id, folder.name])];
      folderFilterSelect.replaceChildren(...options.map(([value, label]) => {
        const option = element("option", "", label);
        option.value = value;
        return option;
      }));
    }
    if (folderFilter !== "*" && folderFilter !== "" && !library.folders.some((folder) => folder.id === folderFilter)) {
      folderFilter = "*";
    }
    if (folderFilterSelect.value !== folderFilter) folderFilterSelect.value = folderFilter;
  }

  function syncFolderBusy() {
    folderManager.querySelectorAll("button, input").forEach((node) => {
      node.disabled = folderPending;
    });
    items.querySelectorAll(".betterld-library-move").forEach((node) => {
      node.disabled = folderPending;
    });
  }

  function setFolderBusy(busy) {
    folderPending = busy;
    syncFolderBusy();
  }

  function folderRow(folder) {
    const row = element("div", "betterld-library-folder-row");
    const name = element("input", "betterld-library-folder-name");
    name.type = "text";
    name.value = folder.name;
    name.maxLength = config.libraryFolderNameMaxLength;
    name.setAttribute("aria-label", `分组名称：${folder.name}`);
    const save = element("button", "betterld-library-save", "保存");
    save.type = "button";
    save.addEventListener("click", () => folderCommand({ type: "library-folder-rename", id: folder.id, name: name.value }, "重命名分组失败"));
    const remove = element("button", "betterld-library-remove", "删除");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除分组：${folder.name}`);
    remove.addEventListener("click", () => {
      if (!globalThis.confirm(`删除分组「${folder.name}」？分组内的收藏会移到未分类，收藏本身保留。`)) return;
      folderCommand({ type: "library-folder-delete", id: folder.id }, "删除分组失败");
    });
    row.append(name, save, remove);
    return row;
  }

  function renderFolders() {
    folderManager.hidden = !ready || activeGroup !== "favorites";
    if (folderManager.hidden) return;
    const signature = folderSignatureOf();
    if (folderSignature === signature) {
      syncFolderBusy();
      return;
    }
    folderSignature = signature;
    const create = element("div", "betterld-library-folder-create");
    const name = element("input", "betterld-library-folder-name");
    name.type = "text";
    name.placeholder = "新分组名称";
    name.maxLength = config.libraryFolderNameMaxLength;
    name.setAttribute("aria-label", "新分组名称");
    const add = element("button", "betterld-library-save", "新建分组");
    add.type = "button";
    add.addEventListener("click", async () => {
      if (await folderCommand({ type: "library-folder-create", name: name.value }, "新建分组失败")) name.value = "";
    });
    create.append(name, add);
    folderManager.replaceChildren(
      element("p", "betterld-library-folders-title", `分组（${library.folders.length}/${config.libraryFoldersMax}）`),
      create,
      ...library.folders.map(folderRow)
    );
    syncFolderBusy();
  }

  async function folderCommand(message, errorLabel) {
    if (folderPending) return false;
    setFolderBusy(true);
    try {
      const response = await send(message);
      if (!response?.ok) throw new Error(response?.error || "收藏分组操作失败");
      await readLibrary();
      return true;
    } catch (error) {
      errorMessage = `${errorLabel}：${error.message}`;
      console.error("[betterLD] library folder command failed", error);
      render();
      return false;
    } finally {
      setFolderBusy(false);
    }
  }

  async function moveItem(topic, folderId) {
    if (folderPending) return;
    setFolderBusy(true);
    try {
      const response = await send({ type: "library-item-move", topic, folderId });
      if (!response?.ok) throw new Error(response?.error || "收藏移动失败");
      await readLibrary();
    } catch (error) {
      errorMessage = `移动收藏失败：${error.message}`;
      console.error("[betterLD] library item move failed", error);
      render();
    } finally {
      setFolderBusy(false);
    }
  }

  function topicFloorHref(record) {
    return `${location.origin}/t/topic/${record.id}${record.postNumber === undefined ? "" : `/${record.postNumber}`}`;
  }

  // 收藏标题与楼层链接都整页加载深链，确保原站可靠定位收藏楼层。
  function deepLink(element, record) {
    element.href = topicFloorHref(record);
    element.addEventListener("click", (event) => {
      if (record.postNumber === undefined || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      location.assign(topicFloorHref(record));
    });
  }

  function appendItemDetails(row, record, topic) {
    const meta = element("p", "betterld-library-meta");
    const author = element("span", "betterld-library-author");
    if (record.authorAvatar) {
      const avatar = element("img", "betterld-library-avatar");
      avatar.src = record.authorAvatar;
      avatar.alt = "";
      avatar.width = 24;
      avatar.height = 24;
      avatar.loading = "lazy";
      author.append(avatar);
    }
    author.append(element("span", "", record.author === undefined ? "发帖人未知" : `@${record.author}`));
    meta.append(author, " · ",
      element("span", "", new Date(topic.savedAt).toLocaleString()));
    if (topic.postNumber !== undefined) {
      const floor = element("a", "betterld-library-floor", `收藏楼层 #${topic.postNumber} 楼`);
      deepLink(floor, topic);
      meta.append(" · ", floor);
    }
    const taxonomy = element("div", "betterld-library-taxonomy");
    taxonomy.append(element("span", "betterld-library-category", record.category?.name || (record.category === null ? "未分类" : "分类未知")));
    for (const tag of record.tags || []) taxonomy.append(element("span", "betterld-library-tag", `#${tag}`));
    if (record.tags === undefined) taxonomy.append(element("span", "betterld-library-unknown", "标签未知"));
    row.append(taxonomy, meta);
  }

  function appendDatedRows(records, createRow) {
    let previousGroup = null;
    for (const record of records) {
      const group = new Date(record.savedAt).toLocaleDateString();
      if (group !== previousGroup) {
        items.append(element("h3", "betterld-library-date", group));
        previousGroup = group;
      }
      items.append(createRow(record));
    }
  }

  function render() {
    if (!panel || panel.hidden) return;
    status.textContent = errorMessage;
    status.hidden = !status.textContent;
    status.dataset.error = String(Boolean(errorMessage));
    for (const tab of tabs.children) {
      const active = tab.dataset.group === activeGroup;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const count = library[tab.dataset.group].length;
      setText(tab, `${groups[tab.dataset.group]} ${count}`);
    }
    list.setAttribute("aria-labelledby", `betterld-library-tab-${activeGroup}`);
    renderToolbar();
    renderFolders();
    items.replaceChildren();
    if (failedBookmarks.size) {
      const retry = element("button", "betterld-library-save", "重试同步楼层书签");
      retry.type = "button";
      retry.addEventListener("click", () => {
        for (const data of failedBookmarks.values()) queueBookmark(data);
      });
      items.append(retry);
    }
    if (!ready) {
      const retry = element("button", "betterld-library-save", "重试读取收藏库");
      retry.type = "button";
      retry.addEventListener("click", readLibrary);
      items.append(retry);
      positionPanel();
      return;
    }
    const visible = visibleItems();
    if (!visible.length) {
      items.append(element("p", "betterld-library-empty", emptyMessage()));
      positionPanel();
      return;
    }
    appendDatedRows(visible, (topic) => {
      const row = element("div", "betterld-library-item");
      const link = element("a", "betterld-library-link", topic.title);
      deepLink(link, topic);
      row.append(link);
      appendItemDetails(row, { ...topic, ...topicMetadata.get(topic.id) }, topic);
      const controls = element("div", "betterld-library-item__controls");
      if (activeGroup === "favorites") {
        const move = element("select", "betterld-library-move");
        move.setAttribute("aria-label", `移动「${topic.title}」到分组`);
        move.disabled = folderPending;
        move.append(...[["", "未分类"], ...library.folders.map((folder) => [folder.id, folder.name])].map(([value, text]) => {
          const option = element("option", "", text);
          option.value = value;
          return option;
        }));
        move.value = topic.folderId ?? "";
        move.addEventListener("change", () => moveItem(topic, move.value === "" ? null : move.value));
        controls.append(move);
      }
      const remove = element("button", "betterld-library-remove", "移除");
      remove.type = "button";
      remove.setAttribute("aria-label", `从${groups[activeGroup]}移除：${topic.title}`);
      remove.disabled = pending.has(`${activeGroup}:${entry.key(topic)}`);
      const group = activeGroup;
      remove.addEventListener("click", () => change(group, topic, true));
      controls.append(remove);
      row.append(controls);
      return row;
    });
    positionPanel();
  }

  function createPanel() {
    if (window !== window.top || fab) return;
    document.body.classList.add("betterld-has-library");
    fab = element("button", "betterld-library-fab");
    fab.type = "button";
    fab.append(icon());
    fab.setAttribute("aria-label", "打开收藏库：稍后再看与收藏；可拖动，Alt 加方向键移动");
    fab.title = "点击打开收藏库，拖动改变位置；Alt + 方向键移动";
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-controls", "betterld-topic-library");
    panel = element("section", "betterld-library-panel");
    panel.id = "betterld-topic-library";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "betterld-library-heading");
    panel.hidden = true;
    const header = element("div", "betterld-library-header");
    const title = element("h2", "", "收藏库");
    title.id = "betterld-library-heading";
    const close = element("button", "betterld-library-remove", "关闭");
    close.type = "button";
    close.addEventListener("click", closePanel);
    header.append(title, close);
    tabs = element("div", "betterld-library-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "收藏分类");
    for (const group of tabOrder) {
      const tab = element("button", "betterld-library-tab", groups[group]);
      tab.type = "button";
      tab.id = `betterld-library-tab-${group}`;
      tab.dataset.group = group;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "betterld-library-list");
      tab.addEventListener("click", () => { activeGroup = group; render(); });
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = tabOrder.indexOf(activeGroup);
        activeGroup = event.key === "Home"
          ? tabOrder[0]
          : event.key === "End"
            ? tabOrder[tabOrder.length - 1]
            : tabOrder[(index + (event.key === "ArrowRight" ? 1 : tabOrder.length - 1)) % tabOrder.length];
        render();
        tabs.querySelector(`[data-group="${activeGroup}"]`).focus();
      });
      tabs.append(tab);
    }
    toolbar = element("div", "betterld-library-toolbar");
    searchInput = element("input", "betterld-library-search");
    searchInput.type = "search";
    searchInput.placeholder = "搜索标题";
    searchInput.setAttribute("aria-label", "搜索收藏标题");
    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      render();
    });
    folderFilterSelect = element("select", "betterld-library-filter");
    folderFilterSelect.setAttribute("aria-label", "按分组筛选收藏");
    folderFilterSelect.addEventListener("change", () => {
      folderFilter = folderFilterSelect.value;
      render();
    });
    toolbar.append(searchInput, folderFilterSelect);
    list = element("div", "betterld-library-list");
    list.id = "betterld-library-list";
    list.setAttribute("role", "tabpanel");
    folderManager = element("section", "betterld-library-folders");
    folderManager.setAttribute("aria-label", "收藏分组管理");
    items = element("div", "betterld-library-items");
    list.append(folderManager, items);
    status = element("p", "betterld-library-status");
    status.setAttribute("role", "status");
    panel.append(header, tabs, toolbar, list, status);
    document.body.append(fab, panel);
    bindFabMovement();
    readFabPosition();
    fab.addEventListener("click", (event) => {
      if (suppressClick && event.detail > 0) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      panel.hidden ? showPanel() : closePanel();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!panel.hidden && !panel.contains(event.target) && !fab.contains(event.target)) closePanel();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); closePanel(); }
    });
  }

  function sync(rows) {
    if (!document.body) return;
    createPanel();
    const incremental = rows !== undefined;
    const buttons = [];
    for (const row of rows || document.querySelectorAll(".betterld-topic-row, .betterld-search-result")) {
      if (!row.isConnected) continue;
      const host = row.querySelector(".betterld-topic-row__actions");
      const id = row.dataset.topicId;
      const title = row.querySelector("a.title, a.search-link")?.textContent.trim();
      if (host && id && title) {
        const categoryName = row.querySelector(".badge-category__name")?.textContent.trim();
        const categoryId = row.querySelector("[data-category-id]")?.dataset.categoryId;
        const author = row.dataset.filterAuthor;
        const avatar = row.querySelector(".betterld-topic-row__avatar img")?.src;
        const metadata = {
          ...(author ? { author } : {}), ...(avatar ? { authorAvatar: avatar } : {}),
          ...(categoryName && categoryId ? { category: { id: categoryId, name: categoryName } } : {}),
          tags: [...row.querySelectorAll(".discourse-tag")].map(tag => tag.dataset.tagName || tag.textContent.trim()).filter(Boolean)
        };
        topicMetadata.set(id, { ...topicMetadata.get(id), ...metadata });
        attachButton(host, "later", { id, title, href: `${location.origin}/t/topic/${id}` });
        buttons.push(host.querySelector('.betterld-library-save[data-library-group="later"]'));
      }
    }
    syncTopicButton();
    if (incremental) {
      const topicButton = document.querySelector(".betterld-library-topic-action");
      if (topicButton) buttons.push(topicButton);
      syncButtons(buttons);
      return;
    }
    const activeIds = new Set([
      ...library.later.map((topic) => topic.id), ...library.favorites.map((topic) => topic.id),
      ...[...document.querySelectorAll(".betterld-topic-row, .betterld-search-result")].map((row) => row.dataset.topicId),
      currentMetadataId
    ]);
    for (const id of topicMetadata.keys()) if (!activeIds.has(id)) topicMetadata.delete(id);
    syncButtons();
  }

  // 书签桥接只接收成功后的模型状态；不根据按钮点击创建本地收藏。
  let bookmarkQueue = Promise.resolve();
  const bookmarkVersions = new Map();
  function queueBookmark(data) {
    const key = data.topic ? entry.key(data.topic) : "invalid";
    const version = (bookmarkVersions.get(key) || 0) + 1;
    bookmarkVersions.set(key, version);
    if (failedBookmarks.has(key)) failedBookmarks.set(key, data);
    const request = bookmarkQueue.then(async () => {
      if (bookmarkVersions.get(key) !== version) return;
      if (typeof data.bookmarked !== "boolean") throw new Error("书签状态无效");
      entry.validate(data.topic);
      if (data.topic.postNumber === undefined) throw new Error("书签缺少楼层编号");
      if (!ready) await readLibrary();
      if (!ready) throw new Error(errorMessage);
      if (saved("favorites", data.topic) !== data.bookmarked) {
        const success = await change("favorites", data.topic, !data.bookmarked);
        if (!success) throw new Error(errorMessage || "收藏写入未完成，请重试");
      }
      failedBookmarks.delete(entry.key(data.topic));
      if (!failedBookmarks.size) errorMessage = "";
      render();
    });
    bookmarkQueue = request.catch((error) => {
      if (bookmarkVersions.get(key) !== version) return;
      if (data.topic) failedBookmarks.set(key, data);
      errorMessage = `书签同步失败：${error.message}`;
      console.error("[betterLD] bookmark library sync failed", error);
      showPanel();
      syncTopicButton();
      render();
    });
  }

  document.addEventListener("betterld:reply-bookmark", (event) => {
    queueBookmark(JSON.parse(event.detail));
  });

  function updateMetadata(records) {
    for (const record of records) {
      const id = String(record.id);
      const metadata = libraryStore.metadataFields(record);
      currentMetadataId = id;
      topicMetadata.set(id, { ...topicMetadata.get(id), ...metadata });
    }
    render();
  }

  globalThis.BETTERLD_LIBRARY = Object.freeze({ sync, updateMetadata });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, config.libraryStorageKey)) readLibrary();
    if (fab && Object.hasOwn(changes, config.libraryPositionStorageKey)) readFabPosition();
  });
  readLibrary();
})();
