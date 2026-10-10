(() => {
  "use strict";

  if (window !== window.top && !window.frameElement?.matches("iframe[data-betterld-topic-preview]")) return;
  const api = globalThis.browser || globalThis.chrome;
  const config = globalThis.BETTERLD_CONFIG;
  const groups = { later: "稍后再看", favorites: "收藏" };
  let library = { later: [], favorites: [] };
  let ready = false;
  let errorMessage = "";
  let activeGroup = "later";
  let fab;
  let panel;
  let list;
  let status;
  let tabs;
  let previousFocus;
  let fabPosition = null;
  let drag = null;
  let suppressClick = false;
  const pending = new Set();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
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

  function validateLibrary(value) {
    if (!value || !Array.isArray(value.later) || !Array.isArray(value.favorites)) throw new Error("收藏存储格式异常，原数据保持不变");
    for (const items of [value.later, value.favorites]) {
      for (const item of items) {
        const url = new URL(item.href);
        if (!/^[1-9]\d*$/.test(String(item.id)) || typeof item.title !== "string" || !item.title.trim()
          || !["https://linux.do", "https://www.linux.do"].includes(url.origin)
          || !/^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.test(url.pathname)
          || !Number.isFinite(item.savedAt)) throw new Error("收藏条目信息异常，原数据保持不变");
      }
    }
    return value;
  }

  async function readLibrary() {
    try {
      const stored = await api.storage.local.get(config.libraryStorageKey);
      library = validateLibrary(stored[config.libraryStorageKey] ?? { later: [], favorites: [] });
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
    const key = `${group}:${topic.id}`;
    if (!ready || pending.has(key)) return;
    pending.add(key);
    syncButtons();
    try {
      const response = await send({ type: "library-toggle", group, topic, remove });
      if (!response?.ok) throw new Error(response?.error || "收藏写入没有返回结果");
      await readLibrary();
    } catch (error) {
      errorMessage = `保存失败：${error.message}`;
      console.error("[betterLD] library write failed", error);
      showPanel();
    } finally {
      pending.delete(key);
      syncTopicButton();
      syncButtons();
      render();
    }
  }

  function saved(group, id) {
    return library[group].some((item) => String(item.id) === String(id));
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function syncButtons() {
    document.querySelectorAll(".betterld-library-save").forEach((button) => {
      const group = button.dataset.libraryGroup;
      const id = button.dataset.libraryId;
      const selected = saved(group, id);
      const disabled = !ready || pending.has(`${group}:${id}`);
      if (button.disabled !== disabled) button.disabled = disabled;
      const pressed = String(selected);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
      setText(button, selected ? (group === "later" ? "取消稍后再看" : "取消收藏") : groups[group]);
    });
  }

  function attachButton(host, group, topic) {
    let button = host.querySelector(`.betterld-library-save[data-library-group="${group}"]`);
    if (button?.dataset.libraryId === topic.id) return;
    button?.remove();
    button = element("button", "betterld-library-save", groups[group]);
    button.type = "button";
    button.dataset.libraryGroup = group;
    button.dataset.libraryId = topic.id;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      change(group, topic, button.getAttribute("aria-pressed") === "true");
    });
    if (group === "later") host.insertBefore(button, host.querySelector(".betterld-topic-card__menu"));
    else host.prepend(button);
  }

  function syncTopicButton() {
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.exec(location.pathname);
    const old = document.querySelector(".betterld-library-topic-action");
    if (!match) { old?.remove(); return; }
    const titleBlock = document.querySelector("#topic-title");
    const heading = titleBlock?.querySelector("h1");
    const title = heading?.textContent.trim();
    if (!title) return;
    let host = old;
    if (!host || !titleBlock.contains(host)) {
      host?.remove();
      host = element("div", "betterld-library-topic-action");
      titleBlock.append(host);
    }
    attachButton(host, "favorites", { id: match[1], title, href: `${location.origin}/t/topic/${match[1]}` });
    if (window !== window.top) {
      let message = host.querySelector(".betterld-library-status");
      if (errorMessage) {
        if (!message) {
          message = element("p", "betterld-library-status");
          message.setAttribute("role", "status");
          message.dataset.error = "true";
          host.append(message);
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

  function render() {
    if (!panel) return;
    status.textContent = errorMessage || "本机保存 · 与 LinuxDo 原生书签独立";
    status.dataset.error = String(Boolean(errorMessage));
    for (const tab of tabs.children) {
      const active = tab.dataset.group === activeGroup;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      setText(tab, `${groups[tab.dataset.group]} ${library[tab.dataset.group].length}`);
    }
    list.setAttribute("aria-labelledby", `betterld-library-tab-${activeGroup}`);
    list.replaceChildren();
    if (!ready) {
      const retry = element("button", "betterld-library-save", "重试读取收藏库");
      retry.type = "button";
      retry.addEventListener("click", readLibrary);
      list.append(retry);
      positionPanel();
      return;
    }
    if (!library[activeGroup].length) {
      list.append(element("p", "betterld-library-empty", activeGroup === "later" ? "在首页点击「稍后再看」，主题就会保存在这里。" : "在帖子标题处点击「收藏」，主题就会保存在这里。"));
      positionPanel();
      return;
    }
    for (const topic of library[activeGroup]) {
      const row = element("div", "betterld-library-item");
      const link = element("a", "betterld-library-link", topic.title);
      link.href = topic.href;
      const remove = element("button", "betterld-library-remove", "移除");
      remove.type = "button";
      remove.setAttribute("aria-label", `从${groups[activeGroup]}移除：${topic.title}`);
      remove.disabled = pending.has(`${activeGroup}:${topic.id}`);
      const group = activeGroup;
      remove.addEventListener("click", () => change(group, topic, true));
      row.append(link, remove);
      list.append(row);
    }
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
    for (const group of Object.keys(groups)) {
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
        activeGroup = event.key === "Home" ? "later" : event.key === "End" ? "favorites" : activeGroup === "later" ? "favorites" : "later";
        render();
        tabs.querySelector(`[data-group="${activeGroup}"]`).focus();
      });
      tabs.append(tab);
    }
    list = element("div", "betterld-library-list");
    list.id = "betterld-library-list";
    list.setAttribute("role", "tabpanel");
    status = element("p", "betterld-library-status");
    status.setAttribute("role", "status");
    panel.append(header, tabs, list, status);
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

  function sync() {
    if (!document.body) return;
    createPanel();
    for (const row of document.querySelectorAll(".betterld-topic-row")) {
      const host = row.querySelector(".betterld-topic-row__actions");
      const id = row.dataset.topicId;
      const title = row.querySelector("a.title")?.textContent.trim();
      if (host && id && title) attachButton(host, "later", { id, title, href: `${location.origin}/t/topic/${id}` });
    }
    syncTopicButton();
    syncButtons();
  }

  globalThis.BETTERLD_LIBRARY = Object.freeze({ sync });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, config.libraryStorageKey)) readLibrary();
    if (fab && Object.hasOwn(changes, config.libraryPositionStorageKey)) readFabPosition();
  });
  readLibrary();
})();
