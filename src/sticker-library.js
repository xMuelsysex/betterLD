(() => {
  "use strict";

  // 个人表情库面板：原站发帖／回复工具栏入口 + Material 3 面板。
  // 图片本体只存在扩展后台的 IndexedDB；这里只拿元数据与缩略图，插入时单独取回那一张。
  const config = globalThis.BETTERLD_CONFIG;
  const sticker = config?.stickerLibrary;
  const store = globalThis.BETTERLD_STICKER_STORE;
  const zip = globalThis.BETTERLD_STICKER_ZIP;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const api = globalThis.browser || globalThis.chrome;
  if (!sticker?.dbName || !store?.classify || !zip?.readEntries || !api?.runtime?.sendMessage) {
    throw new Error("betterLD 表情库模块无法初始化");
  }

  const ALL = "all";
  const UNGROUPED = "none";
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 0-9-9 9 9 0 0 0 9 9Z"/><path d="M8.5 14s1.3 2 3.5 2 3.5-2 3.5-2"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>';

  // 入口只挂在顶层页面与插件自己的主题预览 iframe：其他 iframe 里的编辑器由它们自己那一帧的实例处理。
  if (window !== window.top && !window.frameElement?.matches("iframe[data-betterld-topic-preview]")) {
    return;
  }

  const state = {
    panel: null,
    trigger: null,
    toast: null,
    open: false,
    busy: false,
    folders: [],
    items: [],
    totalBytes: 0,
    activeFolder: ALL,
    manage: false,
    selection: new Set(),
    thumbs: new Map(),
    capacity: store.limits(config.settingsDefaults),
    renderToken: 0,
    viewerToken: 0,
    bridge: null,
    contextImage: null,
    noticeTimer: 0,
    toastTimer: 0
  };

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      try {
        const result = api.runtime.sendMessage(message, (response) => {
          const error = api.runtime.lastError;
          if (error) {
            settle(reject, new Error(error.message));
            return;
          }
          settle(resolve, response);
        });
        if (result?.then) {
          result.then((response) => settle(resolve, response)).catch((error) => settle(reject, error));
        }
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  async function request(message) {
    const response = await sendRuntimeMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "表情库操作失败");
    }
    return response;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function button(className, label, text) {
    const node = element("button", className);
    node.type = "button";
    if (label) {
      node.setAttribute("aria-label", label);
      node.title = label;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  // ---------- 主世界桥接 ----------

  function loadBridge() {
    if (state.bridge) {
      return state.bridge;
    }
    state.bridge = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const onReady = () => {
        window.clearTimeout(timer);
        document.removeEventListener("betterld:sticker-bridge-ready", onReady);
        script.remove();
        resolve();
      };
      const timer = window.setTimeout(() => {
        document.removeEventListener("betterld:sticker-bridge-ready", onReady);
        reject(new Error("表情库桥接加载超时，请刷新页面后重试"));
      }, sticker.bridgeTimeoutMs);
      document.addEventListener("betterld:sticker-bridge-ready", onReady);
      script.src = api.runtime.getURL("src/sticker-composer.js");
      script.onerror = () => {
        window.clearTimeout(timer);
        document.removeEventListener("betterld:sticker-bridge-ready", onReady);
        reject(new Error("表情库桥接脚本加载失败，请刷新页面后重试"));
      };
      document.head.append(script);
    }).catch((error) => {
      state.bridge = null;
      throw error;
    });
    return state.bridge;
  }

  function requestBridge(requestEvent, resultEvent, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error, result) => {
        window.clearTimeout(timer);
        document.removeEventListener(resultEvent, onResult);
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      const onResult = (event) => {
        const detail = JSON.parse(event.detail);
        if (detail.id !== id) {
          return;
        }
        finish(null, detail);
      };
      const timer = window.setTimeout(() => finish(new Error("原站编辑器没有响应，请刷新页面后重试")), timeoutMs);
      document.addEventListener(resultEvent, onResult);
      document.dispatchEvent(new CustomEvent(requestEvent, { detail: JSON.stringify({ ...payload, id }) }));
    });
  }

  async function composerState() {
    await loadBridge();
    const result = await requestBridge("betterld:sticker-state", "betterld:sticker-state-result", {}, sticker.bridgeTimeoutMs);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.state;
  }

  // ---------- 工具栏入口 ----------

  function removeTrigger() {
    state.trigger?.remove();
    state.trigger = null;
  }

  function ensureTrigger() {
    const bar = document.querySelector("#reply-control .d-editor-button-bar");
    if (!bar) {
      if (state.open) {
        closePanel();
      }
      removeTrigger();
      return;
    }
    if (bar.querySelector(".betterld-sticker-trigger")) {
      state.trigger = bar.querySelector(".betterld-sticker-trigger");
      return;
    }
    const node = button("btn no-text btn-icon betterld-sticker-trigger", "个人表情包");
    node.innerHTML = ICON;
    node.setAttribute("aria-expanded", String(state.open));
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.open) {
        closePanel();
      } else {
        openPanel();
      }
    });
    const emoji = bar.querySelector(".emoji-picker-btn");
    if (emoji) {
      emoji.after(node);
    } else {
      bar.append(node);
    }
    state.trigger = node;
  }

  let triggerScheduled = false;
  function scheduleTriggerSync() {
    if (triggerScheduled) {
      return;
    }
    triggerScheduled = true;
    window.setTimeout(() => {
      triggerScheduled = false;
      ensureTrigger();
      positionPanel();
    }, config.syncDebounceMs);
  }

  // ---------- 面板骨架 ----------

  function buildPanel() {
    const panel = element("section", "betterld-sticker-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "个人表情包");
    panel.hidden = true;

    const header = element("header", "betterld-sticker-header");
    const heading = element("div", "betterld-sticker-header__text");
    heading.append(element("h2", "betterld-sticker-header__title", "个人表情包"));
    const capacity = element("p", "betterld-sticker-capacity");
    capacity.dataset.capacity = "true";
    heading.append(capacity);
    const close = button("betterld-sticker-icon", "关闭表情包面板");
    close.dataset.action = "close";
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener("click", () => closePanel());
    header.append(heading, close);

    const groups = element("div", "betterld-sticker-groups");
    groups.setAttribute("role", "tablist");
    groups.setAttribute("aria-label", "表情分组");
    groups.dataset.groups = "true";

    const actions = element("div", "betterld-sticker-actions");
    const importButton = button("betterld-sticker-button", "", "导入图片或 ZIP");
    importButton.dataset.action = "import";
    const manageButton = button("betterld-sticker-button", "", "管理");
    manageButton.dataset.action = "manage";
    const fileInput = element("input", "betterld-sticker-file");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.accept = ".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.zip,.tgs,.json,.mp4,.webm,.mov,.mkv,.avi,image/*,application/zip";
    importButton.addEventListener("click", () => fileInput.click());
    manageButton.addEventListener("click", () => toggleManage());
    fileInput.addEventListener("change", () => {
      const files = [...fileInput.files];
      fileInput.value = "";
      if (files.length) {
        runImport(files);
      }
    });
    const settings = button("betterld-sticker-button", "容量、整库备份与图片域名授权", "设置与备份");
    settings.addEventListener("click", () => {
      request({ type: "open-settings-at", hash: "stickerOrigins" }).catch((error) => setStatus(error.message, "error"));
    });
    actions.append(importButton, manageButton, settings, fileInput);
    const guide = element("details", "betterld-sticker-guide");
    guide.append(element("summary", "", "如何导入 Telegram 表情包？"));
    guide.append(element("p", "", "在 Telegram 下载 Bot 或本地工具中获取图片／ZIP，再点击导入。TGS 和视频需先在外部转换为 GIF 或 WebP；公共 Bot 的可用性由服务方决定。"));
    for (const entry of sticker.acquisitionLinks) {
      const link = element("a", "", entry.label);
      link.href = entry.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      guide.append(link);
    }

    const managebar = element("div", "betterld-sticker-managebar");
    managebar.dataset.managebar = "true";
    managebar.hidden = true;

    const status = element("p", "betterld-sticker-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.status = "true";

    const statusActions = element("div", "betterld-sticker-status-actions");
    statusActions.dataset.statusactions = "true";
    statusActions.hidden = true;

    const details = element("details", "betterld-sticker-details");
    details.dataset.details = "true";
    details.hidden = true;

    const grid = element("div", "betterld-sticker-grid");
    grid.dataset.grid = "true";

    const confirm = element("div", "betterld-sticker-confirm");
    confirm.dataset.confirm = "true";
    confirm.hidden = true;

    const viewer = element("div", "betterld-sticker-viewer");
    viewer.dataset.viewer = "true";
    viewer.hidden = true;
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer || event.target.classList.contains("betterld-sticker-viewer__stage")) {
        hideViewer();
      }
    });

    const controls = element("div", "betterld-sticker-controls");
    controls.append(header, groups, actions, guide, managebar, status, statusActions, details);
    panel.append(controls, grid, confirm, viewer);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!confirm.hidden) {
          hideConfirm();
        } else if (!viewer.hidden) {
          hideViewer();
        } else if (panel.querySelector('.betterld-sticker-tile__menu:not([hidden])')) {
          closeMenus();
        } else {
          closePanel();
        }
      }
    });
    document.body.append(panel);
    state.panel = panel;
    return panel;
  }

  function panelPart(name) {
    return state.panel?.querySelector(`[data-${name}]`) || null;
  }

  function setStatus(message, statusType = "", settingsHash = "") {
    const status = panelPart("status");
    if (status) {
      status.textContent = message;
      if (statusType) {
        status.dataset.state = statusType;
      } else {
        delete status.dataset.state;
      }
    }
    const actions = panelPart("statusactions");
    if (!actions) {
      return;
    }
    if (!settingsHash) {
      actions.hidden = true;
      actions.replaceChildren();
      return;
    }
    const open = button("betterld-sticker-button", "", "打开扩展授权页");
    open.addEventListener("click", async () => {
      try {
        await request({ type: "open-settings-at", hash: settingsHash });
      } catch (error) {
        setStatus(`打开扩展设置页失败：${error.message}`, "error");
      }
    });
    actions.replaceChildren(open);
    actions.hidden = false;
  }

  function setDetails(entries) {
    const details = panelPart("details");
    if (!details) {
      return;
    }
    if (!entries?.length) {
      details.hidden = true;
      details.replaceChildren();
      return;
    }
    const summary = element("summary", "", `逐项结果（${entries.length}）`);
    const list = element("ul", "betterld-sticker-details__list");
    entries.forEach((entry) => {
      list.append(element("li", "", `${entry.name}：${entry.reason}`));
    });
    details.replaceChildren(summary, list);
    details.hidden = false;
  }

  function showToast(message, statusType = "") {
    if (!state.toast) {
      state.toast = element("div", "betterld-sticker-toast");
      state.toast.setAttribute("role", "status");
      state.toast.setAttribute("aria-live", "polite");
      document.body.append(state.toast);
    }
    state.toast.textContent = message;
    state.toast.dataset.state = statusType || "info";
    state.toast.hidden = false;
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      state.toast.hidden = true;
    }, sticker.toastDurationMs);
  }

  function capacityText() {
    const used = store.formatBytes(state.totalBytes);
    const total = store.formatBytes(state.capacity.totalBytes);
    return `${state.items.length} 张 · 已用 ${used} / ${total}（单张上限 ${store.formatBytes(state.capacity.itemBytes)}）`;
  }

  function positionPanel() {
    if (!state.panel || !state.open) {
      return;
    }
    const anchor = state.trigger?.getBoundingClientRect() || document.querySelector("#reply-control")?.getBoundingClientRect();
    const inset = sticker.panelInsetPx;
    const width = Math.min(sticker.panelWidthPx, window.innerWidth - inset * 2);
    const right = Math.min(window.innerWidth - width - inset, Math.max(inset, anchor ? window.innerWidth - anchor.right : inset));
    // 固定面板可视高度，图片网格内部滚动，不随长图、条目数或状态文案跳动。
    const height = Math.min(sticker.panelMaxHeightPx, window.innerHeight - inset * 2);
    const desiredBottom = anchor ? window.innerHeight - anchor.top + sticker.panelGapPx : inset;
    const bottom = Math.min(window.innerHeight - height - inset, Math.max(inset, desiredBottom));
    state.panel.style.width = `${width}px`;
    state.panel.style.right = `${right}px`;
    state.panel.style.bottom = `${bottom}px`;
    state.panel.style.height = `${height}px`;
  }

  async function readCapacity() {
    const stored = await api.storage.local.get(config.storageKey);
    state.capacity = store.limits(settingsApi.normalizeSettings(stored[config.storageKey]));
  }

  async function openPanel() {
    if (!state.panel) {
      buildPanel();
    }
    state.open = true;
    state.panel.hidden = false;
    state.trigger?.setAttribute("aria-expanded", "true");
    positionPanel();
    await refreshPanel();
    panelPart("grid")?.scrollTo?.({ top: 0 });
  }

  function closePanel(restoreFocus = true) {
    if (!state.open || !state.panel) {
      return;
    }
    state.open = false;
    state.panel.hidden = true;
    state.trigger?.setAttribute("aria-expanded", "false");
    closeMenus();
    hideViewer();
    hideConfirm();
    if (restoreFocus) document.querySelector("#reply-control textarea.d-editor-input")?.focus();
  }

  async function refreshPanel() {
    if (!state.open) {
      return;
    }
    try {
      await readCapacity();
      const response = await request({ type: "sticker-list" });
      state.folders = response.folders;
      state.items = response.items;
      state.totalBytes = response.totalBytes;
      if (state.activeFolder !== ALL && state.activeFolder !== UNGROUPED && !state.folders.some((folder) => folder.id === state.activeFolder)) {
        state.activeFolder = ALL;
      }
      for (const id of [...state.selection]) {
        if (!state.items.some((item) => item.id === id)) {
          state.selection.delete(id);
        }
      }
      renderPanel();
    } catch (error) {
      setStatus(`表情库读取失败：${error.message}`, "error");
    }
  }

  // ---------- 渲染 ----------

  function visibleItems() {
    if (state.activeFolder === ALL) {
      return state.items;
    }
    if (state.activeFolder === UNGROUPED) {
      return state.items.filter((item) => !item.folderId);
    }
    return state.items.filter((item) => item.folderId === state.activeFolder);
  }

  function renderPanel() {
    renderCapacity();
    renderGroups();
    renderManageBar();
    renderGrid();
    loadThumbs();
  }

  function renderCapacity() {
    const capacity = panelPart("capacity");
    if (capacity) {
      capacity.textContent = capacityText();
    }
  }

  function renderGroups() {
    const container = panelPart("groups");
    if (!container) {
      return;
    }
    const chips = [];
    const addChip = (id, label, count) => {
      const chip = button("betterld-sticker-chip", "", `${label} ${count}`);
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", String(state.activeFolder === id));
      chip.addEventListener("click", () => {
        state.activeFolder = id;
        renderPanel();
      });
      chips.push(chip);
    };
    addChip(ALL, "全部", state.items.length);
    addChip(UNGROUPED, "未分组", state.items.filter((item) => !item.folderId).length);
    state.folders.forEach((folder) => {
      addChip(folder.id, folder.name, state.items.filter((item) => item.folderId === folder.id).length);
    });
    container.replaceChildren(...chips);
  }

  function renderManageBar() {
    const bar = panelPart("managebar");
    if (!bar) {
      return;
    }
    const manageButton = state.panel.querySelector('[data-action="manage"]');
    if (manageButton) {
      manageButton.textContent = state.manage ? "退出管理" : "管理";
      manageButton.setAttribute("aria-pressed", String(state.manage));
    }
    if (!state.manage) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    const selected = state.selection.size;
    const actions = element("div", "betterld-sticker-managebar__row");
    const selectAll = button("betterld-sticker-button", "", selected === visibleItems().length && selected > 0 ? "取消全选" : "全选");
    selectAll.addEventListener("click", () => {
      const visible = visibleItems();
      if (selected === visible.length && selected > 0) {
        visible.forEach((item) => state.selection.delete(item.id));
      } else {
        visible.forEach((item) => state.selection.add(item.id));
      }
      renderPanel();
    });
    const moveSelect = element("select", "betterld-sticker-select");
    moveSelect.setAttribute("aria-label", "移动到分组");
    moveSelect.append(new Option("移动到分组…", ""));
    moveSelect.append(new Option("未分组", UNGROUPED));
    state.folders.forEach((folder) => moveSelect.append(new Option(folder.name, folder.id)));
    moveSelect.disabled = selected === 0;
    moveSelect.addEventListener("change", () => {
      const value = moveSelect.value;
      if (!value) {
        return;
      }
      moveSelection(value === UNGROUPED ? null : value);
    });
    const remove = button("betterld-sticker-button betterld-sticker-button--danger", "", `删除所选（${selected}）`);
    remove.disabled = selected === 0;
    remove.addEventListener("click", () => {
      removeSelection();
    });
    actions.append(selectAll, moveSelect, remove);

    const groups = element("div", "betterld-sticker-managebar__row");
    const create = button("betterld-sticker-button", "", "新建分组");
    create.addEventListener("click", () => startFolderForm("create"));
    const rename = button("betterld-sticker-button", "", "重命名当前分组");
    rename.disabled = state.activeFolder === ALL || state.activeFolder === UNGROUPED;
    rename.addEventListener("click", () => startFolderForm("rename", state.folders.find((item) => item.id === state.activeFolder)));
    const drop = button("betterld-sticker-button betterld-sticker-button--danger", "", "删除当前分组");
    drop.disabled = state.activeFolder === ALL || state.activeFolder === UNGROUPED;
    drop.addEventListener("click", () => deleteActiveFolder());
    groups.append(create, rename, drop);

    bar.replaceChildren(actions, groups);
    bar.hidden = false;
  }

  function closeMenus() {
    state.panel?.querySelectorAll('.betterld-sticker-tile__menu:not([hidden])').forEach((menu) => {
      menu.hidden = true;
      menu.closest(".betterld-sticker-tile").querySelector('[aria-expanded]').setAttribute("aria-expanded", "false");
    });
  }

  function tileFor(item) {
    const tile = element("article", "betterld-sticker-tile");
    tile.dataset.id = item.id;
    tile.dataset.selected = String(state.selection.has(item.id));

    const main = button("betterld-sticker-tile__main", `插入「${item.name}」`);
    const image = element("img", "betterld-sticker-tile__image");
    image.alt = "";
    const cached = state.thumbs.get(item.id);
    if (cached) {
      image.src = cached;
    } else {
      tile.dataset.pending = "true";
    }
    main.append(image);
    main.disabled = state.busy;
    main.addEventListener("click", () => {
      if (state.manage) {
        toggleSelection(item.id);
      } else {
        insertSticker(item);
      }
    });

    const name = element("p", "betterld-sticker-tile__name", item.name);
    name.title = `${item.name} · ${store.formatBytes(item.size)}`;
    if (item.type === "image/gif") {
      // 动图在网格里只显示首帧，完整动画在「预览」里按原图播放
      tile.dataset.animated = "true";
    }

    const tools = element("div", "betterld-sticker-tile__tools");
    const preview = button("betterld-sticker-tile__tool", `预览「${item.name}」`);
    preview.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    preview.addEventListener("click", () => openViewer(item));
    const more = button("betterld-sticker-tile__tool", `更多操作：「${item.name}」`);
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
    more.setAttribute("aria-expanded", "false");
    tools.append(preview, more);

    const menu = element("div", "betterld-sticker-tile__menu");
    menu.hidden = true;
    more.addEventListener("click", () => {
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      more.setAttribute("aria-expanded", String(open));
    });
    const rename = button("betterld-sticker-menu__item", "", "重命名");
    rename.addEventListener("click", () => {
      closeMenus();
      startRename(tile, item);
    });
    const move = button("betterld-sticker-menu__item", "", "移动到分组");
    move.addEventListener("click", () => {
      closeMenus();
      startMove(tile, item);
    });
    const drop = button("betterld-sticker-menu__item betterld-sticker-menu__item--danger", "", "删除");
    drop.addEventListener("click", () => {
      closeMenus();
      confirmDialog("删除表情", `删除「${item.name}」？图片会从本机表情库移除，已插入到帖子里的图片不受影响。`, async () => {
        await request({ type: "sticker-delete", ids: [item.id] });
        state.thumbs.delete(item.id);
        await refreshPanel();
        setStatus(`已删除「${item.name}」`, "success");
      });
    });
    menu.append(rename, move, drop);

    const select = element("label", "betterld-sticker-tile__select");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selection.has(item.id);
    checkbox.setAttribute("aria-label", `选择「${item.name}」`);
    checkbox.addEventListener("change", () => toggleSelection(item.id));
    select.append(checkbox);
    select.hidden = !state.manage;

    tile.append(main, name, tools, menu, select);
    return tile;
  }

  function renderGrid() {
    const grid = panelPart("grid");
    if (!grid) {
      return;
    }
    const items = visibleItems();
    if (!items.length) {
      const empty = element("p", "betterld-sticker-empty", state.items.length
        ? "这个分组还没有表情。"
        : "还没有表情。用「导入图片或 ZIP」加入本机表情，或在帖子图片上右键选择「保存到表情包面板」。");
      grid.replaceChildren(empty);
      return;
    }
    grid.replaceChildren(...items.map((item) => tileFor(item)));
  }

  function toggleSelection(id) {
    if (state.selection.has(id)) {
      state.selection.delete(id);
    } else {
      state.selection.add(id);
    }
    renderPanel();
  }

  function toggleManage() {
    state.manage = !state.manage;
    if (!state.manage) {
      state.selection.clear();
    }
    renderPanel();
  }

  // ---------- 缩略图 ----------

  async function loadThumbs() {
    if (!state.open) {
      return;
    }
    const token = ++state.renderToken;
    const missing = visibleItems().filter((item) => !state.thumbs.has(item.id)).map((item) => item.id);
    for (let index = 0; index < missing.length; index += sticker.thumbBatchSize) {
      const chunk = missing.slice(index, index + sticker.thumbBatchSize);
      let response;
      try {
        response = await request({ type: "sticker-thumbs", ids: chunk });
      } catch (error) {
        setStatus(`缩略图读取失败：${error.message}`, "error");
        return;
      }
      if (token !== state.renderToken || !state.open) {
        return;
      }
      response.thumbs.forEach((thumb) => state.thumbs.set(thumb.id, thumb.dataUrl));
      applyThumbs(chunk);
    }
  }

  function applyThumbs(ids) {
    const grid = panelPart("grid");
    if (!grid) {
      return;
    }
    ids.forEach((id) => {
      const tile = grid.querySelector(`[data-id="${id}"]`);
      const image = tile?.querySelector(".betterld-sticker-tile__image");
      const cached = state.thumbs.get(id);
      if (image && cached) {
        image.src = cached;
        delete tile.dataset.pending;
      }
    });
  }

  // ---------- 预览与确认 ----------

  async function openViewer(item) {
    const viewer = panelPart("viewer");
    if (!viewer) {
      return;
    }
    if (!viewer.hidden && viewer.dataset.itemId === item.id) {
      hideViewer();
      return;
    }
    closeMenus();
    const token = ++state.viewerToken;
    viewer.dataset.itemId = item.id;
    viewer.hidden = false;
    const stage = element("div", "betterld-sticker-viewer__stage");
    stage.append(element("p", "betterld-sticker-viewer__status", "正在读取原图…"));
    const caption = element("p", "betterld-sticker-viewer__caption", `${item.name} · ${store.formatBytes(item.size)} · ${item.type}`);
    const close = button("betterld-sticker-button", "关闭图片预览", "关闭预览");
    close.addEventListener("click", () => hideViewer());
    viewer.replaceChildren(stage, caption, close);
    close.focus();
    try {
      const response = await request({ type: "sticker-blob", id: item.id });
      if (token !== state.viewerToken) return;
      const image = element("img", "betterld-sticker-viewer__image");
      image.src = response.dataUrl;
      image.alt = item.name;
      image.addEventListener("click", () => hideViewer());
      stage.replaceChildren(image);
    } catch (error) {
      if (token !== state.viewerToken) return;
      stage.replaceChildren(element("p", "betterld-sticker-viewer__status", `原图读取失败：${error.message}`));
    }
  }

  function hideViewer() {
    state.viewerToken += 1;
    const viewer = panelPart("viewer");
    if (viewer) {
      const restoreFocus = state.open && viewer.contains(document.activeElement);
      const tile = panelPart("grid")?.querySelector(`[data-id="${viewer.dataset.itemId}"]`);
      viewer.hidden = true;
      delete viewer.dataset.itemId;
      viewer.replaceChildren();
      if (restoreFocus) tile?.querySelector(".betterld-sticker-tile__tool")?.focus();
    }
  }

  function hideConfirm() {
    const confirm = panelPart("confirm");
    if (confirm) {
      confirm.hidden = true;
      confirm.replaceChildren();
    }
  }

  function confirmDialog(title, message, onConfirm) {
    const confirm = panelPart("confirm");
    if (!confirm) {
      return;
    }
    const box = element("div", "betterld-sticker-confirm__box");
    box.append(element("p", "betterld-sticker-confirm__title", title));
    box.append(element("p", "betterld-sticker-confirm__message", message));
    const actions = element("div", "betterld-sticker-confirm__actions");
    const cancel = button("betterld-sticker-button", "", "取消");
    cancel.addEventListener("click", () => hideConfirm());
    const accept = button("betterld-sticker-button betterld-sticker-button--danger", "", "确认删除");
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      try {
        await onConfirm();
      } catch (error) {
        setStatus(`操作失败：${error.message}`, "error");
      }
      hideConfirm();
    });
    actions.append(cancel, accept);
    box.append(actions);
    confirm.replaceChildren(box);
    confirm.hidden = false;
    accept.focus();
  }

  // ---------- 插入 ----------

  async function insertSticker(item) {
    if (state.busy) {
      setStatus("上一张表情还在处理中，请稍候。", "error");
      return;
    }
    state.busy = true;
    renderGrid();
    setStatus(`正在上传「${item.name}」到 LinuxDo…`);
    try {
      const composer = await composerState();
      if (!composer.open) {
        throw new Error("请先在页面上打开回复编辑器，再点击表情");
      }
      const blob = await request({ type: "sticker-blob", id: item.id });
      const base64 = String(blob.dataUrl).slice(String(blob.dataUrl).indexOf(",") + 1);
      const result = await requestBridge("betterld:sticker-upload", "betterld:sticker-upload-result", {
        captureId: composer.captureId,
        fileName: store.fileNameFor(item),
        mime: item.type,
        base64,
        timeoutMs: sticker.uploadTimeoutMs
      }, sticker.uploadTimeoutMs + sticker.bridgeTimeoutMs);
      if (!result.ok) {
        throw new Error(result.error || "上传失败");
      }
      const notice = `已把「${item.name}」插入草稿光标处，未发送。`;
      setStatus(notice, "success");
      if (!state.open) showToast(notice, "success");
      document.querySelector("#reply-control textarea.d-editor-input")?.focus();
    } catch (error) {
      const notice = `「${item.name}」未插入：${error.message}`;
      setStatus(notice, "error");
      if (!state.open) showToast(notice, "error");
    } finally {
      state.busy = false;
      renderGrid();
    }
  }

  // ---------- 管理动作 ----------

  function startRename(tile, item) {
    const form = element("form", "betterld-sticker-inline");
    const input = element("input", "betterld-sticker-input");
    input.type = "text";
    input.value = item.name;
    input.maxLength = sticker.nameMaxLength;
    input.setAttribute("aria-label", "新的表情名称");
    const accept = button("betterld-sticker-button", "", "保存");
    accept.type = "submit";
    const cancel = button("betterld-sticker-button", "", "取消");
    cancel.addEventListener("click", () => form.remove());
    form.append(input, accept, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      accept.disabled = true;
      try {
        await request({ type: "sticker-rename", id: item.id, name: input.value });
        await refreshPanel();
        setStatus(`已改名为「${input.value.trim()}」`, "success");
      } catch (error) {
        setStatus(`改名失败：${error.message}`, "error");
        accept.disabled = false;
      }
    });
    tile.append(form);
    input.focus();
    input.select();
  }

  function startMove(tile, item) {
    const form = element("form", "betterld-sticker-inline");
    const select = element("select", "betterld-sticker-select");
    select.setAttribute("aria-label", "移动到分组");
    select.append(new Option("未分组", UNGROUPED));
    state.folders.forEach((folder) => select.append(new Option(folder.name, folder.id)));
    select.value = item.folderId || UNGROUPED;
    const accept = button("betterld-sticker-button", "", "移动");
    accept.type = "submit";
    const cancel = button("betterld-sticker-button", "", "取消");
    cancel.addEventListener("click", () => form.remove());
    form.append(select, accept, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      accept.disabled = true;
      try {
        await request({ type: "sticker-move", ids: [item.id], folderId: select.value === UNGROUPED ? null : select.value });
        await refreshPanel();
        setStatus(`已把「${item.name}」移动到「${select.selectedOptions[0]?.textContent || "未分组"}」`, "success");
      } catch (error) {
        setStatus(`移动失败：${error.message}`, "error");
        accept.disabled = false;
      }
    });
    tile.append(form);
    select.focus();
  }

  async function moveSelection(folderId) {
    const ids = [...state.selection];
    if (!ids.length) {
      return;
    }
    try {
      const result = await request({ type: "sticker-move", ids, folderId });
      state.selection.clear();
      await refreshPanel();
      setStatus(`已移动 ${result.moved} 张表情`, "success");
    } catch (error) {
      setStatus(`移动失败：${error.message}`, "error");
    }
  }

  function removeSelection() {
    const ids = [...state.selection];
    if (!ids.length) {
      return;
    }
    confirmDialog("删除所选表情", `删除所选的 ${ids.length} 张表情？图片会从本机表情库移除，已插入到帖子里的图片不受影响。`, async () => {
      const result = await request({ type: "sticker-delete", ids });
      ids.forEach((id) => state.thumbs.delete(id));
      state.selection.clear();
      await refreshPanel();
      setStatus(`已删除 ${result.removed} 张表情`, "success");
    });
  }

  // 分组新建与改名都用面板内联表单，不弹浏览器原生对话框。
  function startFolderForm(mode, folder) {
    const bar = panelPart("managebar");
    if (!bar) {
      return;
    }
    const form = element("form", "betterld-sticker-inline");
    const input = element("input", "betterld-sticker-input");
    input.type = "text";
    input.value = mode === "rename" && folder ? folder.name : "";
    input.placeholder = mode === "rename" ? "新的分组名称" : "新分组名称";
    input.maxLength = sticker.folderNameMaxLength;
    input.setAttribute("aria-label", mode === "rename" ? "新的分组名称" : "新分组名称");
    const accept = button("betterld-sticker-button", "", mode === "rename" ? "保存" : "新建");
    accept.type = "submit";
    const cancel = button("betterld-sticker-button", "", "取消");
    cancel.addEventListener("click", () => renderPanel());
    form.append(input, accept, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      accept.disabled = true;
      try {
        if (mode === "rename") {
          await request({ type: "sticker-folder-rename", id: folder.id, name: input.value });
          await refreshPanel();
          setStatus("分组已改名", "success");
        } else {
          const result = await request({ type: "sticker-folder-create", name: input.value });
          state.activeFolder = result.folder.id;
          await refreshPanel();
          setStatus(`已新建分组「${result.folder.name}」`, "success");
        }
      } catch (error) {
        setStatus(`${mode === "rename" ? "分组改名" : "新建分组"}失败：${error.message}`, "error");
        accept.disabled = false;
      }
    });
    bar.append(form);
    input.focus();
    input.select();
  }

  function deleteActiveFolder() {
    const folder = state.folders.find((item) => item.id === state.activeFolder);
    if (!folder) {
      return;
    }
    const count = state.items.filter((item) => item.folderId === folder.id).length;
    confirmDialog("删除分组", `删除分组「${folder.name}」？组内 ${count} 张表情会保留并移动到未分组。`, async () => {
      const result = await request({ type: "sticker-folder-delete", id: folder.id });
      state.activeFolder = ALL;
      await refreshPanel();
      setStatus(`已删除分组「${folder.name}」，${result.movedItems} 张表情移到未分组`, "success");
    });
  }

  // ---------- 导入 ----------

  async function fileBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  async function importEntry({ name, type, bytes }, summary) {
    const classified = store.classify(name, type);
    if (!classified.ok) {
      summary.failed.push({ name, reason: classified.reason });
      return;
    }
    const sizeError = store.checkItemSize(bytes.byteLength, state.capacity);
    if (sizeError) {
      summary.failed.push({ name, reason: sizeError });
      return;
    }
    try {
      const result = await request({
        type: "sticker-save",
        name: name.replace(/\.[A-Za-z0-9]{1,8}$/, ""),
        mime: classified.mime,
        folderId: state.activeFolder === ALL || state.activeFolder === UNGROUPED ? null : state.activeFolder,
        base64: store.bytesToBase64(bytes)
      });
      if (result.status === "duplicate") {
        summary.duplicates.push(name);
      } else {
        summary.added.push(name);
      }
    } catch (error) {
      summary.failed.push({ name, reason: error.message });
    }
  }

  async function importArchive(file, summary) {
    let bytes;
    let entries;
    try {
      bytes = await fileBytes(file);
      entries = zip.readEntries(bytes);
    } catch (error) {
      summary.failed.push({ name: file.name, reason: error.message });
      return;
    }
    for (const entry of entries) {
      if (zip.isDirectory(entry)) {
        continue;
      }
      const entryName = zip.baseName(entry.name);
      if (entry.reason) {
        summary.failed.push({ name: entryName, reason: entry.reason });
        continue;
      }
      let content;
      try {
        content = await zip.readEntry(bytes, entry, state.capacity.itemBytes);
      } catch (error) {
        summary.failed.push({ name: entryName, reason: error.message });
        continue;
      }
      await importEntry({ name: entryName, type: "", bytes: content }, summary);
    }
  }

  function importSummaryText(summary) {
    return `导入完成：成功 ${summary.added.length}，重复跳过 ${summary.duplicates.length}，失败 ${summary.failed.length}`;
  }

  async function runImport(files) {
    if (state.busy) {
      setStatus("上一批导入还在进行中，请稍候。", "error");
      return;
    }
    if (files.length > sticker.importMaxFiles) {
      setStatus(`一次最多导入 ${sticker.importMaxFiles} 个文件，当前选择了 ${files.length} 个。`, "error");
      return;
    }
    state.busy = true;
    setDetails([]);
    const summary = { added: [], duplicates: [], failed: [] };
    setStatus(`正在导入 ${files.length} 个文件…`);
    try {
      for (const [index, file] of files.entries()) {
        setStatus(`正在导入 ${index + 1}/${files.length}：${file.name}`);
        try {
          if (zip.isZipName(file.name)) {
            await importArchive(file, summary);
          } else {
            await importEntry({ name: file.name, type: file.type, bytes: await fileBytes(file) }, summary);
          }
        } catch (error) {
          summary.failed.push({ name: file.name, reason: error.message || "读取文件失败" });
        }
      }
      await refreshPanel();
      const resultType = summary.failed.length ? "error" : "success";
      setStatus(importSummaryText(summary), resultType);
      if (!state.open) showToast(importSummaryText(summary), resultType);
      setDetails(summary.failed.map((entry) => ({ name: entry.name, reason: entry.reason })));
    } finally {
      state.busy = false;
      renderGrid();
    }
  }

  // ---------- 原站图片右键目标 ----------

  function isPostBodyImage(image) {
    if (!image.closest(".cooked, .betterld-reply-tree__cooked, .discourse-boosts__cooked")) {
      return false;
    }
    return !image.closest(".topic-avatar, .avatar-flair, .user-card, .badge, .d-header, header, nav, .betterld-library-panel, .betterld-sticker-panel");
  }

  function contextImageName(image, link, url) {
    const candidates = [link?.getAttribute("title"), image.getAttribute("alt")];
    try {
      candidates.push(decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || ""));
    } catch {
      candidates.push("");
    }
    for (const candidate of candidates) {
      const cleaned = String(candidate || "")
        .replace(/\.[A-Za-z0-9]{1,8}$/, "")
        .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) {
        return cleaned.slice(0, sticker.nameMaxLength);
      }
    }
    return "未命名表情";
  }

  // 右键目标只认原生 contextmenu 实际命中的那个 img：不按 URL 搜其他节点，避免头像与正文共用同一地址时误判。
  function resolveContextImage(srcUrl) {
    const image = state.contextImage;
    if (!image || !image.isConnected || !isPostBodyImage(image)) {
      return { ok: false, error: "这里不是帖子正文里的图片，未保存" };
    }
    if (srcUrl && image.currentSrc !== srcUrl && image.src !== srcUrl) {
      return { ok: false, error: "右键的图片与当前页面不一致，未保存" };
    }
    const link = image.closest("a.lightbox");
    const url = link?.href || image.dataset.largeImage || image.currentSrc || image.src;
    if (!url) {
      return { ok: false, error: "找不到这张图片的地址，未保存" };
    }
    return { ok: true, url: new URL(url, location.href).href, name: contextImageName(image, link, url) };
  }

  // Chrome 没有 onShown：指针进入图片时提前更新，右键事件仍精确记录实际目标。
  let hoveredImage = null;
  document.addEventListener("pointerover", (event) => {
    const target = event.target instanceof Element ? event.target.closest("img") : null;
    const image = target && isPostBodyImage(target) ? target : null;
    if (image === hoveredImage) return;
    hoveredImage = image;
    sendRuntimeMessage({ type: "sticker-context-menu", visible: Boolean(image) }).catch((error) => {
      console.warn("[betterLD] 表情库菜单预更新失败", error);
    });
  }, true);

  // 原生右键菜单在页面事件之后弹出：这里先判定目标是否为正文图片，再决定两项菜单是否可见。
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target.closest("img") : null;
    const image = target && isPostBodyImage(target) ? target : null;
    state.contextImage = image;
    // 每次右键都同步一次可见性：后台被浏览器回收后菜单会重建为隐藏，不能只按本地状态去重。
    sendRuntimeMessage({ type: "sticker-context-menu", visible: Boolean(image) }).then((response) => {
      if (response?.ok === false) {
        console.warn("[betterLD] 表情库右键菜单显隐失败", response.error);
      }
    }).catch((error) => {
      console.warn("[betterLD] 表情库右键菜单显隐失败", error);
    });
  }, true);

  // ---------- 启动 ----------

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "sticker-context-image") {
      sendResponse(resolveContextImage(message.srcUrl));
      return true;
    }
    if (message?.type === "sticker-changed") {
      if (state.open) {
        refreshPanel();
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "sticker-notice") {
      if (state.open) {
        setStatus(message.message, message.status === "error" ? "error" : "success", message.openSettings);
        if (message.refresh) {
          refreshPanel();
        }
      } else {
        showToast(message.message, message.status === "error" ? "error" : "success");
      }
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  api.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[config.storageKey] && state.open) {
      refreshPanel();
    }
  });

  function dismissOutside(event) {
    if (!state.open) return;
    const target = event.target;
    if (!target.closest('.betterld-sticker-tile__menu, .betterld-sticker-tile__tool[aria-expanded]')) {
      closeMenus();
    }
    if (!state.panel.contains(target) && !state.trigger?.contains(target)) {
      // 外部点击继续交给原目标处理，不把焦点抢回编辑器。
      closePanel(false);
    }
  }

  // 捕获阶段先收起，原站 stopPropagation 不会挡住；click 同时覆盖键盘激活。
  document.addEventListener("pointerdown", dismissOutside, true);
  document.addEventListener("click", dismissOutside, true);

  window.addEventListener("resize", positionPanel);
  window.addEventListener("scroll", positionPanel, true);

  const observer = new MutationObserver(scheduleTriggerSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureTrigger();
})();
