(() => {
  "use strict";

  const pageDocument = globalThis.document;
  const root = globalThis.BETTERLD_OPTIONS_ROOT || pageDocument;
  const isEmbedded = root !== pageDocument;
  const document = isEmbedded
    ? new Proxy(pageDocument, {
      get(target, property) {
        if (property === "querySelector" || property === "querySelectorAll") {
          return root[property].bind(root);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
    : pageDocument;
  const config = globalThis.BETTERLD_CONFIG;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const ruleGroupKeys = (config?.topicRuleGroups || []).map((group) => group.key);
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);
  const normalizeSettings = settingsApi?.normalizeSettings;
  const modes = config?.wallpaperModes;
  const catalog = config?.wallpaperCatalog || [];
  if (!isEmbedded && new URLSearchParams(location.search).get("embedded") === "1") {
    document.documentElement.dataset.betterldEmbedded = "true";
  }

  if (!config || !settingsApi || typeof normalizeSettings !== "function" || !api || !modes) {
    throw new Error("betterLD settings could not initialize: extension API is unavailable");
  }

  const settingsRailList = document.querySelector("#settings-rail-list");
  const settingsSubnav = document.querySelector("#settings-subnav");
  const settingsBreadcrumb = document.querySelector("#settings-breadcrumb");
  const settingsSectionHeading = document.querySelector("#settings-section-heading");
  const settingsSearchInput = document.querySelector("#settings-search-input");
  const settingsSearchResults = document.querySelector("#settings-search-results");
  const settingsScroll = document.querySelector("#settings-scroll");
  const settingsClose = document.querySelector("#settings-close");
  const settingsPageBody = document.querySelector("#settings-page-body");
  const settingsWindow = document.querySelector(".settings-window");
  const wallpaperSources = document.querySelector("#wallpaper-sources");
  const wallpaperRandomPanel = document.querySelector("#wallpaper-random-panel");
  const wallpaperRandomPreview = document.querySelector("#wallpaper-random-preview");
  const wallpaperBuiltInPanel = document.querySelector("#wallpaper-built-in-panel");
  const wallpaperCatalog = document.querySelector("#wallpaper-catalog");
  const wallpaperUrlPanel = document.querySelector("#wallpaper-url-panel");
  const wallpaperLocalPanel = document.querySelector("#wallpaper-local-panel");
  const wallpaperFile = document.querySelector("#wallpaper-file");
  const chooseWallpaperFile = document.querySelector("#choose-wallpaper-file");
  const wallpaperLocalPreview = document.querySelector("#wallpaper-local-preview");
  const wallpaperLocalImage = document.querySelector("#wallpaper-local-image");
  const wallpaperLocalName = document.querySelector("#wallpaper-local-name");
  const removeLocalWallpaper = document.querySelector("#remove-local-wallpaper");
  const wallpaperStatus = document.querySelector("#wallpaper-status");
  const reset = document.querySelector("#reset");
  const status = document.querySelector("#settings-status");

  let wallpaper = null;

  const sourceOptions = [
    { mode: modes.none, label: "内置渐变", description: "不使用图片" },
    { mode: modes.random, label: "网站随机图片", description: "每天固定一张" },
    { mode: modes.builtin, label: "内置图片", description: "使用 BewlyCat 图片目录" },
    { mode: modes.url, label: "远程图片", description: "输入 HTTPS URL" },
    { mode: modes.local, label: "本地图片", description: "仅保存在本机" }
  ];

  const state = {
    settings: normalizeSettings(config.settingsDefaults),
    selectedWallpaperId: "",
    localWallpaper: null,
    removeLocalWallpaper: false,
    wallpaperProbeTimer: 0,
    wallpaperProbeId: 0,
    syncBusy: false,
    activeStorageArea: "local",
    syncMetadata: { updatedAt: 0, origin: "" },
    language: "zh-CN"
  };

  let toastTimer = 0;

  function setStatusMessage(element, message, statusType = "") {
    element.textContent = message;
    element.hidden = !message;
    if (statusType) {
      element.dataset.status = statusType;
    } else {
      delete element.dataset.status;
    }
    if (element === status) {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = 0;
      }
      if (message) {
        toastTimer = window.setTimeout(() => {
          toastTimer = 0;
          status.hidden = true;
        }, 2600);
      }
    }
  }

  function storageGet(keys) {
    if (firefoxApi) {
      return api.storage.local.get(keys);
    }

    return new Promise((resolve, reject) => {
      api.storage.local.get(keys, (value) => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(value);
      });
    });
  }

  function storageSet(value) {
    if (firefoxApi) {
      return api.storage.local.set(value);
    }

    return new Promise((resolve, reject) => {
      api.storage.local.set(value, () => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageRemove(key) {
    if (firefoxApi) {
      return api.storage.local.remove(key);
    }

    return new Promise((resolve, reject) => {
      api.storage.local.remove(key, () => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function syncGet(keys) {
    if (!api.storage?.sync) {
      return Promise.reject(new Error("浏览器不支持 storage.sync"));
    }
    if (firefoxApi) {
      return api.storage.sync.get(keys);
    }
    return new Promise((resolve, reject) => {
      api.storage.sync.get(keys, (value) => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(value);
      });
    });
  }

  async function getActiveSettings() {
    const useSync = state.settings.syncEnabled && state.activeStorageArea === "sync";
    const stored = useSync
      ? await syncGet([config.storageKey])
      : await storageGet([config.storageKey]);
    const raw = stored?.[config.storageKey];
    state.activeStorageArea = useSync && raw ? "sync" : "local";
    return {
      area: state.activeStorageArea,
      settings: normalizeSettings(raw || state.settings)
    };
  }

  function syncSet(value) {
    if (!api.storage?.sync) {
      return Promise.reject(new Error("浏览器不支持 storage.sync"));
    }
    if (firefoxApi) {
      return api.storage.sync.set(value);
    }
    return new Promise((resolve, reject) => {
      api.storage.sync.set(value, () => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function syncBytesInUse(keys = null) {
    if (!api.storage?.sync?.getBytesInUse) {
      return Promise.resolve(0);
    }
    if (firefoxApi) {
      return api.storage.sync.getBytesInUse(keys);
    }
    return new Promise((resolve, reject) => {
      api.storage.sync.getBytesInUse(keys, (bytes) => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(Number(bytes) || 0);
      });
    });
  }

  function serializedBytes(value) {
    const serialized = JSON.stringify(value);
    return globalThis.TextEncoder ? new TextEncoder().encode(serialized).length : serialized.length * 2;
  }

  async function ensureSyncCapacity(settings) {
    if (!settings.syncEnabled || state.settings.syncEnabled || !api.storage?.sync?.getBytesInUse) {
      return;
    }
    const currentBytes = await syncBytesInUse(null);
    const projectedBytes = serializedBytes({
      [config.storageKey]: settingsApi.toSyncSettings(settings),
      [config.syncMetadataKey]: { updatedAt: Date.now(), origin: syncOrigin }
    });
    if (currentBytes + projectedBytes > config.syncQuotaBytes) {
      throw new Error(`同步配置超出浏览器配额（${config.syncQuotaBytes} bytes）`);
    }
  }

  function catalogItem(id, mode) {
    return catalog.find((item) => item.id === id && (!mode || item.mode === mode)) || null;
  }

  function randomWallpaper() {
    return catalog.find((item) => item.mode === modes.random) || null;
  }

  function firstBuiltInWallpaper() {
    return catalog.find((item) => item.mode === modes.builtin) || null;
  }

  function localDateKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function randomPreviewUrl() {
    const random = randomWallpaper();
    const date = localDateKey();
    if (state.settings.wallpaperMode === modes.random
      && state.settings.wallpaperRandomDate === date
      && state.settings.wallpaperRandomUrl) {
      return state.settings.wallpaperRandomUrl;
    }
    const pattern = String(config.wallpaperRandomSeedPattern || "").replace("{date}", encodeURIComponent(date));
    return storedWallpaperUrl(pattern) || random?.thumbnail || random?.url || "";
  }

  function normalizeWallpaper(value) {
    const input = String(value || "").trim();
    if (!input) {
      throw new Error("请填写 HTTPS 图片地址");
    }

    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error("请输入有效的图片 URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("背景图片必须使用 HTTPS 地址");
    }
    return url.href;
  }

  function storedWallpaperUrl(value) {
    const input = String(value || "").trim();
    if (!input) {
      return "";
    }

    try {
      return new URL(input).protocol === "https:" ? new URL(input).href : "";
    } catch {
      return "";
    }
  }

  function selectedMode() {
    return wallpaperSources.querySelector('input[name="wallpaperMode"]:checked')?.value || modes.none;
  }

  function updateSourceStates() {
    const mode = selectedMode();
    wallpaperSources.querySelectorAll(".wallpaper-source").forEach((label) => {
      const input = label.querySelector("input");
      const selected = input?.value === mode;
      label.classList.toggle("is-selected", selected);
      if (input) {
        input.checked = selected;
        input.setAttribute("aria-checked", String(selected));
      }
    });
  }

  function updateCatalogStates() {
    wallpaperCatalog.querySelectorAll("[data-wallpaper-id]").forEach((option) => {
      const selected = option.dataset.wallpaperId === state.selectedWallpaperId;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
  }

  function updateLocalPreview() {
    const localWallpaper = state.localWallpaper;
    const hasImage = Boolean(localWallpaper?.dataUrl);
    wallpaperLocalPreview.hidden = !hasImage;
    removeLocalWallpaper.hidden = !hasImage;
    if (!hasImage) {
      wallpaperLocalImage.removeAttribute("src");
      wallpaperLocalName.textContent = "";
      wallpaperLocalName.removeAttribute("title");
      return;
    }
    wallpaperLocalImage.src = localWallpaper.dataUrl;
    wallpaperLocalName.textContent = localWallpaper.name || "本地图片";
    wallpaperLocalName.title = localWallpaper.name || "本地图片";
  }

  function updatePanels() {
    const mode = selectedMode();
    wallpaperRandomPanel.hidden = mode !== modes.random;
    wallpaperBuiltInPanel.hidden = mode !== modes.builtin;
    wallpaperUrlPanel.hidden = mode !== modes.url;
    wallpaperLocalPanel.hidden = mode !== modes.local;
    wallpaper.disabled = mode !== modes.url;
    updateSourceStates();
    updateCatalogStates();
    updateLocalPreview();
  }

  function setWallpaperMode(mode) {
    const input = wallpaperSources.querySelector(`input[name="wallpaperMode"][value="${mode}"]`);
    if (!input) {
      return;
    }
    input.checked = true;
    if (mode === modes.random) {
      state.selectedWallpaperId = randomWallpaper()?.id || "";
    } else if (mode === modes.builtin && !catalogItem(state.selectedWallpaperId, modes.builtin)) {
      state.selectedWallpaperId = firstBuiltInWallpaper()?.id || "";
    }
    updatePanels();
    if (mode === modes.url) {
      scheduleRemoteProbe();
    } else {
      state.wallpaperProbeId += 1;
      if (state.wallpaperProbeTimer) {
        clearTimeout(state.wallpaperProbeTimer);
        state.wallpaperProbeTimer = 0;
      }
    }
  }

  function createSourceOption(option) {
    const label = document.createElement("label");
    label.className = "wallpaper-source";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "wallpaperMode";
    input.value = option.mode;
    input.setAttribute("aria-label", option.label);
    input.addEventListener("change", () => setWallpaperMode(option.mode));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        setWallpaperMode(option.mode);
      }
    });

    const content = document.createElement("span");
    content.className = "wallpaper-source__content";
    const title = document.createElement("strong");
    title.textContent = option.label;
    const description = document.createElement("small");
    description.textContent = option.description;
    content.append(title, description);
    label.append(input, content);
    return label;
  }

  function createWallpaperOption(item, imageUrl) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "wallpaper-option";
    option.dataset.wallpaperId = item.id;
    option.setAttribute("aria-label", item.name);
    option.addEventListener("click", () => {
      state.selectedWallpaperId = item.id;
      setWallpaperMode(item.mode);
      commitSettings();
    });

    const image = document.createElement("img");
    image.src = imageUrl || item.thumbnail || item.url;
    image.alt = item.name;
    image.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = item.name;
    option.append(image, label);
    return option;
  }

  function renderWallpaperCatalog() {
    const random = randomWallpaper();
    if (random) {
      wallpaperRandomPreview.replaceChildren(createWallpaperOption(random, randomPreviewUrl()));
    }
    wallpaperCatalog.replaceChildren(...catalog
      .filter((item) => item.mode === modes.builtin)
      .map((item) => createWallpaperOption(item)));
  }

  function populate(value) {
    const settings = normalizeSettings(value);
    state.settings = settings;
    state.language = settings.language;
    aboutStorage.textContent = settings.syncEnabled
      ? "当前存储：本地设置 + 浏览器同步投影。"
      : "当前存储：浏览器本地存储。";
    state.selectedWallpaperId = settings.wallpaperId;
    writeAdvancedSettings(settings);
    applyLanguage(settings.language);
    const mode = settings.wallpaperMode === modes.builtin && !catalogItem(settings.wallpaperId, modes.builtin)
      ? modes.none
      : settings.wallpaperMode;
    renderWallpaperCatalog();
    setWallpaperMode(mode);
  }

  function readForm() {
    const mode = selectedMode();
    const ruleValues = readRuleEditors();
    validateRuleValues(ruleValues);
    const advanced = readAdvancedSettings();
    if (!settingsApi.webdavUrlAllowed(advanced.webdavUrl)) {
      throw new Error("WebDAV 地址无效：只接受 https:// 地址，http:// 仅允许本机地址");
    }
    let wallpaperUrl = "";
    let legacyWallpaper = "";
    let wallpaperId = "";

    if (mode === modes.url) {
      wallpaperUrl = normalizeWallpaper(wallpaper.value);
      legacyWallpaper = wallpaperUrl;
    } else if (mode === modes.random) {
      const random = randomWallpaper();
      if (!random) {
        throw new Error("网站随机图片配置不可用");
      }
      wallpaperId = random.id;
      legacyWallpaper = random.url;
    } else if (mode === modes.builtin) {
      const item = catalogItem(state.selectedWallpaperId, modes.builtin);
      if (!item) {
        throw new Error("请选择一张内置图片");
      }
      wallpaperId = item.id;
      legacyWallpaper = item.url;
    } else if (mode === modes.local) {
      if (!state.localWallpaper?.dataUrl) {
        throw new Error("请先选择本地图片");
      }
    }

    const keepRandomResult = mode === modes.random && state.settings.wallpaperMode === modes.random;
    return normalizeSettings({
      ...advanced,
      ...ruleValues,
      searchHistory: state.settings.searchHistory,
      wallpaper: legacyWallpaper,
      wallpaperMode: mode,
      wallpaperId,
      wallpaperUrl,
      wallpaperLocalId: mode === modes.local ? state.localWallpaper.id : "",
      wallpaperRandomDate: keepRandomResult ? state.settings.wallpaperRandomDate : "",
      wallpaperRandomUrl: keepRandomResult ? state.settings.wallpaperRandomUrl : ""
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("本地图片读取失败"));
      image.src = url;
    });
  }

  function probeRemoteWallpaper() {
    const probeId = ++state.wallpaperProbeId;
    if (selectedMode() !== modes.url) {
      return;
    }

    const input = wallpaper.value.trim();
    if (!input) {
      setStatusMessage(wallpaperStatus, "");
      return;
    }

    let url;
    try {
      url = normalizeWallpaper(input);
    } catch (error) {
      setStatusMessage(wallpaperStatus, error instanceof Error ? error.message : "请输入有效的图片 URL", "error");
      return;
    }

    setStatusMessage(wallpaperStatus, "正在检查图片…");
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (probeId !== state.wallpaperProbeId) {
        return;
      }
      setStatusMessage(wallpaperStatus, "图片已准备，保存设置后生效", "success");
    };
    image.onerror = () => {
      if (probeId !== state.wallpaperProbeId) {
        return;
      }
      setStatusMessage(wallpaperStatus, "图片加载失败，将使用安全渐变回退。", "error");
    };
    image.src = url;
  }

  function scheduleRemoteProbe() {
    state.wallpaperProbeId += 1;
    if (state.wallpaperProbeTimer) {
      clearTimeout(state.wallpaperProbeTimer);
    }
    state.wallpaperProbeTimer = window.setTimeout(() => {
      state.wallpaperProbeTimer = 0;
      probeRemoteWallpaper();
    }, 240);
  }

  async function prepareLocalWallpaper(file) {
    if (!file.type.startsWith("image/")) {
      throw new Error("请选择图片文件");
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(objectUrl);
      const limits = config.wallpaperUpload;
      const scale = Math.min(1, limits.maxWidth / image.naturalWidth, limits.maxHeight / image.naturalHeight);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("本地图片处理不可用");
      }
      context.drawImage(image, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", limits.quality);
      const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const bytes = Math.ceil(payload.length * 0.75);
      if (bytes > limits.maxBytes) {
        throw new Error("图片压缩后仍然过大，请选择较小的图片");
      }
      return {
        id: `local-${Date.now()}`,
        name: file.name,
        type: "image/jpeg",
        dataUrl,
        width,
        height,
        size: bytes
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function isStoredLocalWallpaper(value) {
    return Boolean(value && typeof value === "object" && typeof value.dataUrl === "string" && value.dataUrl.startsWith("data:image/"));
  }

  const syncOrigin = globalThis.crypto?.randomUUID?.() || `options-${Date.now()}`;

  function syncMetadata(value) {
    if (!value || typeof value !== "object") {
      return { updatedAt: 0, origin: "" };
    }
    const updatedAt = Number(value.updatedAt);
    return {
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      origin: String(value.origin || "")
    };
  }

  async function pushSyncSettings(settings, metadata, currentProjection = null, currentMetadata = null) {
    if (!settings.syncEnabled) {
      return;
    }
    const projection = settingsApi.toSyncSettings(settings);
    const sameSettings = currentProjection
      && settingsApi.stableStringify(currentProjection) === settingsApi.stableStringify(projection);
    const sameMetadata = currentMetadata
      && settingsApi.stableStringify(syncMetadata(currentMetadata)) === settingsApi.stableStringify(metadata);
    if (sameSettings && sameMetadata) {
      return;
    }
    await syncSet({
      [config.storageKey]: projection,
      [config.syncMetadataKey]: metadata
    });
  }

  async function reconcileSyncSettings(settings, localMetadata = { updatedAt: 0, origin: "" }) {
    if (!settings.syncEnabled) {
      state.activeStorageArea = "local";
      return settings;
    }
    if (state.syncBusy) {
      return settings;
    }
    state.syncBusy = true;
    try {
      const remote = await syncGet([config.storageKey, config.syncMetadataKey]);
      const remoteMetadata = syncMetadata(remote[config.syncMetadataKey]);
      const local = syncMetadata(localMetadata);
      const remoteSettings = remote[config.storageKey];
      let preferLocal = false;
      if (remoteSettings && !local.updatedAt) {
        const useRemote = globalThis.confirm("检测到已有同步配置。确定使用同步配置，取消则使用本机配置？");
        if (useRemote) {
          const merged = normalizeSettings({ ...settings, ...remoteSettings });
          const metadata = remoteMetadata.updatedAt
            ? remoteMetadata
            : { updatedAt: Date.now(), origin: remoteMetadata.origin || "sync" };
          await storageSet({ [config.storageKey]: merged, [config.syncMetadataKey]: metadata });
          state.syncMetadata = metadata;
          state.activeStorageArea = "sync";
          populate(merged);
          setStatusMessage(maintenanceStatus, "已应用同步配置。", "success");
          return merged;
        }
        preferLocal = true;
      }
      if (!preferLocal && remoteSettings && remoteMetadata.updatedAt > local.updatedAt) {
        const merged = normalizeSettings({ ...settings, ...remoteSettings });
        await storageSet({ [config.storageKey]: merged, [config.syncMetadataKey]: remoteMetadata });
        state.syncMetadata = remoteMetadata;
        state.activeStorageArea = "sync";
        populate(merged);
        setStatusMessage(maintenanceStatus, "已应用较新的同步设置。", "success");
        return merged;
      }
      const metadata = local.updatedAt ? local : { updatedAt: Date.now(), origin: syncOrigin };
      await pushSyncSettings(settings, metadata, remoteSettings, remoteMetadata);
      if (!local.updatedAt) {
        await storageSet({ [config.syncMetadataKey]: metadata });
      }
      state.syncMetadata = metadata;
      state.activeStorageArea = "sync";
      setStatusMessage(maintenanceStatus, "同步设置已更新。", "success");
      return settings;
    } catch (error) {
      state.activeStorageArea = "local";
      setStatusMessage(maintenanceStatus, `同步失败，本地设置保持不变：${error instanceof Error ? error.message : "同步服务不可用"}`, "error");
      return settings;
    } finally {
      state.syncBusy = false;
    }
  }

  function validateShortcutConflicts(settings) {
    const seen = new Map();
    Object.entries(settings.shortcuts || {}).forEach(([action, value]) => {
      const parts = String(value || "").trim().toLocaleLowerCase().split("+").map((item) => item.trim()).filter(Boolean);
      if (!parts.length) {
        return;
      }
      const key = parts.pop();
      const signature = [...new Set(parts.sort()), key].join("+");
      const previous = seen.get(signature);
      if (previous) {
        throw new Error(`快捷键冲突：${previous} 与 ${action} 使用 ${value}`);
      }
      seen.set(signature, action);
    });
  }

  async function save(value) {
    const previousSettings = state.settings;
    const validation = settingsApi.validateSettings(value);
    if (!validation.valid) {
      throw new Error(validation.errors.join("；"));
    }
    value = validation.settings;
    validateShortcutConflicts(value);
    await ensureSyncCapacity(value);
    const settingsChanged = settingsApi.stableStringify(previousSettings) !== settingsApi.stableStringify(value);
    const metadata = settingsChanged
      ? { updatedAt: Date.now(), origin: syncOrigin }
      : syncMetadata(state.syncMetadata);
    const values = { [config.storageKey]: value, [config.syncMetadataKey]: metadata };
    if (state.localWallpaper) {
      values[config.wallpaperLocalStorageKey] = state.localWallpaper;
    }
    await storageSet(values);
    if (state.removeLocalWallpaper) {
      await storageRemove(config.wallpaperLocalStorageKey);
      state.removeLocalWallpaper = false;
    }
    state.settings = value;
    state.language = value.language;
    state.syncMetadata = metadata;
    applyLanguage(value.language);
    if (value.syncEnabled) {
      await reconcileSyncSettings(value, previousSettings.syncEnabled ? metadata : { updatedAt: 0, origin: "" });
    }
    setStatusMessage(status, "✓ 设置已保存。", "success");
    if (wallpaperStatus.dataset.status !== "error") {
      setStatusMessage(wallpaperStatus, value.wallpaperMode === modes.none ? "✓ 已应用安全渐变。" : "✓ 已应用。", "success");
    }
  }

  const enumLabels = {
    language: { "zh-CN": "简体中文", "en-US": "English" },
    themeMode: { auto: "跟随 LinuxDo", system: "跟随系统", light: "浅色", dark: "深色", scheduled: "按时间切换" },
    fontMode: { default: "系统默认", recommended: "推荐字体栈", custom: "自定义字体" },
    fontScope: { own: "仅 betterLD 内容", managed: "已管理页面正文" },
    shadowMode: { default: "默认阴影", none: "关闭阴影", custom: "自定义阴影" },
    gridMode: { auto: "自适应列数", fixed: "固定断点列数" },
    topicListLayoutMode: { reading: "阅读卡", cards: "Material 3 卡片", native: "原生主题列表" },
    replyTreeNameMode: { both: "昵称和用户名", nickname: "仅昵称", username: "仅用户名" },
    topicSortMode: { activity: "最新回复", created: "发布时间" },
    topicTitleFontSize: { responsive: "响应式", small: "小", base: "标准", large: "大" },
    topicAuthorFontSize: { small: "小", base: "标准", large: "大" },
    topicMetaFontSize: { small: "小", base: "标准", large: "大" },
    topicNavigationAlignment: { left: "左对齐", center: "居中" },
    headerVisualMode: { native: "原站样式", transparent: "透明", frosted: "毛玻璃", solid: "不透明" },
    sidebarPosition: { original: "保留原位", right: "移动到右侧" },
    actionRailPosition: { left: "左侧", right: "右侧", bottom: "底部" },
    actionRailVisibility: { always: "始终显示", auto: "滚动时半隐藏", hidden: "默认隐藏" },
    topicCardOpenMode: { currentTab: "当前标签页", newTab: "新标签页", background: "后台标签页", drawer: "原帖预览" },
    navigationOpenMode: { currentTab: "当前标签页", newTab: "新标签页" },
    searchOpenMode: { currentTab: "当前标签页", newTab: "新标签页" },
    notificationOpenMode: { page: "当前页面", newTab: "新标签页" },
    topicFilterMode: { hide: "隐藏命中项", dim: "淡化命中项", highlight: "高亮命中项", include: "只显示命中项" },
    topicFilterMatchMode: { contains: "包含关键词", whole: "完整词匹配", regex: "正则表达式" },
    searchMode: { native: "原生结果", cards: "阅读卡" },
    searchResultsPaginationMode: { scroll: "滚动加载", pagination: "分页" },
    searchPageWallpaperMode: { inherit: "继承全局", builtin: "内置图片", url: "远程图片" },
    touchOptimization: { auto: "自动", on: "开启", off: "关闭" }
  };

  const englishEnumLabels = {
    language: { "zh-CN": "Chinese (Simplified)", "en-US": "English" },
    wallpaperRemoteCacheDays: { "0": "Browser cache only", "1": "1 day", "7": "7 days", "30": "30 days" },
    themeMode: { auto: "Follow LinuxDo", system: "Follow system", light: "Light", dark: "Dark", scheduled: "Scheduled" },
    fontMode: { default: "System default", recommended: "Recommended stack", custom: "Custom font" },
    fontScope: { own: "betterLD content only", managed: "Managed pages" },
    shadowMode: { default: "Default shadow", none: "No shadow", custom: "Custom shadow" },
    gridMode: { auto: "Responsive columns", fixed: "Fixed breakpoint columns" },
    topicListLayoutMode: { reading: "Reading cards", cards: "Material 3 cards", native: "Native topic list" },
    replyTreeNameMode: { both: "Nickname and username", nickname: "Nickname only", username: "Username only" },
    topicSortMode: { activity: "Latest reply", created: "Publish time" },
    topicTitleFontSize: { responsive: "Responsive", small: "Small", base: "Base", large: "Large" },
    topicAuthorFontSize: { small: "Small", base: "Base", large: "Large" },
    topicMetaFontSize: { small: "Small", base: "Base", large: "Large" },
    topicNavigationAlignment: { left: "Left", center: "Center" },
    headerVisualMode: { native: "Native", transparent: "Transparent", frosted: "Frosted", solid: "Solid" },
    sidebarPosition: { original: "Original", right: "Right" },
    actionRailPosition: { left: "Left", right: "Right", bottom: "Bottom" },
    actionRailVisibility: { always: "Always", auto: "Partly hidden while scrolling", hidden: "Hidden by default" },
    topicCardOpenMode: { currentTab: "Current tab", newTab: "New tab", background: "Background tab", drawer: "Topic preview" },
    navigationOpenMode: { currentTab: "Current tab", newTab: "New tab" },
    searchOpenMode: { currentTab: "Current tab", newTab: "New tab" },
    notificationOpenMode: { page: "Current page", newTab: "New tab" },
    topicFilterMode: { hide: "Hide matches", dim: "Dim matches", highlight: "Highlight matches", include: "Show matches only" },
    topicFilterMatchMode: { contains: "Contains keyword", whole: "Whole word", regex: "Regular expression" },
    searchMode: { native: "Native results", cards: "Reading cards" },
    searchResultsPaginationMode: { scroll: "Infinite scroll", pagination: "Pagination" },
    searchPageWallpaperMode: { inherit: "Inherit global", builtin: "Built-in image", url: "Remote image" },
    touchOptimization: { auto: "Automatic", on: "On", off: "Off" }
  };

  const englishFieldLabels = {
    language: "Settings language", themeMode: "Theme mode", themeScheduleStart: "Dark mode starts", themeScheduleEnd: "Dark mode ends", themeColor: "Manual theme color", wallpaperThemeColor: "Extract theme color from wallpaper", darkModeBaseColor: "Dark base color", useGradientThemeColorBackground: "Use theme-color gradient", liquidSegmentIndicatorEnabled: "Liquid segment indicator", frostedGlassEnabled: "Enable frosted glass", sidebarCoverBlurEnabled: "Sidebar cover blur", userCardCoverMaskEnabled: "User card cover overlay", userCardCoverMaskOpacity: "User card cover transparency", surfaceBlurPx: "Surface blur", shadowMode: "Shadow mode", shadowHeight: "Shadow height", fontMode: "Font preference", fontScope: "Font scope", fontFamily: "Custom font family", removeChinesePunctuationIndent: "Remove Chinese punctuation indent", customCssEnabled: "Enable custom CSS", customCss: "Custom CSS", wallpaperUrl: "Image URL", maskOpacity: "Page overlay", blurPx: "Background blur", cardOpacity: "Card opacity", wallpaperRemoteCacheDays: "Remote wallpaper cache", applyToUnmanagedPages: "Apply shell visuals to unmanaged pages",
    gridMode: "Grid mode", cardMinSize: "Card minimum width", cardSideGutter: "Card side gutter", gridGap: "Card gap", showTopicAvatar: "Show author avatar", showTopicAuthor: "Show author", showTopicCategory: "Show category", showTopicExcerpt: "Show excerpt", showTopicMeta: "Show topic metadata", showTopicUnreadState: "Show unread state", showTopicPinnedState: "Show pinned state", topicListLayoutMode: "Topic card style", replyTreeNameMode: "Reply author name", topicTitleFontSize: "Title size", topicAuthorFontSize: "Author size", topicMetaFontSize: "Metadata size",
    topicNavigationAlignment: "Topic navigation alignment", topicNavigationSticky: "Sticky topic navigation", showTopicNavigationCounts: "Show navigation counts", headerVisible: "Show Header", headerVisualMode: "Header visual", autoHideHeader: "Auto-hide Header", sidebarPosition: "Sidebar position", autoHideSidebar: "Auto-hide Sidebar", showSettingsTrigger: "Show settings entry", showThemeToggle: "Show theme toggle", actionRailEnabled: "Enable action rail", actionRailPosition: "Action rail position", actionRailVisibility: "Action rail visibility", actionRailGlow: "Action rail glow", showBackToTopButton: "Show back-to-top", showRefreshButton: "Show refresh", separateNavigationActions: "Separate navigation actions", enableUndoRefresh: "Enable undo refresh",
    topicFilterEnabled: "Enable topic filter", topicFilterMode: "Filter match behavior", topicFilterMatchMode: "Filter match mode", topicFilterMaxAgeDays: "Hide stale topics (days)", topicFilterHideLv1: "Hide Lv1 topics", topicFilterHideLv2: "Hide Lv2 topics", topicFilterHideLv3: "Hide Lv3 topics", topicFilterBinEnabled: "Keep filtered topics bin", webdavUrl: "WebDAV URL", webdavUsername: "WebDAV username", webdavPassword: "WebDAV password", searchMode: "Search result mode", searchHistoryEnabled: "Save search history", searchRecommendationEnabled: "Enable search recommendations", searchFocusDimming: "Search focus dimming", searchFocusBlur: "Search focus blur", searchResultsPaginationMode: "Search pagination", searchPageWallpaperMode: "Search page wallpaper", searchPageWallpaperId: "Search built-in wallpaper ID", searchPageWallpaperUrl: "Search remote wallpaper URL",
    topicCardOpenMode: "Topic card open mode", navigationOpenMode: "Navigation link open mode", searchOpenMode: "Search link open mode", notificationOpenMode: "Notification link open mode", drawerCloseOnOverlay: "Close drawer on overlay click", drawerCloseOnEscape: "Close drawer with Escape", touchOptimization: "Touch optimization", enableHorizontalNavigationScroll: "Allow horizontal navigation scroll", showHomeButtonInTouchMode: "Show home button in touch mode", shortcutsEnabled: "Enable shortcuts", syncEnabled: "Enable browser sync"
  };

  const staticTranslations = {
    "首页视觉设置": "Home visual settings",
    "调整 LinuxDo 首页卡片、导航和页面外观。所有修改在点击“保存设置”后生效。": "Adjust LinuxDo cards, navigation, and page visuals. Changes apply after saving.",
    "搜索设置": "Search settings",
    "搜索外观、卡片、快捷键…": "Search appearance, cards, shortcuts…",
    "按名称或关键词筛选设置，不会改变当前输入。": "Filter settings by name or keyword without changing current input.",
    "清空搜索": "Clear search",
    "没有匹配的设置。": "No matching settings.",
    "背景图片": "Background image",
    "层次效果": "Layering",
    "页面遮罩": "Page overlay",
    "背景模糊": "Background blur",
    "卡片透明度": "Card opacity",
    "外观": "Appearance",
    "主题卡片": "Topic cards",
    "树状回复": "Reply tree",
    "主题回复树中作者昵称与用户名的显示方式。": "Choose which author names to show in topic replies.",
    "页面导航": "Page navigation",
    "筛选": "Filter",
    "搜索": "Search",
    "交互": "Interaction",
    "高级": "Advanced",
    "备份与同步": "Backup and sync",
    "关于": "About",
    "外观 Appearance": "Appearance",
    "主题卡片 Card": "Topic cards",
    "页面导航 Navigation": "Page navigation",
    "筛选 Filter": "Filter",
    "搜索 Search": "Search",
    "交互 Interaction": "Interaction",
    "高级 Advanced": "Advanced",
    "备份 同步 Maintenance": "Backup and sync",
    "关于 About": "About",
    "恢复默认": "Restore defaults",
    "保存设置": "Save settings",
    "导出设置": "Export settings",
    "导入设置": "Import settings",
    "导出筛选规则": "Export filter rules",
    "导入筛选规则": "Import filter rules",
    "清空搜索历史": "Clear search history",
    "检查更新": "Check for updates",
    "比对 GitHub Releases 的最新标签与本地版本号，只做提示，不自动更新；不点击不会发起任何请求。": "Compares the latest GitHub Releases tag with the local version. It only reports, never auto-updates, and sends no request unless you click.",
    "立即同步": "Sync now",
    "Manifest V3 · Chrome / Firefox 桌面端 · 仅处理 betterLD 所需的主题与设置数据。": "Manifest V3 · Chrome / Firefox desktop · Processes only the topic and settings data required by betterLD.",
    "项目主页": "Project home",
    "问题反馈": "Report an issue",
    "设置": "Settings",
    "常规": "General",
    "主题": "Theme",
    "表面与毛玻璃": "Surface and frosted glass",
    "字体与文本": "Font and text",
    "页面行为": "Page behavior",
    "页面": "Pages",
    "组件": "Components",
    "主题导航": "Topic navigation",
    "Header 与 Sidebar": "Header and Sidebar",
    "浮动操作": "Floating actions",
    "打开方式与抽屉": "Open mode and drawer",
    "壁纸": "Wallpaper",
    "页面效果": "Page effects",
    "自定义 CSS": "Custom CSS",
    "快捷键": "Shortcuts",
    "按键": "Keys",
    "同步与缓存": "Sync and cache",
    "导入与导出": "Import and export",
    "恢复默认设置": "Restore default settings",
    "背景来源": "Background source",
    "远程图片": "Remote image",
    "本地图片": "Local image",
    "选择图片": "Choose image",
    "移除本地图片": "Remove local image",
    "同步": "Sync",
    "设置文件": "Settings file",
    "筛选规则文件": "Filter rule file",
    "搜索历史": "Search history",
    "标题规则": "Title rules",
    "作者规则": "Author rules",
    "分类规则": "Category rules",
    "暂无标题规则": "No title rules",
    "暂无作者规则": "No author rules",
    "暂无分类规则": "No category rules",
    "暂无规则": "No rules",
    "添加规则": "Add rule",
    "删除": "Delete",
    "关键词": "Keyword",
    "备注（可选）": "Note (optional)",
    "近处": "Near",
    "中段": "Middle",
    "远处": "Far",
    "阴影曲线": "Shadow curve",
    "断点列数": "Breakpoint columns",
    "卡片操作菜单": "Card action menu",
    "导航项": "Navigation items",
    "操作栏项目": "Action rail items",
    "图片会压缩后保存在扩展本地，不会上传到 LinuxDo。": "Images are compressed and stored locally in the extension; nothing is uploaded to LinuxDo.",
    "导出的 JSON 不包含本地壁纸正文、账号信息或页面内容。": "Exported JSON excludes wallpaper bodies, account information, and page content.",
    "恢复默认会立即覆盖当前全部设置，包含壁纸来源与卡片布局。": "Restoring defaults immediately overwrites all current settings, including wallpaper source and card layout.",
    "本地壁纸和搜索历史不会同步。": "Local wallpapers and search history are never synced.",
    "保存前会执行 CSSOM、选择器和属性白名单校验。": "CSSOM, selector, and property allowlist validation runs before saving.",
    "只接受 HTTPS 图片地址。": "Only HTTPS image URLs are accepted.",
    "按高度位置调整 betterLD 自有卡片阴影的透明度。": "Adjusts betterLD card shadow opacity by height position.",
    "固定网格模式与自动布局在断点不足时使用的列数。": "Column counts used by fixed grid mode and by auto layout at each breakpoint.",
    "控制卡片菜单项的显隐与顺序。": "Controls visibility and order of card menu entries.",
    "控制主题导航入口的显隐与顺序。": "Controls visibility and order of topic navigation entries.",
    "控制浮动操作栏项目的显隐与顺序。": "Controls visibility and order of floating action rail entries.",
    "留空表示不绑定按键。": "Leave blank to bind no shortcut.",
    "标题、作者与分类规则统一使用上面的命中行为。": "Title, author, and category rules all use the match behavior above.",
    "参考 BewlyCat，支持网站随机图片、内置图片、远程图片和本地图片。": "Supports random, built-in, remote, and local images, following BewlyCat.",
    "每天固定一张，进入下一天后自动更新。": "One fixed image per day; updates when the next day begins."
  };

  function applyLanguage(language) {
    const english = language === "en-US";
    if (!isEmbedded) {
      pageDocument.documentElement.lang = english ? "en-US" : "zh-CN";
      pageDocument.title = english ? "betterLD settings" : "betterLD 设置";
    }
    const translatableSelector = isEmbedded ? "*:not(script):not(style)" : "body *:not(script):not(style)";
    document.querySelectorAll(translatableSelector).forEach((element) => {
      if (element.children.length > 0) {
        return;
      }
      const source = element.dataset.betterldZh || element.textContent.trim();
      if (!source) {
        return;
      }
      element.dataset.betterldZh = source;
      if (staticTranslations[source]) {
        element.textContent = english ? staticTranslations[source] : source;
      }
    });
    document.querySelectorAll(".settings-field[data-settings-key]").forEach((field) => {
      const key = field.dataset.settingsKey;
      const label = field.querySelector(".settings-field__title");
      const source = field.dataset.betterldSettingLabel || label?.textContent.trim();
      if (!source) {
        return;
      }
      field.dataset.betterldSettingLabel = source;
      const text = english ? (englishFieldLabels[key] || source) : source;
      if (label) {
        label.textContent = text;
      }
      const input = field.querySelector("[data-setting-key]");
      input?.setAttribute("aria-label", text);
      const group = field.querySelector(".settings-segmented");
      if (group) {
        group.setAttribute("aria-label", text);
        group.querySelectorAll(".settings-segmented__item").forEach((button) => {
          const value = button.dataset.segmentValue;
          const chinese = button.dataset.betterldZh || enumLabels[key]?.[value] || button.textContent;
          button.dataset.betterldZh = chinese;
          button.textContent = english ? (englishEnumLabels[key]?.[value] || value) : chinese;
        });
      }
    });
    if (aboutStorage) {
      aboutStorage.textContent = state.settings.syncEnabled
        ? (english ? "Storage: local settings + browser sync projection." : "当前存储：本地设置 + 浏览器同步投影。")
        : (english ? "Storage: browser local storage." : "当前存储：浏览器本地存储。");
    }
  }

  function enumOptions(key) {
    return (config.settingsEnums[key] || []).map((value) => ({
      value: String(value),
      label: enumLabels[key]?.[value] || String(value)
    }));
  }

  const fieldDefinitions = [
    { key: "language", type: "select", label: "设置页语言", help: "只改变 betterLD 自有设置和状态文案。" },
    { key: "themeMode", type: "select", label: "主题模式", help: "自动模式优先读取 LinuxDo 的主题状态。" },
    { key: "themeScheduleStart", type: "time", label: "深色主题开始", help: "按时间切换时使用。", dependsOn: ["themeMode", "scheduled"] },
    { key: "themeScheduleEnd", type: "time", label: "深色主题结束", help: "支持跨午夜时间段。", dependsOn: ["themeMode", "scheduled"] },
    { key: "themeColor", type: "color", label: "手动主题色", help: "关闭壁纸取色或图片不允许读取颜色时使用。" },
    { key: "wallpaperThemeColor", type: "toggle", label: "从壁纸提取主题色", help: "随背景图片调整网站和 betterLD 的强调色，并适配明暗模式。" },
    { key: "darkModeBaseColor", type: "color", label: "深色基色", help: "调整 betterLD 深色背景，不降低正文对比度。" },
    { key: "useGradientThemeColorBackground", type: "toggle", label: "使用主题色渐变背景", help: "只改变 betterLD 自有背景。" },
    { key: "liquidSegmentIndicatorEnabled", type: "toggle", label: "设置分段控件液态指示器", help: "在设置页的分段控件上使用滑动液态指示器；关闭后为静态选中态，减少动效时同样使用静态。" },
    { key: "frostedGlassEnabled", type: "toggle", label: "启用毛玻璃", help: "关闭后表面不再使用 backdrop-filter。" },
    { key: "sidebarCoverBlurEnabled", type: "toggle", label: "启用侧栏遮罩模糊", help: "开启时侧栏容器用壁纸高斯模糊封面（半透明 + 背景模糊）；关闭后改用不透明表面。" },
    { key: "surfaceBlurPx", type: "range", label: "表面模糊", unit: "px", help: "卡片、用户资料卡、菜单、导航和 Header 的独立模糊强度；需开启「启用毛玻璃」。" },
    { key: "userCardCoverMaskEnabled", type: "toggle", label: "用户卡片封面遮罩", help: "仅作用于带背景图片的用户卡片，关闭后完整显示封面。" },
    { key: "userCardCoverMaskOpacity", type: "range", label: "用户卡片封面遮罩强度", unit: "%", help: "0% 完全透明，100% 完全遮盖；降低后文字可能与封面混色。", dependsOn: ["userCardCoverMaskEnabled", true] },
    { key: "shadowMode", type: "select", label: "阴影模式", help: "自定义阴影只作用于 betterLD 自有卡片。" },
    { key: "shadowHeight", type: "range", label: "阴影高度", unit: "", help: "控制卡片阴影的整体高度。" },
    { key: "fontMode", type: "select", label: "字体偏好", help: "不加载远程字体。" },
    { key: "fontScope", type: "select", label: "字体作用范围", help: "默认只覆盖 betterLD 自有内容。" },
    { key: "fontFamily", type: "text", label: "自定义字体族", help: "只使用本机或系统已有字体。", wide: true, dependsOn: ["fontMode", "custom"] },
    { key: "removeChinesePunctuationIndent", type: "toggle", label: "移除中文标点缩进", help: "只作用于 betterLD 自有文本。" },
    { key: "customCssEnabled", type: "toggle", label: "启用自定义 CSS", help: "保存前会执行 CSSOM、选择器和属性白名单校验。" },
    { key: "customCss", type: "textarea", label: "自定义 CSS", help: "每条规则必须命中 .betterld- 或 [data-betterld-] 命名空间。", wide: true, dependsOn: ["customCssEnabled", true] },
    { key: "wallpaperUrl", type: "url", label: "图片 URL", help: "只接受 HTTPS 图片地址。", wide: true },
    { key: "maskOpacity", type: "range", label: "页面遮罩", unit: "%", help: "范围 0–80%。" },
    { key: "blurPx", type: "range", label: "背景模糊", unit: "px", help: "范围 0–32px。" },
    { key: "cardOpacity", type: "range", label: "卡片透明度", unit: "%", help: "范围 55%–95%。" },
    { key: "wallpaperRemoteCacheDays", type: "select", label: "远程壁纸缓存时长", options: [{ value: "0", label: "仅使用浏览器缓存" }, { value: "1", label: "1 天" }, { value: "7", label: "7 天" }, { value: "30", label: "30 天" }], help: "只缓存 URL、探测时间和成功状态，不保存图片正文。" },

    { key: "gridMode", type: "select", label: "网格模式", help: "自适应模式保留可用宽度和窄屏单列边界。" },
    { key: "cardMinSize", type: "range", label: "卡片最小宽度", unit: "px", help: "自适应网格的最小轨道宽度。" },
    { key: "cardSideGutter", type: "range", label: "卡片左右内缩", unit: "px", help: "保持页面内容与边缘的安全间距。" },
    { key: "gridGap", type: "range", label: "卡片间距", unit: "px", help: "卡片网格的行列间距。" },
    { key: "showTopicAvatar", type: "toggle", label: "显示作者头像", help: "关闭后保留身份栏的可读宽度。" },
    { key: "showTopicAuthor", type: "toggle", label: "显示作者", help: "不会改变作者 JSON 请求和权威来源。" },
    { key: "showTopicCategory", type: "toggle", label: "显示分类", help: "保留主题链接和分类数据。" },
    { key: "showTopicExcerpt", type: "toggle", label: "显示正文摘要", help: "关闭后停止仅摘要观察请求。" },
    { key: "showTopicTags", type: "toggle", label: "显示卡片标签", help: "只影响 betterLD 阅读卡上的标签，不改变主题与站点标签。" },
    { key: "showTopicMeta", type: "toggle", label: "显示主题元信息", help: "回复数、点赞数、浏览数与活动时间的总开关；关闭后不再为阅读卡请求元数据。" },
    { key: "showTopicActivityTime", type: "toggle", label: "显示活动时间", help: "关闭后元信息只保留回复数，不减少请求。", dependsOn: ["showTopicMeta", true] },
    { key: "showTopicReplies", type: "toggle", label: "显示回复数", help: "同时作用于卡片元信息与阅读卡统计。", dependsOn: ["showTopicMeta", true] },
    { key: "showTopicLikes", type: "toggle", label: "显示点赞数", help: "只影响阅读卡统计。", dependsOn: ["showTopicMeta", true] },
    { key: "showTopicViews", type: "toggle", label: "显示浏览数", help: "只影响阅读卡统计。", dependsOn: ["showTopicMeta", true] },
    { key: "showTopicUnreadState", type: "toggle", label: "显示未读状态", help: "不改变原站未读语义。" },
    { key: "showTopicPinnedState", type: "toggle", label: "显示置顶状态", help: "不改变原站置顶排序。" },
    { key: "showTopicWatchedState", type: "toggle", label: "显示已看标记", help: "已看记录只保存在本机浏览记录里，不写服务端已读状态。" },
    { key: "topicListLayoutMode", type: "select", label: "主题卡片样式", help: "阅读卡适配核心 Markdown；原生模式恢复原始列表、分页和控制项。" },
    { key: "replyTreeNameMode", type: "select", label: "回复作者名称", help: "只影响主题页树状回复；默认与原站一样同时显示昵称和用户名。" },
    { key: "topicSortMode", type: "select", label: "话题排序方式", help: "最新回复按 LinuxDo 默认的最后活动时间倒序；发布时间按主题创建时间倒序（Discourse 的 created）。切换后会重新加载当前列表，热门与最高保留各自排序。" },
    { key: "topicTitleFontSize", type: "select", label: "标题字号", help: "只调整 betterLD 卡片标题；字号随卡片宽度缩放，小/标准/大只改变相对比例。" },
    { key: "topicAuthorFontSize", type: "select", label: "作者字号", help: "只调整 betterLD 卡片作者；字号随卡片宽度缩放，小/标准/大只改变相对比例。" },
    { key: "topicMetaFontSize", type: "select", label: "元信息字号", help: "只调整 betterLD 卡片元信息；字号随卡片宽度缩放，小/标准/大只改变相对比例。" },

    { key: "topicNavigationAlignment", type: "select", label: "主题导航对齐", help: "保留原始链接和 active 语义。" },
    { key: "topicNavigationSticky", type: "toggle", label: "固定主题导航", help: "与列表控制栏滚动收起协调。" },
    { key: "showTopicNavigationCounts", type: "toggle", label: "显示导航数量", help: "隐藏视觉数量但保留可访问语义。" },
    { key: "headerVisible", type: "toggle", label: "显示 Header", help: "不重建原站 Logo、搜索、通知或用户菜单。" },
    { key: "headerVisualMode", type: "select", label: "Header 视觉", help: "只覆盖已确认的原生 Header surface。" },
    { key: "autoHideHeader", type: "toggle", label: "自动隐藏 Header", help: "移动端默认不隐藏，焦点进入 Header 时恢复。" },
    { key: "sidebarPosition", type: "select", label: "Sidebar 位置", help: "窄屏会保留原站移动抽屉。" },
    { key: "autoHideSidebar", type: "toggle", label: "自动隐藏 Sidebar", help: "仅宽屏启用，并保留悬停和键盘热区。" },
    { key: "showSettingsTrigger", type: "toggle", label: "显示设置入口", help: "在当前页面打开设置窗口，缺少资源 API 时回退扩展设置页。" },
    { key: "showThemeToggle", type: "toggle", label: "显示主题切换入口", help: "保留原站主题切换语义。" },
    { key: "siteLogoVisible", type: "toggle", label: "显示站点 Logo", help: "只隐藏原站 Header 里的 Logo，不动其余 Header 内容。" },
    { key: "siteLogoOutline", type: "toggle", label: "Logo 描边", help: "按 betterLD 主题色给 Logo 加一圈 1px 描边。" },
    { key: "siteLogoGlow", type: "toggle", label: "Logo 发光", help: "按 betterLD 主题色加发光，可与描边同时开启。" },
    { key: "actionRailEnabled", type: "toggle", label: "启用浮动操作栏", help: "只创建一个 betterLD 操作组。" },
    { key: "actionRailPosition", type: "select", label: "操作栏位置", help: "仅启用操作栏时生效。", dependsOn: ["actionRailEnabled", true] },
    { key: "actionRailVisibility", type: "select", label: "操作栏显隐", help: "自动模式会随滚动半隐藏。", dependsOn: ["actionRailEnabled", true] },
    { key: "actionRailGlow", type: "toggle", label: "操作栏发光", help: "仅作用于 betterLD 操作栏。", dependsOn: ["actionRailEnabled", true] },
    { key: "showBackToTopButton", type: "toggle", label: "显示返回顶部", help: "使用 window.scrollTo，不改变路由。" },
    { key: "showRefreshButton", type: "toggle", label: "显示刷新按钮", help: "合并站点「查看 N 个新的或更新的话题」，不重载页面。" },
    { key: "separateNavigationActions", type: "toggle", label: "分离导航操作", help: "避免与原站按钮重复。" },
    { key: "enableUndoRefresh", type: "toggle", label: "启用刷新撤销", help: "需要刷新前状态恢复链路支持。" },

    { key: "topicFilterEnabled", type: "toggle", label: "启用主题过滤", help: "只影响 betterLD 生成的卡片。" },
    { key: "topicFilterMode", type: "select", label: "过滤命中行为", help: "隐藏、淡化或只显示命中项；白名单命中项永不受影响。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterMatchMode", type: "select", label: "关键词匹配方式", help: "整词匹配避免 AI、Go 这类短词误伤；正则模式下非法表达式会在保存时被拒绝。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterMaxAgeDays", type: "range", label: "隐藏旧主题（天）", unit: " 天", help: "隐藏超过该天数没有新回复的主题；0 表示不按时间过滤。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterHideLv1", type: "toggle", label: "隐藏 Lv1 主题", help: "等级取自分类 slug，无等级分类不受影响。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterHideLv2", type: "toggle", label: "隐藏 Lv2 主题", help: "等级取自分类 slug。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterHideLv3", type: "toggle", label: "隐藏 Lv3 主题", help: "等级取自分类 slug。", dependsOn: ["topicFilterEnabled", true] },
    { key: "topicFilterBinEnabled", type: "toggle", label: "保留过滤垃圾桶", help: "在右下角列出本页被过滤的主题，可单条或全部还原；关闭后命中项不再生成卡片。", dependsOn: ["topicFilterEnabled", true] },

    { key: "searchMode", type: "select", label: "搜索结果模式", help: "阅读卡复用搜索结果的作者和摘要，不额外请求；支持作者等过滤规则。原生模式保持站点结果页。" },
    { key: "searchHistoryEnabled", type: "toggle", label: "保存搜索历史", help: "只保存用户实际提交的搜索词。" },
    { key: "searchHistoryPanelEnabled", type: "toggle", label: "搜索历史面板", help: "在站内搜索框聚焦时列出本机搜索历史，点条目回填搜索框（搜索表单在页面上时直接提交），可单条删除或清空；需先开启「保存搜索历史」。", dependsOn: ["searchHistoryEnabled", true] },
    { key: "searchRecommendationEnabled", type: "toggle", label: "启用搜索推荐", help: "在站内搜索框用最近一次搜索词作为占位提示，输入为空时直接回车会搜索该词；推荐词来自本机搜索历史，需先开启「保存搜索历史」。", dependsOn: ["searchHistoryEnabled", true] },
    { key: "searchFocusDimming", type: "toggle", label: "搜索聚焦遮罩", help: "只遮罩 betterLD 自有背景。" },
    { key: "searchFocusBlur", type: "toggle", label: "搜索聚焦模糊", help: "独立于全局壁纸模糊，可能影响性能。" },
    { key: "searchResultsPaginationMode", type: "select", label: "搜索结果分页", help: "滚动加载沿用站点自动加载更多；翻页模式禁用站点自动加载，改用「加载更多结果」按钮。" },
    { key: "searchPageWallpaperMode", type: "select", label: "搜索页壁纸", help: "默认继承全局壁纸。" },
    { key: "searchPageWallpaperId", type: "text", label: "搜索页内置壁纸 ID", help: "仅在搜索页壁纸选择内置图片时生效。", dependsOn: ["searchPageWallpaperMode", "builtin"] },
    { key: "searchPageWallpaperUrl", type: "url", label: "搜索页远程壁纸 URL", help: "只接受 HTTPS 地址。", wide: true, dependsOn: ["searchPageWallpaperMode", "url"] },

    { key: "topicCardOpenMode", type: "select", label: "主题卡片打开方式", help: "默认保持当前标签页行为。" },
    { key: "navigationOpenMode", type: "select", label: "导航链接打开方式", help: "保留 modifier-click 和键盘行为。" },
    { key: "searchOpenMode", type: "select", label: "搜索链接打开方式", help: "只作用于 betterLD 接管的搜索链接。" },
    { key: "notificationOpenMode", type: "select", label: "通知链接打开方式", help: "不修改原站通知内容。" },
    { key: "drawerCloseOnOverlay", type: "toggle", label: "点击遮罩关闭抽屉", help: "抽屉关闭后焦点回到触发卡片。" },
    { key: "drawerCloseOnEscape", type: "toggle", label: "按 Escape 关闭抽屉", help: "保留原生键盘关闭路径。" },
    { key: "touchOptimization", type: "select", label: "触屏优化", help: "开启时操作目标至少 44 × 44px。" },
    { key: "enableHorizontalNavigationScroll", type: "toggle", label: "允许导航横向滚动", help: "只作用于主题导航。" },
    { key: "showHomeButtonInTouchMode", type: "toggle", label: "触屏显示首页按钮", help: "提供可发现的返回首页路径。" },
    { key: "shortcutsEnabled", type: "toggle", label: "启用快捷键", help: "输入框、编辑器和可编辑元素聚焦时不触发。" },
    { key: "syncEnabled", type: "toggle", label: "启用浏览器同步", help: "本地壁纸和搜索历史不会同步。" },
    { key: "webdavUrl", type: "url", label: "WebDAV 地址", help: "指向规则备份文件的完整地址；只接受 https://，本机地址可用 http://。", wide: true },
    { key: "webdavUsername", type: "text", label: "WebDAV 用户名", help: "留空则不发送认证头。" },
    { key: "webdavPassword", type: "password", label: "WebDAV 密码", help: "只保存在本地存储，不进入同步投影与导出文件。" }
  ];

  const labelMap = {
    latest: "最新", new: "新主题", unread: "未读", hot: "热门", top: "热门排行", posted: "我发布的", read: "已读", bookmarks: "书签", categories: "分类",
    settings: "设置", theme: "主题", refresh: "刷新",
    openCurrentTab: "当前标签页打开", openNewTab: "新标签页打开", openBackground: "后台标签页打开", openDrawer: "打开原帖预览",
    copyTopicUrl: "复制主题 URL", copyCleanUrl: "复制干净 URL", copyTopicId: "复制主题 ID", openCategory: "打开分类", openAuthor: "打开作者主页"
  };

  const controlMap = new Map();
  const maintenanceStatus = document.querySelector("#maintenance-status");
  const updateStatus = document.querySelector("#update-status");
  const clearSearchHistory = document.querySelector("#clear-search-history");
  const syncNow = document.querySelector("#sync-now");
  const aboutStorage = document.querySelector("#about-storage");
  const settingsImportFile = document.querySelector("#settings-import-file");
  const rulesImportFile = document.querySelector("#rules-import-file");

  function fieldOptions(definition) {
    if (definition.options) {
      return definition.options;
    }
    return enumOptions(definition.key);
  }

  function displayRangeValue(definition, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return "";
    }
    if (definition.unit === "%") {
      return `${Math.round(number * 100)}%`;
    }
    return `${number}${definition.unit || ""}`;
  }

  function createControl(definition) {
    if (definition.type === "toggle") {
      const wrapper = document.createElement("span");
      wrapper.className = "settings-switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "settings-switch__input";
      const track = document.createElement("span");
      track.className = "settings-switch__track";
      track.setAttribute("aria-hidden", "true");
      wrapper.append(input, track);
      return { input, control: wrapper };
    }

    if (definition.type === "select") {
      const group = document.createElement("div");
      group.className = "settings-segmented";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", definition.label);
      const input = document.createElement("input");
      input.type = "hidden";
      fieldOptions(definition).forEach((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-segmented__item";
        button.dataset.segmentValue = String(option.value);
        button.setAttribute("role", "radio");
        button.textContent = option.label;
        button.addEventListener("click", () => {
          if (input.value === button.dataset.segmentValue) {
            return;
          }
          input.value = button.dataset.segmentValue;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        group.append(button);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        const buttons = [...group.querySelectorAll(".settings-segmented__item")];
        const index = buttons.indexOf(document.activeElement);
        if (index < 0) {
          return;
        }
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : buttons.length - 1;
        const next = buttons[(index + step) % buttons.length];
        next.focus();
        next.click();
      });
      group.prepend(input);
      // 液态指示器：滑动到当前选中项；关闭设置项时由 CSS 隐藏并回到静态选中态
      const indicator = document.createElement("span");
      indicator.className = "settings-segmented__indicator";
      indicator.setAttribute("aria-hidden", "true");
      group.prepend(indicator);
      return { input, control: group };
    }

    if (definition.type === "range") {
      const wrapper = document.createElement("span");
      wrapper.className = "settings-slider";
      const input = document.createElement("input");
      input.type = "range";
      const output = document.createElement("output");
      output.dataset.settingOutput = definition.key;
      input.addEventListener("input", () => {
        output.textContent = displayRangeValue(definition, input.value);
      });
      wrapper.append(input, output);
      return { input, control: wrapper };
    }

    const control = document.createElement(definition.type === "textarea" ? "textarea" : "input");
    if (definition.type === "color") {
      control.type = "color";
      control.className = "settings-color-input";
    } else if (definition.type === "time") {
      control.type = "time";
      control.className = "settings-text-input";
    } else if (definition.type === "url") {
      control.type = "url";
      control.inputMode = "url";
      control.className = "settings-text-input";
    } else if (definition.type === "textarea") {
      control.className = "settings-textarea";
    } else if (definition.type === "password") {
      control.type = "password";
      control.autocomplete = "off";
      control.className = "settings-text-input";
    } else {
      control.type = "text";
      control.autocomplete = "off";
      control.className = "settings-text-input";
    }
    return { input: control, control };
  }

  function createSettingsField(definition) {
    const field = document.createElement("div");
    field.className = "settings-field";
    field.dataset.settingsItem = "true";
    field.dataset.settingsKey = definition.key;
    if (definition.wide) {
      field.classList.add("settings-field--stacked");
    }
    if (definition.dependsOn) {
      field.dataset.dependsOn = definition.dependsOn[0];
      field.dataset.dependsValue = String(definition.dependsOn[1]);
    }

    const row = document.createElement("div");
    row.className = "settings-field__row";
    const left = document.createElement("div");
    left.className = "settings-field__left";
    const title = document.createElement("span");
    title.className = "settings-field__title";
    title.textContent = definition.label;
    left.append(title);
    if (definition.help) {
      const help = document.createElement("p");
      help.className = "settings-field__desc";
      help.textContent = definition.help;
      left.append(help);
    }

    const right = document.createElement("div");
    right.className = "settings-field__right";
    const { input, control } = createControl(definition);
    input.id = `setting-${definition.key.replace(/[^a-z0-9-]/gi, "-")}`;
    input.dataset.settingKey = definition.key;
    input.name = definition.key;
    input.setAttribute("aria-label", definition.label);
    right.append(control);
    row.append(left, right);
    field.append(row);
    controlMap.set(definition.key, input);
    return field;
  }

  function keysBySubcategory() {
    const map = new Map();
    (config.settingsCategories || []).forEach((category) => {
      category.subcategories.forEach((subcategory) => {
        map.set(subcategory.id, subcategory.keys || []);
      });
    });
    return map;
  }

  function renderFieldDefinitions() {
    const definitionByKey = new Map(fieldDefinitions.map((definition) => [definition.key, definition]));
    const keys = keysBySubcategory();
    document.querySelectorAll("[data-fields]").forEach((container) => {
      (keys.get(container.dataset.fields) || []).forEach((key) => {
        const definition = definitionByKey.get(key);
        if (definition) {
          container.append(createSettingsField(definition));
        }
      });
    });
    document.querySelectorAll("[data-field]").forEach((container) => {
      const definition = definitionByKey.get(container.dataset.field);
      if (definition) {
        container.append(createSettingsField(definition));
      }
    });
    wallpaper = controlMap.get("wallpaperUrl") || null;
  }

  function addRangeLimits() {
    fieldDefinitions.filter((definition) => definition.type === "range").forEach((definition) => {
      const input = controlMap.get(definition.key);
      const limits = config.settingsLimits[definition.key];
      if (!limits) {
        return;
      }
      input.min = String(limits.min);
      input.max = String(limits.max);
      input.step = String(limits.step);
    });
  }

  function orderedEntry(settings, key, id, index) {
    const list = Array.isArray(settings[key]) ? settings[key] : [];
    const entry = list.find((item) => item.id === id || item.key === id);
    return entry || { visible: true, order: index };
  }

  function renderOrderedEditor(containerSelector, key, items) {
    const container = document.querySelector(containerSelector);
    if (!container) {
      return;
    }
    const list = document.createElement("div");
    list.className = "settings-stack-editor";
    list.dataset.orderedKey = key;
    items.forEach((id, index) => {
      const row = document.createElement("div");
      row.className = "settings-stack-row";
      row.dataset.orderedId = id;
      const label = document.createElement("span");
      label.className = "settings-stack-row__label";
      label.textContent = labelMap[id] || id;
      const order = document.createElement("input");
      order.type = "number";
      order.min = "0";
      order.step = "1";
      order.dataset.orderedOrder = "true";
      order.setAttribute("aria-label", `${label.textContent}排序`);
      const visible = document.createElement("input");
      visible.type = "checkbox";
      visible.dataset.orderedVisible = "true";
      visible.setAttribute("aria-label", `显示${label.textContent}`);
      row.append(label, order, visible);
      list.append(row);
    });
    container.replaceChildren(list);
  }

  function renderRuleEditor(container, kind, title, emptyLabel, help) {
    const section = document.createElement("section");
    section.className = "settings-stack-editor";
    section.dataset.ruleEditor = kind;
    const heading = document.createElement("p");
    heading.className = "settings-stack-editor__title";
    heading.textContent = title;
    const list = document.createElement("div");
    list.className = "settings-stack-editor__list";
    list.dataset.ruleList = kind;
    const empty = document.createElement("small");
    empty.className = "settings-stack-editor__empty";
    empty.textContent = emptyLabel;
    list.append(empty);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "settings-button settings-button--tonal";
    add.dataset.addRule = kind;
    add.textContent = "添加规则";
    add.addEventListener("click", () => {
      list.querySelector(".settings-stack-editor__empty")?.remove();
      list.append(createRuleRow(kind));
      list.lastElementChild?.querySelector("input")?.focus();
    });
    section.append(heading);
    if (help) {
      const note = document.createElement("small");
      note.className = "settings-stack-editor__help";
      note.textContent = help;
      section.append(note);
    }
    section.append(list, add);
    container.append(section);
  }

  function createRuleRow(kind, rule = {}) {
    const row = document.createElement("div");
    row.className = "settings-stack-row";
    row.dataset.ruleRow = kind;
    const keyword = document.createElement("input");
    keyword.type = "text";
    keyword.className = "settings-text-input";
    keyword.placeholder = "关键词";
    keyword.value = rule.keyword || "";
    keyword.dataset.ruleKeyword = "true";
    keyword.setAttribute("aria-label", "关键词");
    const remark = document.createElement("input");
    remark.type = "text";
    remark.className = "settings-text-input";
    remark.placeholder = "备注（可选）";
    remark.value = rule.remark || "";
    remark.dataset.ruleRemark = "true";
    remark.setAttribute("aria-label", "规则备注");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-button settings-button--tonal";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      row.remove();
      commitSettings();
    });
    row.append(keyword, remark, remove);
    return row;
  }

  function writeRuleEditors(settings) {
    ruleGroupKeys.forEach((kind) => {
      const list = document.querySelector(`[data-rule-list="${kind}"]`);
      if (!list) {
        return;
      }
      const rules = Array.isArray(settings[kind]) ? settings[kind] : [];
      list.replaceChildren(...(rules.length ? rules.map((rule) => createRuleRow(kind, rule)) : [Object.assign(document.createElement("small"), { className: "settings-stack-editor__empty", textContent: "暂无规则" })]));
    });
  }

  function readRuleEditors() {
    const result = {};
    ruleGroupKeys.forEach((kind) => {
      result[kind] = [...document.querySelectorAll(`[data-rule-row="${kind}"]`)].map((row) => ({
        keyword: row.querySelector("[data-rule-keyword]")?.value || "",
        remark: row.querySelector("[data-rule-remark]")?.value || ""
      }));
    });
    return result;
  }

  function validateRuleValues(values) {
    Object.entries(values).forEach(([key, rules]) => {
      rules.forEach((rule, index) => {
        if (!String(rule.keyword || "").trim()) {
          throw new Error(`${key}[${index}] 的关键词不能为空`);
        }
      });
    });
  }

  function createEditorField(title, control, help = "") {
    const field = document.createElement("div");
    field.className = "settings-field";
    const row = document.createElement("div");
    row.className = "settings-field__row";
    const left = document.createElement("div");
    left.className = "settings-field__left";
    const label = document.createElement("span");
    label.className = "settings-field__title";
    label.textContent = title;
    left.append(label);
    if (help) {
      const desc = document.createElement("p");
      desc.className = "settings-field__desc";
      desc.textContent = help;
      left.append(desc);
    }
    const right = document.createElement("div");
    right.className = "settings-field__right";
    right.append(control);
    row.append(left, right);
    field.append(row);
    return field;
  }

  function renderShortcutEditor() {
    const container = document.querySelector("[data-shortcut-editor]");
    if (!container) {
      return;
    }
    const list = document.createElement("div");
    list.className = "settings-stack-editor";
    [
      ["refreshTopics", "刷新主题列表"],
      ["openSettings", "打开设置"],
      ["toggleListControls", "切换列表控制栏"]
    ].forEach(([key, label]) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-text-input";
      input.maxLength = config.settingsLimits.shortcut.maxLength;
      input.placeholder = "例如 R 或 Ctrl+Shift+R";
      input.dataset.shortcutKey = key;
      input.setAttribute("aria-label", label);
      list.append(createEditorField(label, input));
    });
    container.replaceChildren(list);
  }

  function renderShadowCurveEditor() {
    const container = document.querySelector("[data-shadow-curve-editor]");
    if (!container) {
      return;
    }
    const list = document.createElement("div");
    list.className = "settings-stack-editor";
    [[0, "近处"], [0.5, "中段"], [1, "远处"]].forEach(([position, label]) => {
      const wrapper = document.createElement("span");
      wrapper.className = "settings-slider";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(config.settingsLimits.shadowCurveOpacity.min);
      input.max = String(config.settingsLimits.shadowCurveOpacity.max);
      input.step = String(config.settingsLimits.shadowCurveOpacity.step);
      input.dataset.shadowCurveOpacity = String(position);
      input.setAttribute("aria-label", `${label}阴影透明度`);
      const output = document.createElement("output");
      output.dataset.shadowCurveOutput = String(position);
      wrapper.append(input, output);
      input.addEventListener("input", () => {
        output.textContent = `${Math.round(Number(input.value) * 100)}%`;
      });
      const field = createEditorField(label, wrapper);
      field.dataset.shadowCurveItem = String(position);
      list.append(field);
    });
    container.replaceChildren(list);
  }

  function renderStructuredEditors() {
    renderShadowCurveEditor();
    renderOrderedEditor("[data-topic-navigation-editor]", "topicNavigationConfig", config.topicNavigationItems);
    renderOrderedEditor("[data-action-rail-editor]", "actionRailItemsConfig", config.actionRailItems);
    renderOrderedEditor("[data-card-menu-editor]", "topicCardContextMenuConfig", config.topicCardContextMenuActions);

    const gridContainer = document.querySelector("[data-grid-columns-editor]");
    if (gridContainer) {
      const list = document.createElement("div");
      list.className = "settings-stack-editor";
      Object.keys(config.gridBreakpoints).forEach((key) => {
        const row = document.createElement("label");
        row.className = "settings-stack-row";
        row.dataset.gridColumn = key;
        const text = document.createElement("span");
        text.className = "settings-stack-row__label";
        text.textContent = `${key}（${config.gridBreakpoints[key]}px 起）`;
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(config.settingsLimits.gridColumn.min);
        input.max = String(config.settingsLimits.gridColumn.max);
        input.step = String(config.settingsLimits.gridColumn.step);
        input.dataset.gridColumnInput = key;
        input.setAttribute("aria-label", `${key}断点列数`);
        row.append(text, input);
        list.append(row);
      });
      gridContainer.replaceChildren(list);
    }

    const rules = document.querySelector("[data-rule-editors]");
    if (rules) {
      (config.topicRuleGroups || []).forEach((group) => {
        renderRuleEditor(rules, group.key, group.title, group.empty, group.help);
      });
    }
    renderShortcutEditor();
  }

  function writeOrderedEditor(settings, key) {
    const configured = new Map((Array.isArray(settings[key]) ? settings[key] : []).map((item) => [item.id || item.key, item]));
    document.querySelectorAll(`[data-ordered-key="${key}"] [data-ordered-id]`).forEach((row, index) => {
      const entry = configured.get(row.dataset.orderedId) || { visible: true, order: index };
      row.querySelector("[data-ordered-order]").value = String(entry.order);
      row.querySelector("[data-ordered-visible]").checked = entry.visible !== false;
    });
  }

  function syncSegmentIndicator(group) {
    const indicator = group.querySelector(".settings-segmented__indicator");
    const active = group.querySelector(".settings-segmented__item.is-active");
    if (!indicator || !active) {
      return;
    }
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  }

  const segmentObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => entries.forEach((entry) => syncSegmentIndicator(entry.target)))
    : null;

  function syncSegmentIndicators() {
    document.querySelectorAll(".settings-segmented").forEach((group) => {
      segmentObserver?.observe(group);
      syncSegmentIndicator(group);
    });
  }

  function writeAdvancedSettings(settings) {
    fieldDefinitions.forEach((definition) => {
      const input = controlMap.get(definition.key);
      if (!input) {
        return;
      }
      if (definition.type === "toggle") {
        input.checked = settings[definition.key] === true;
      } else {
        input.value = String(settings[definition.key] ?? "");
        if (definition.type === "range") {
          const output = document.querySelector(`[data-setting-output="${definition.key}"]`);
          if (output) {
            output.textContent = displayRangeValue(definition, input.value);
          }
        }
      }
    });
    Object.keys(settings.gridColumns || {}).forEach((key) => {
      const input = document.querySelector(`[data-grid-column-input="${key}"]`);
      if (input) {
        input.value = String(settings.gridColumns[key]);
      }
    });
    (settings.shadowCurve || []).forEach((point) => {
      const input = document.querySelector(`[data-shadow-curve-opacity="${point.position}"]`);
      const output = document.querySelector(`[data-shadow-curve-output="${point.position}"]`);
      if (input) {
        input.value = String(point.opacity);
      }
      if (output) {
        output.textContent = `${Math.round(Number(point.opacity) * 100)}%`;
      }
    });
    ["topicNavigationConfig", "actionRailItemsConfig", "topicCardContextMenuConfig"].forEach((key) => writeOrderedEditor(settings, key));
    writeRuleEditors(settings);
    Object.entries(settings.shortcuts || {}).forEach(([key, value]) => {
      const input = document.querySelector(`[data-shortcut-key="${key}"]`);
      if (input) {
        input.value = value;
      }
    });
    document.querySelectorAll(".settings-segmented").forEach((group) => {
      const input = group.querySelector("input[data-setting-key]");
      if (!input) {
        return;
      }
      group.querySelectorAll(".settings-segmented__item").forEach((button) => {
        const active = button.dataset.segmentValue === input.value;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-checked", String(active));
        button.tabIndex = active ? 0 : -1;
      });
    });
    if (settingsWindow) {
      settingsWindow.dataset.betterldLiquid = String(settings.liquidSegmentIndicatorEnabled === true);
    }
    syncSegmentIndicators();
    updateDependencies();
  }

  function readOrderedEditor(key, idField) {
    return [...document.querySelectorAll(`[data-ordered-key="${key}"] [data-ordered-id]`)].map((row) => ({
      [idField]: row.dataset.orderedId,
      visible: row.querySelector("[data-ordered-visible]")?.checked !== false,
      order: Number(row.querySelector("[data-ordered-order]")?.value || 0)
    }));
  }

  function readAdvancedSettings() {
    const values = {};
    fieldDefinitions.forEach((definition) => {
      const input = controlMap.get(definition.key);
      if (!input) {
        return;
      }
      if (definition.type === "toggle") {
        values[definition.key] = input.checked;
      } else if (definition.type === "range") {
        values[definition.key] = Number(input.value);
      } else {
        values[definition.key] = input.value;
      }
    });
    values.gridColumns = {};
    document.querySelectorAll("[data-grid-column-input]").forEach((input) => {
      values.gridColumns[input.dataset.gridColumnInput] = Number(input.value);
    });
    values.shadowCurve = [...document.querySelectorAll("[data-shadow-curve-opacity]")].map((input) => ({
      position: Number(input.dataset.shadowCurveOpacity),
      opacity: Number(input.value)
    }));
    values.topicNavigationConfig = readOrderedEditor("topicNavigationConfig", "id");
    values.actionRailItemsConfig = readOrderedEditor("actionRailItemsConfig", "key");
    values.topicCardContextMenuConfig = readOrderedEditor("topicCardContextMenuConfig", "key");
    Object.assign(values, readRuleEditors());
    values.shortcuts = {
      refreshTopics: document.querySelector("[data-shortcut-key=refreshTopics]")?.value ?? state.settings.shortcuts.refreshTopics,
      openSettings: document.querySelector("[data-shortcut-key=openSettings]")?.value ?? state.settings.shortcuts.openSettings,
      toggleListControls: document.querySelector("[data-shortcut-key=toggleListControls]")?.value ?? state.settings.shortcuts.toggleListControls
    };
    return values;
  }

  function updateDependencies() {
    document.querySelectorAll("[data-depends-on]").forEach((item) => {
      const input = controlMap.get(item.dataset.dependsOn);
      if (!input) {
        return;
      }
      const current = input.type === "checkbox" ? input.checked : input.value;
      item.hidden = String(current) !== item.dataset.dependsValue;
    });
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return blob.size;
  }

  function currentRules() {
    const values = readRuleEditors();
    return {
      schema: "betterld.rules",
      settingsVersion: state.settings.settingsVersion,
      exportedAt: new Date().toISOString(),
      ...values
    };
  }

  async function importSettingsFile(file) {
    const parsed = JSON.parse(await file.text());
    const result = settingsApi.normalizeImportedSettings(parsed, state.settings);
    if (result.errors.length) {
      throw new Error(result.errors.join("；"));
    }
    populate(result.settings);
    await save(result.settings);
    const notes = [];
    if (result.unknownKeys.length) {
      notes.push(`忽略 ${result.unknownKeys.length} 个未知字段`);
    }
    if (result.warnings.length) {
      notes.push(result.warnings.join("；"));
    }
    setStatusMessage(maintenanceStatus, `设置已导入，${Object.keys(result.settings).length} 个字段生效。${notes.length ? ` ${notes.join("；")}` : ""}`, "success");
  }

  async function appendRules(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("规则内容必须是 JSON 对象");
    }
    if (!ruleGroupKeys.some((key) => Array.isArray(parsed[key]))) {
      throw new Error("规则内容没有可识别的规则数组");
    }
    const merged = Object.fromEntries(ruleGroupKeys.map((key) => [key, [
      ...(Array.isArray(state.settings[key]) ? state.settings[key] : []),
      ...(Array.isArray(parsed[key]) ? parsed[key] : [])
    ]]));
    validateRuleValues(merged);
    const next = normalizeSettings({ ...state.settings, ...merged });
    writeRuleEditors(next);
    await save(next);
    return ruleGroupKeys
      .map((key) => `${key} ${(state.settings[key] || []).length}`)
      .join("、");
  }

  async function importRulesFile(file) {
    const counts = await appendRules(JSON.parse(await file.text()));
    setStatusMessage(maintenanceStatus, `筛选规则已追加并去重保存（${counts}）。`, "success");
  }

  function sendRuntimeMessage(message) {
    const sendMessage = api.runtime?.sendMessage;
    if (typeof sendMessage !== "function") {
      return Promise.reject(new Error("后台消息 API 不可用，请在扩展设置页或工具栏弹窗中重试"));
    }
    return new Promise((resolve, reject) => {
      const onResponse = (response) => {
        const error = api.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      };
      try {
        const result = sendMessage.call(api.runtime, message, onResponse);
        if (result?.then) {
          result.then(resolve).catch(reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  async function requestWebdavPermission(url) {
    if (!api.permissions?.request || !api.permissions?.contains) {
      throw new Error("当前环境不支持权限申请，请在扩展设置页或工具栏弹窗中使用 WebDAV");
    }
    const origin = `${new URL(url).origin}/*`;
    if (await api.permissions.contains({ origins: [origin] })) {
      return;
    }
    const granted = await api.permissions.request({ origins: [origin] });
    if (!granted) {
      throw new Error("未授予该地址的访问权限");
    }
  }

  async function webdavSettings() {
    await save(readForm());
    const settings = state.settings;
    if (!settings.webdavUrl) {
      throw new Error("请先填写 WebDAV 地址");
    }
    await requestWebdavPermission(settings.webdavUrl);
    return settings;
  }

  async function webdavUpload() {
    try {
      const settings = await webdavSettings();
      const response = await sendRuntimeMessage({
        type: "webdav",
        method: "PUT",
        url: settings.webdavUrl,
        username: settings.webdavUsername,
        password: settings.webdavPassword,
        body: JSON.stringify(currentRules(), null, 2)
      });
      if (!response?.ok) {
        throw new Error(response?.error || "WebDAV 上传失败");
      }
      setStatusMessage(maintenanceStatus, `规则已上传到 ${new URL(settings.webdavUrl).host}。`, "success");
    } catch (error) {
      setStatusMessage(maintenanceStatus, `WebDAV 上传失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  async function webdavDownload() {
    if (!globalThis.confirm("下载的规则会追加到现有各组规则之后并自动去重，是否继续？")) {
      return;
    }
    try {
      const settings = await webdavSettings();
      const response = await sendRuntimeMessage({
        type: "webdav",
        method: "GET",
        url: settings.webdavUrl,
        username: settings.webdavUsername,
        password: settings.webdavPassword
      });
      if (!response?.ok) {
        throw new Error(response?.error || "WebDAV 下载失败");
      }
      const counts = await appendRules(JSON.parse(response.text || "{}"));
      setStatusMessage(maintenanceStatus, `已从 WebDAV 追加规则（${counts}）。`, "success");
    } catch (error) {
      setStatusMessage(maintenanceStatus, `WebDAV 下载失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  // 只比数字段：v0.1.0 与 0.1.0 等价，缺的段按 0 处理
  function compareVersions(left, right) {
    const parts = (value) => String(value).split(".").map((item) => Number.parseInt(item, 10) || 0);
    const leftParts = parts(left);
    const rightParts = parts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (difference) {
        return difference;
      }
    }
    return 0;
  }

  // 只在主人点击时请求一次 GitHub Releases，不做自动轮询、不自动更新
  async function checkForUpdates() {
    setStatusMessage(updateStatus, "正在检查更新…");
    try {
      const response = await sendRuntimeMessage({ type: "check-update" });
      if (!response?.ok) {
        throw new Error(response?.error || "版本接口请求失败");
      }
      const current = String(api.runtime?.getManifest?.().version || "").replace(/^v/i, "");
      const latest = String(response.latestTag || "").replace(/^v/i, "");
      setStatusMessage(
        updateStatus,
        compareVersions(latest, current) > 0 ? `发现新版本 ${latest}（当前 ${current}）` : `已是最新版本 ${current}`,
        "success"
      );
    } catch (error) {
      setStatusMessage(updateStatus, `检查更新失败：${error instanceof Error ? error.message : "无法访问版本接口"}`, "error");
    }
  }

  function iconMask(svg) {
    return `url('data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round">${svg}</svg>')`;
  }

  const railIcons = {
    settings: iconMask('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    pages: iconMask('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M9 9v12"/>'),
    components: iconMask('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'),
    appearance: iconMask('<path d="M12 3a9 9 0 1 0 0 18c1.7 0 2.5-1.2 2.5-2.4 0-1.1-.8-2.1-2-2.1h-1.2a2 2 0 0 1 0-4H15a4 4 0 0 0 4-4c0-3.4-3.1-5.5-7-5.5Z"/><circle cx="8.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/>'),
    keyboard: iconMask('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>'),
    advanced: iconMask('<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>'),
    about: iconMask('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/>')
  };

  const navigationState = { category: "", subcategory: "" };

  function applyIcon(element, icon) {
    const value = railIcons[icon] || railIcons.settings;
    element.style.maskImage = value;
    element.style.webkitMaskImage = value;
  }

  function renderRail() {
    settingsRailList.replaceChildren(...config.settingsCategories.map((category) => {
      const item = document.createElement("li");
      item.className = "settings-rail__group";
      if (category.sectionStart) {
        item.classList.add("is-section-start");
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-rail__item";
      button.dataset.category = category.id;
      button.title = category.title;
      button.addEventListener("click", () => showCategory(category.id));
      const icon = document.createElement("span");
      icon.className = "settings-rail__icon";
      icon.setAttribute("aria-hidden", "true");
      applyIcon(icon, category.icon);
      const label = document.createElement("span");
      label.className = "settings-rail__label";
      label.textContent = category.title;
      button.append(icon, label);
      item.append(button);
      return item;
    }));
  }

  function renderBreadcrumb(category, subcategory) {
    const parts = [];
    const root = document.createElement("span");
    root.textContent = "设置";
    parts.push(root);
    [category.title, subcategory.title].forEach((title) => {
      const separator = document.createElement("span");
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "›";
      const strong = document.createElement("strong");
      strong.textContent = title;
      parts.push(separator, strong);
    });
    settingsBreadcrumb.replaceChildren(...parts);
  }

  function renderSectionHeading(category, subcategory) {
    const icon = document.createElement("span");
    icon.className = "settings-section-heading__icon";
    icon.setAttribute("aria-hidden", "true");
    applyIcon(icon, category.icon);
    const content = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = subcategory.title;
    content.append(title);
    if (subcategory.description) {
      const description = document.createElement("p");
      description.textContent = subcategory.description;
      content.append(description);
    }
    settingsSectionHeading.replaceChildren(icon, content);
  }

  function showCategory(categoryId, subcategoryId = "") {
    const category = config.settingsCategories.find((item) => item.id === categoryId) || config.settingsCategories[0];
    const subcategory = category.subcategories.find((item) => item.id === subcategoryId) || category.subcategories[0];
    navigationState.category = category.id;
    navigationState.subcategory = subcategory.id;

    settingsRailList.querySelectorAll(".settings-rail__item").forEach((button) => {
      const active = button.dataset.category === category.id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });

    settingsSubnav.replaceChildren(...category.subcategories.map((item) => {
      const active = item.id === subcategory.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings-subnav__item${active ? " is-active" : ""}`;
      button.setAttribute("aria-current", active ? "page" : "false");
      button.textContent = item.title;
      button.addEventListener("click", () => showCategory(category.id, item.id));
      return button;
    }));

    renderBreadcrumb(category, subcategory);
    renderSectionHeading(category, subcategory);
    settingsPageBody.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== category.id || panel.dataset.subpanel !== subcategory.id;
    });
    settingsScroll.scrollTop = 0;
    updateDependencies();
    syncSegmentIndicators();
  }

  function searchEntries() {
    return [...settingsPageBody.querySelectorAll(".settings-field")].map((field) => {
      const panel = field.closest("[data-panel]");
      const category = config.settingsCategories.find((item) => item.id === panel?.dataset.panel);
      const subcategory = category?.subcategories.find((item) => item.id === panel?.dataset.subpanel);
      return {
        field,
        title: field.querySelector(".settings-field__title")?.textContent || "",
        description: field.querySelector(".settings-field__desc")?.textContent || "",
        location: [category?.title, subcategory?.title].filter(Boolean).join(" › ")
      };
    });
  }

  function closeSearchResults() {
    settingsSearchResults.replaceChildren();
    settingsSearchResults.hidden = true;
    settingsSearchInput.setAttribute("aria-expanded", "false");
  }

  function revealSearchEntry(entry) {
    const panel = entry.field.closest("[data-panel]");
    showCategory(panel.dataset.panel, panel.dataset.subpanel);
    settingsSearchInput.value = "";
    closeSearchResults();
    entry.field.scrollIntoView({ block: "center" });
    entry.field.classList.add("is-search-target");
    window.setTimeout(() => entry.field.classList.remove("is-search-target"), config.settingsSearchHighlightMs);
  }

  function renderSearchResults() {
    const query = settingsSearchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      closeSearchResults();
      return;
    }
    const matches = searchEntries()
      .filter((entry) => `${entry.title} ${entry.description} ${entry.location}`.toLocaleLowerCase().includes(query))
      .slice(0, config.settingsSearchResultLimit);
    if (matches.length) {
      settingsSearchResults.replaceChildren(...matches.map((entry) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-search-results__item";
        button.setAttribute("role", "option");
        const title = document.createElement("strong");
        title.textContent = entry.title;
        const location = document.createElement("span");
        location.textContent = entry.location;
        button.append(title, location);
        button.addEventListener("click", () => revealSearchEntry(entry));
        return button;
      }));
    } else {
      const empty = document.createElement("p");
      empty.className = "settings-search-results__empty";
      empty.textContent = "没有匹配的设置。";
      settingsSearchResults.replaceChildren(empty);
    }
    settingsSearchResults.hidden = false;
    settingsSearchInput.setAttribute("aria-expanded", "true");
  }

  let commitTimer = 0;

  function scheduleCommit() {
    if (commitTimer) {
      clearTimeout(commitTimer);
    }
    commitTimer = window.setTimeout(() => {
      commitTimer = 0;
      commitSettings();
    }, config.settingsCommitDelayMs);
  }

  async function commitSettings() {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = 0;
    }
    try {
      await save(readForm());
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setStatusMessage(status, `设置未生效。${detail}`, "error");
      console.error("[betterLD] settings commit failed", error);
    }
  }

  renderFieldDefinitions();
  addRangeLimits();
  renderStructuredEditors();
  renderRail();
  showCategory(config.settingsCategories[0].id);

  settingsPageBody.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches("input, textarea, select")) {
      return;
    }
    if (event.target.type === "file") {
      // 文件控件在异步准备完成后由自己的处理器提交，否则会提交准备前的旧状态
      return;
    }
    updateDependencies();
    commitSettings();
  });

  settingsPageBody.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('input[type="range"]')) {
      return;
    }
    scheduleCommit();
  });

  settingsSearchInput.addEventListener("input", renderSearchResults);
  settingsSearchInput.addEventListener("focus", renderSearchResults);
  settingsSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      settingsSearchInput.value = "";
      closeSearchResults();
      return;
    }
    if (event.key === "Enter") {
      settingsSearchResults.querySelector(".settings-search-results__item")?.click();
    }
  });

  document.addEventListener("click", (event) => {
    const insideSearch = event.composedPath().some((node) => node instanceof HTMLElement && (node.id === "settings-search" || node.id === "settings-search-results"));
    if (!insideSearch) {
      closeSearchResults();
    }
  });

  settingsClose.addEventListener("click", () => {
    if (isEmbedded) {
      settingsClose.dispatchEvent(new CustomEvent("betterld-settings-close", { bubbles: true, composed: true }));
      return;
    }
    window.close();
  });

  window.addEventListener("resize", syncSegmentIndicators, { passive: true });
  document.querySelector("#check-update").addEventListener("click", checkForUpdates);

  document.querySelector("#export-settings").addEventListener("click", () => {
    const exported = Object.fromEntries(Object.entries(state.settings).filter(([key]) => key !== "webdavPassword"));
    const size = downloadJson(`betterld-settings-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}.json`, {
      schema: "betterld.settings",
      settingsVersion: state.settings.settingsVersion,
      exportedAt: new Date().toISOString(),
      ...exported
    });
    setStatusMessage(maintenanceStatus, `设置已导出（${size} 字节，${Object.keys(exported).length} 个字段，不含 WebDAV 密码）。`, "success");
  });
  document.querySelector("#import-settings").addEventListener("click", () => settingsImportFile.click());
  settingsImportFile.addEventListener("change", async () => {
    const file = settingsImportFile.files?.[0];
    settingsImportFile.value = "";
    if (!file) {
      return;
    }
    if (!globalThis.confirm("导入会用文件内容覆盖当前全部设置，是否继续？")) {
      return;
    }
    try {
      await importSettingsFile(file);
    } catch (error) {
      setStatusMessage(maintenanceStatus, `设置导入失败，当前设置未改变。 ${error instanceof Error ? error.message : "文件格式无效"}`, "error");
    }
  });
  document.querySelector("#export-rules").addEventListener("click", () => {
    const size = downloadJson(`betterld-rules-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}.json`, currentRules());
    setStatusMessage(maintenanceStatus, `筛选规则已导出（${size} 字节）。`, "success");
  });
  document.querySelector("#import-rules").addEventListener("click", () => rulesImportFile.click());
  rulesImportFile.addEventListener("change", async () => {
    const file = rulesImportFile.files?.[0];
    rulesImportFile.value = "";
    if (!file) {
      return;
    }
    if (!globalThis.confirm("导入会把文件里的规则追加到现有各组规则之后并自动去重，是否继续？")) {
      return;
    }
    try {
      await importRulesFile(file);
    } catch (error) {
      setStatusMessage(maintenanceStatus, `规则导入失败，当前规则未改变。 ${error instanceof Error ? error.message : "文件格式无效"}`, "error");
    }
  });
  document.querySelector("#webdav-upload").addEventListener("click", webdavUpload);
  document.querySelector("#webdav-download").addEventListener("click", webdavDownload);
  document.querySelector("#about-version").textContent = `版本 ${api.runtime?.getManifest?.().version || "未知"} · Manifest V3`;

  wallpaperSources.replaceChildren(...sourceOptions.map(createSourceOption));
  renderWallpaperCatalog();
  wallpaper.addEventListener("input", scheduleRemoteProbe);
  wallpaper.addEventListener("change", scheduleRemoteProbe);
  chooseWallpaperFile.addEventListener("click", () => wallpaperFile.click());
  wallpaperFile.addEventListener("change", async () => {
    const file = wallpaperFile.files?.[0];
    if (!file) {
      return;
    }
    setStatusMessage(wallpaperStatus, "正在处理图片…");
    try {
      state.localWallpaper = await prepareLocalWallpaper(file);
      state.removeLocalWallpaper = false;
      setWallpaperMode(modes.local);
      await commitSettings();
    } catch (error) {
      setStatusMessage(wallpaperStatus, error instanceof Error ? error.message : "本地图片处理失败", "error");
      console.error("[betterLD] local wallpaper failed", error);
    } finally {
      wallpaperFile.value = "";
    }
  });

  removeLocalWallpaper.addEventListener("click", () => {
    state.localWallpaper = null;
    state.removeLocalWallpaper = true;
    if (selectedMode() === modes.local) {
      setWallpaperMode(modes.none);
    } else {
      updateLocalPreview();
    }
    commitSettings();
  });

  clearSearchHistory.addEventListener("click", async () => {
    if (!globalThis.confirm("清空搜索历史会删除全部已保存的搜索词，是否继续？")) {
      return;
    }
    try {
      await save(normalizeSettings({ ...state.settings, searchHistory: [] }));
      setStatusMessage(maintenanceStatus, "搜索历史已清空。", "success");
    } catch (error) {
      setStatusMessage(maintenanceStatus, `搜索历史清空失败：${error instanceof Error ? error.message : "操作失败"}`, "error");
    }
  });

  syncNow.addEventListener("click", async () => {
    if (!state.settings.syncEnabled) {
      setStatusMessage(maintenanceStatus, "请先启用浏览器同步。", "error");
      return;
    }
    try {
      const active = await getActiveSettings();
      const stored = await storageGet([config.syncMetadataKey]).catch(() => ({}));
      if (settingsApi.stableStringify(active.settings) !== settingsApi.stableStringify(state.settings)) {
        populate(active.settings);
      }
      await reconcileSyncSettings(active.settings, stored[config.syncMetadataKey]);
    } catch (error) {
      setStatusMessage(maintenanceStatus, `同步失败，本地设置保持不变：${error instanceof Error ? error.message : "同步服务不可用"}`, "error");
    }
  });

  reset.addEventListener("click", async () => {
    if (!globalThis.confirm("恢复默认会立即覆盖当前全部设置，是否继续？")) {
      return;
    }
    state.removeLocalWallpaper = false;
    setStatusMessage(wallpaperStatus, "");
    try {
      await save(normalizeSettings(config.settingsDefaults));
      populate(config.settingsDefaults);
      setStatusMessage(status, "✓ 已恢复默认设置。", "success");
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setStatusMessage(status, `默认设置保存失败。${detail}`, "error");
      console.error("[betterLD] default settings save failed", error);
    }
  });

  api.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes[config.storageKey] && !state.settings.syncEnabled) {
      state.activeStorageArea = "local";
      populate(changes[config.storageKey].newValue);
      return;
    }
    if (areaName !== "sync" || !changes[config.storageKey] || !state.settings.syncEnabled || state.syncBusy) {
      return;
    }
    state.activeStorageArea = "sync";
    const remoteSettings = changes[config.storageKey].newValue;
    const remoteMetadata = syncMetadata(changes[config.syncMetadataKey]?.newValue);
    storageGet([config.syncMetadataKey]).then((stored) => {
      if (remoteMetadata.updatedAt <= syncMetadata(stored[config.syncMetadataKey]).updatedAt) {
        return;
      }
      const merged = normalizeSettings({ ...state.settings, ...remoteSettings });
      return storageSet({ [config.storageKey]: merged, [config.syncMetadataKey]: remoteMetadata }).then(() => {
        state.syncMetadata = remoteMetadata;
        populate(merged);
        setStatusMessage(maintenanceStatus, "已应用较新的同步设置。", "success");
      });
    }).catch((error) => {
      setStatusMessage(maintenanceStatus, `同步变更应用失败：${error instanceof Error ? error.message : "本地写入失败"}`, "error");
    });
  });

  storageGet([config.storageKey, config.wallpaperLocalStorageKey, config.syncMetadataKey])
    .then(async (stored) => {
      state.localWallpaper = isStoredLocalWallpaper(stored[config.wallpaperLocalStorageKey])
        ? stored[config.wallpaperLocalStorageKey]
        : null;
      state.syncMetadata = syncMetadata(stored[config.syncMetadataKey]);
      populate(stored[config.storageKey]);
      if (state.settings.syncEnabled) {
        await reconcileSyncSettings(state.settings, stored[config.syncMetadataKey]);
      }
    })
    .catch((error) => {
      state.localWallpaper = null;
      populate(config.settingsDefaults);
      setStatusMessage(status, "设置读取失败，已使用安全默认值。", "error");
      console.error("[betterLD] settings load failed", error);
    });
})();
