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
    const className = group === "favorites"
      ? "betterld-library-save betterld-library-topic-action btn btn-default topic-footer-button"
      : "betterld-library-save";
    button = element("button", className, groups[group]);
    button.type = "button";
    button.dataset.libraryGroup = group;
    button.dataset.libraryId = topic.id;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      change(group, topic, button.getAttribute("aria-pressed") === "true");
    });
    if (group === "favorites") host.append(button);
    else host.prepend(button);
  }

  function syncTopicButton() {
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.exec(location.pathname);
    const old = document.querySelector(".betterld-library-topic-action");
    if (!match) { old?.remove(); return; }
    // 原站到页底时会卸载正文标题，并把同一主题标题放进顶栏。
    const title = document.querySelector(`#topic-title h1, .d-header .header-title .topic-link[data-topic-id="${match[1]}"]`)?.textContent.trim();
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
      return;
    }
    if (!library[activeGroup].length) {
      list.append(element("p", "betterld-library-empty", activeGroup === "later" ? "在首页点击「稍后再看」，主题就会保存在这里。" : "在帖子底部操作栏点击「收藏」，主题就会保存在这里。"));
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
  }

  function createPanel() {
    if (window !== window.top || fab) return;
    document.body.classList.add("betterld-has-library");
    fab = element("button", "betterld-library-fab");
    fab.type = "button";
    fab.append(icon());
    fab.setAttribute("aria-label", "打开收藏库：稍后再看与收藏");
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
    fab.addEventListener("click", () => panel.hidden ? showPanel() : closePanel());
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
    if (area === "local" && Object.hasOwn(changes, config.libraryStorageKey)) readLibrary();
  });
  readLibrary();
})();
