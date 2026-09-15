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

  const form = document.querySelector("#settings-form");
  const wallpaper = document.querySelector("#wallpaper");
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
  const maskOpacity = document.querySelector("#mask-opacity");
  const blur = document.querySelector("#blur");
  const cardOpacity = document.querySelector("#card-opacity");
  const maskOpacityValue = document.querySelector("#mask-opacity-value");
  const blurValue = document.querySelector("#blur-value");
  const cardOpacityValue = document.querySelector("#card-opacity-value");
  const reset = document.querySelector("#reset");
  const status = document.querySelector("#status");

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

  function setStatusMessage(element, message, statusType = "") {
    element.textContent = message;
    if (statusType) {
      element.dataset.status = statusType;
    } else {
      delete element.dataset.status;
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

  function setRangeAttributes(input, limits) {
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
  }

  function updateOutputs() {
    maskOpacityValue.value = `${Math.round(Number(maskOpacity.value) * 100)}%`;
    blurValue.value = `${blur.value}px`;
    cardOpacityValue.value = `${Math.round(Number(cardOpacity.value) * 100)}%`;
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
    wallpaper.value = settings.wallpaperUrl || (settings.wallpaperMode === modes.url ? settings.wallpaper : "");
    maskOpacity.value = String(settings.maskOpacity);
    blur.value = String(settings.blurPx);
    cardOpacity.value = String(settings.cardOpacity);
    writeAdvancedSettings(settings);
    applyLanguage(settings.language);
    const mode = settings.wallpaperMode === modes.builtin && !catalogItem(settings.wallpaperId, modes.builtin)
      ? modes.none
      : settings.wallpaperMode;
    renderWallpaperCatalog();
    setWallpaperMode(mode);
    updateOutputs();
  }

  function readForm() {
    const mode = selectedMode();
    const ruleValues = readRuleEditors();
    validateRuleValues(ruleValues);
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
      ...readAdvancedSettings(),
      ...ruleValues,
      searchHistory: state.settings.searchHistory,
      wallpaper: legacyWallpaper,
      wallpaperMode: mode,
      wallpaperId,
      wallpaperUrl,
      wallpaperLocalId: mode === modes.local ? state.localWallpaper.id : "",
      wallpaperRandomDate: keepRandomResult ? state.settings.wallpaperRandomDate : "",
      wallpaperRandomUrl: keepRandomResult ? state.settings.wallpaperRandomUrl : "",
      maskOpacity: maskOpacity.value,
      blurPx: blur.value,
      cardOpacity: cardOpacity.value
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
    topicTitleFontSize: { responsive: "响应式", small: "小", base: "标准", large: "大" },
    topicAuthorFontSize: { small: "小", base: "标准", large: "大" },
    topicMetaFontSize: { small: "小", base: "标准", large: "大" },
    topicNavigationAlignment: { left: "左对齐", center: "居中" },
    headerVisualMode: { native: "原站样式", transparent: "透明", frosted: "毛玻璃", solid: "不透明" },
    sidebarPosition: { original: "保留原位", right: "移动到右侧" },
    actionRailPosition: { left: "左侧", right: "右侧", bottom: "底部" },
    actionRailVisibility: { always: "始终显示", auto: "滚动时半隐藏", hidden: "默认隐藏" },
    topicCardOpenMode: { currentTab: "当前标签页", newTab: "新标签页", background: "后台标签页", drawer: "摘要抽屉" },
    navigationOpenMode: { currentTab: "当前标签页", newTab: "新标签页" },
    searchOpenMode: { currentTab: "当前标签页", newTab: "新标签页" },
    notificationOpenMode: { page: "当前页面", newTab: "新标签页" },
    topicFilterMode: { hide: "隐藏命中项", include: "只显示命中项" },
    searchMode: { native: "原生结果", cards: "主题卡片" },
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
    topicTitleFontSize: { responsive: "Responsive", small: "Small", base: "Base", large: "Large" },
    topicAuthorFontSize: { small: "Small", base: "Base", large: "Large" },
    topicMetaFontSize: { small: "Small", base: "Base", large: "Large" },
    topicNavigationAlignment: { left: "Left", center: "Center" },
    headerVisualMode: { native: "Native", transparent: "Transparent", frosted: "Frosted", solid: "Solid" },
    sidebarPosition: { original: "Original", right: "Right" },
    actionRailPosition: { left: "Left", right: "Right", bottom: "Bottom" },
    actionRailVisibility: { always: "Always", auto: "Partly hidden while scrolling", hidden: "Hidden by default" },
    topicCardOpenMode: { currentTab: "Current tab", newTab: "New tab", background: "Background tab", drawer: "Summary drawer" },
    navigationOpenMode: { currentTab: "Current tab", newTab: "New tab" },
    searchOpenMode: { currentTab: "Current tab", newTab: "New tab" },
    notificationOpenMode: { page: "Current page", newTab: "New tab" },
    topicFilterMode: { hide: "Hide matches", include: "Show matches only" },
    searchMode: { native: "Native results", cards: "Topic cards" },
    searchResultsPaginationMode: { scroll: "Infinite scroll", pagination: "Pagination" },
    searchPageWallpaperMode: { inherit: "Inherit global", builtin: "Built-in image", url: "Remote image" },
    touchOptimization: { auto: "Automatic", on: "On", off: "Off" }
  };

  const englishFieldLabels = {
    language: "Settings language", themeMode: "Theme mode", themeScheduleStart: "Dark mode starts", themeScheduleEnd: "Dark mode ends", themeColor: "Theme color", darkModeBaseColor: "Dark base color", useGradientThemeColorBackground: "Use theme-color gradient", liquidSegmentIndicatorEnabled: "Liquid segment indicator", frostedGlassEnabled: "Enable frosted glass", sidebarCoverBlurEnabled: "Sidebar cover blur", surfaceBlurPx: "Surface blur", shadowMode: "Shadow mode", shadowHeight: "Shadow height", fontMode: "Font preference", fontScope: "Font scope", fontFamily: "Custom font family", removeChinesePunctuationIndent: "Remove Chinese punctuation indent", customCssEnabled: "Enable custom CSS", customCss: "Custom CSS", wallpaperRemoteCacheDays: "Remote wallpaper cache", applyToUnmanagedPages: "Apply shell visuals to unmanaged pages",
    gridMode: "Grid mode", cardMinSize: "Card minimum width", cardSideGutter: "Card side gutter", gridGap: "Card gap", showTopicAvatar: "Show author avatar", showTopicAuthor: "Show author", showTopicCategory: "Show category", showTopicExcerpt: "Show excerpt", showTopicMeta: "Show topic metadata", showTopicUnreadState: "Show unread state", showTopicPinnedState: "Show pinned state", topicListLayoutMode: "Topic card style", topicTitleFontSize: "Title size", topicAuthorFontSize: "Author size", topicMetaFontSize: "Metadata size",
    topicNavigationAlignment: "Topic navigation alignment", topicNavigationSticky: "Sticky topic navigation", showTopicNavigationCounts: "Show navigation counts", headerVisible: "Show Header", headerVisualMode: "Header visual", autoHideHeader: "Auto-hide Header", sidebarPosition: "Sidebar position", autoHideSidebar: "Auto-hide Sidebar", showSettingsTrigger: "Show settings entry", showThemeToggle: "Show theme toggle", actionRailEnabled: "Enable action rail", actionRailPosition: "Action rail position", actionRailVisibility: "Action rail visibility", actionRailGlow: "Action rail glow", showBackToTopButton: "Show back-to-top", showRefreshButton: "Show refresh", separateNavigationActions: "Separate navigation actions", enableUndoRefresh: "Enable undo refresh",
    topicFilterEnabled: "Enable topic filter", topicFilterMode: "Filter match behavior", searchMode: "Search result mode", searchHistoryEnabled: "Save search history", searchRecommendationEnabled: "Enable search recommendations", searchFocusDimming: "Search focus dimming", searchFocusBlur: "Search focus blur", searchResultsPaginationMode: "Search pagination", searchPageWallpaperMode: "Search page wallpaper", searchPageWallpaperId: "Search built-in wallpaper ID", searchPageWallpaperUrl: "Search remote wallpaper URL",
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
    "立即同步": "Sync now",
    "Manifest V3 · Chrome / Firefox 桌面端 · 仅处理 betterLD 所需的主题与设置数据。": "Manifest V3 · Chrome / Firefox desktop · Processes only the topic and settings data required by betterLD.",
    "项目主页": "Project home",
    "问题反馈": "Report an issue"
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
    document.querySelectorAll("[data-settings-title]").forEach((group) => {
      const source = group.dataset.betterldSettingsTitle || group.dataset.settingsTitle;
      group.dataset.betterldSettingsTitle = source;
      if (source) {
        group.dataset.settingsTitle = english ? (staticTranslations[source] || source) : source;
      }
    });
    document.querySelectorAll("[data-settings-key]").forEach((item) => {
      const key = item.dataset.settingsKey;
      const label = item.querySelector(".settings-item__label");
      const source = item.dataset.betterldSettingLabel || label?.textContent.trim();
      if (source) {
        item.dataset.betterldSettingLabel = source;
        if (label) {
          label.textContent = english ? (englishFieldLabels[key] || source) : source;
        }
        const input = item.querySelector("[data-setting-key]");
        input?.setAttribute("aria-label", english ? (englishFieldLabels[key] || source) : source);
        if (input?.tagName === "SELECT") {
          input.querySelectorAll("option").forEach((option) => {
            const value = option.value;
            const chinese = option.dataset.betterldZh || enumLabels[key]?.[value] || option.textContent;
            option.dataset.betterldZh = chinese;
            option.textContent = english ? (englishEnumLabels[key]?.[value] || value) : chinese;
          });
        }
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
    { section: "appearance", key: "language", type: "select", label: "设置页语言", help: "只改变 betterLD 自有设置和状态文案。" },
    { section: "appearance", key: "themeMode", type: "select", label: "主题模式", help: "自动模式优先读取 LinuxDo 的主题状态。" },
    { section: "appearance", key: "themeScheduleStart", type: "time", label: "深色主题开始", help: "按时间切换时使用。", dependsOn: ["themeMode", "scheduled"] },
    { section: "appearance", key: "themeScheduleEnd", type: "time", label: "深色主题结束", help: "支持跨午夜时间段。", dependsOn: ["themeMode", "scheduled"] },
    { section: "appearance", key: "themeColor", type: "color", label: "主题色", help: "只作用于 betterLD 自有控件和卡片。" },
    { section: "appearance", key: "darkModeBaseColor", type: "color", label: "深色基色", help: "调整 betterLD 深色背景，不降低正文对比度。" },
    { section: "appearance", key: "useGradientThemeColorBackground", type: "toggle", label: "使用主题色渐变背景", help: "只改变 betterLD 自有背景。" },
    { section: "appearance", key: "liquidSegmentIndicatorEnabled", type: "toggle", label: "设置分段控件液态指示器", help: "减少动效时会自动使用静态指示器。" },
    { section: "appearance", key: "frostedGlassEnabled", type: "toggle", label: "启用毛玻璃", help: "关闭后表面不再使用 backdrop-filter。" },
    { section: "appearance", key: "sidebarCoverBlurEnabled", type: "toggle", label: "启用侧栏遮罩模糊", help: "只影响 betterLD 侧栏覆盖层。" },
    { section: "appearance", key: "surfaceBlurPx", type: "range", label: "表面模糊", unit: "px", help: "卡片、菜单、导航和 Header 的独立模糊强度。" },
    { section: "appearance", key: "shadowMode", type: "select", label: "阴影模式", help: "自定义阴影只作用于 betterLD 自有卡片。" },
    { section: "appearance", key: "shadowHeight", type: "range", label: "阴影高度", unit: "", help: "控制卡片阴影的整体高度。" },
    { section: "appearance", key: "fontMode", type: "select", label: "字体偏好", help: "不加载远程字体。" },
    { section: "appearance", key: "fontScope", type: "select", label: "字体作用范围", help: "默认只覆盖 betterLD 自有内容。" },
    { section: "appearance", key: "fontFamily", type: "text", label: "自定义字体族", help: "只使用本机或系统已有字体。", dependsOn: ["fontMode", "custom"] },
    { section: "appearance", key: "removeChinesePunctuationIndent", type: "toggle", label: "移除中文标点缩进", help: "只作用于 betterLD 自有文本。" },
    { section: "appearance", key: "customCssEnabled", type: "toggle", label: "启用自定义 CSS", help: "保存前会执行 CSSOM、选择器和属性白名单校验。" },
    { section: "appearance", key: "customCss", type: "textarea", label: "自定义 CSS", help: "每条规则必须命中 .betterld- 或 [data-betterld-] 命名空间。", wide: true, dependsOn: ["customCssEnabled", true] },
    { section: "advanced", key: "wallpaperRemoteCacheDays", type: "select", label: "远程壁纸缓存时长", options: [{ value: "0", label: "仅使用浏览器缓存" }, { value: "1", label: "1 天" }, { value: "7", label: "7 天" }, { value: "30", label: "30 天" }], help: "只缓存 URL、探测时间和成功状态，不保存图片正文。" },
    { section: "advanced", key: "applyToUnmanagedPages", type: "toggle", label: "对未管理页面应用壳层视觉", help: "只扩展背景、Header 和 Sidebar，不注入主题卡片。" },

    { section: "card", key: "gridMode", type: "select", label: "网格模式", help: "自适应模式保留可用宽度和窄屏单列边界。" },
    { section: "card", key: "cardMinSize", type: "range", label: "卡片最小宽度", unit: "px", help: "自适应网格的最小轨道宽度。" },
    { section: "card", key: "cardSideGutter", type: "range", label: "卡片左右内缩", unit: "px", help: "保持页面内容与边缘的安全间距。" },
    { section: "card", key: "gridGap", type: "range", label: "卡片间距", unit: "px", help: "卡片网格的行列间距。" },
    { section: "card", key: "showTopicAvatar", type: "toggle", label: "显示作者头像", help: "关闭后保留身份栏的可读宽度。" },
    { section: "card", key: "showTopicAuthor", type: "toggle", label: "显示作者", help: "不会改变作者 JSON 请求和权威来源。" },
    { section: "card", key: "showTopicCategory", type: "toggle", label: "显示分类", help: "保留主题链接和分类数据。" },
    { section: "card", key: "showTopicExcerpt", type: "toggle", label: "显示正文摘要", help: "关闭后停止仅摘要观察请求。" },
    { section: "card", key: "showTopicMeta", type: "toggle", label: "显示主题元信息", help: "控制回复数和活动时间。" },
    { section: "card", key: "showTopicUnreadState", type: "toggle", label: "显示未读状态", help: "不改变原站未读语义。" },
    { section: "card", key: "showTopicPinnedState", type: "toggle", label: "显示置顶状态", help: "不改变原站置顶排序。" },
    { section: "card", key: "topicListLayoutMode", type: "select", label: "主题卡片样式", help: "阅读卡适配核心 Markdown；原生模式恢复原始列表、分页和控制项。" },
    { section: "card", key: "topicTitleFontSize", type: "select", label: "标题字号", help: "只调整 betterLD 卡片标题。" },
    { section: "card", key: "topicAuthorFontSize", type: "select", label: "作者字号", help: "只调整 betterLD 卡片作者。" },
    { section: "card", key: "topicMetaFontSize", type: "select", label: "元信息字号", help: "只调整 betterLD 卡片元信息。" },

    { section: "navigation", key: "topicNavigationAlignment", type: "select", label: "主题导航对齐", help: "保留原始链接和 active 语义。" },
    { section: "navigation", key: "topicNavigationSticky", type: "toggle", label: "固定主题导航", help: "与列表控制栏滚动收起协调。" },
    { section: "navigation", key: "showTopicNavigationCounts", type: "toggle", label: "显示导航数量", help: "隐藏视觉数量但保留可访问语义。" },
    { section: "navigation", key: "headerVisible", type: "toggle", label: "显示 Header", help: "不重建原站 Logo、搜索、通知或用户菜单。" },
    { section: "navigation", key: "headerVisualMode", type: "select", label: "Header 视觉", help: "只覆盖已确认的原生 Header surface。" },
    { section: "navigation", key: "autoHideHeader", type: "toggle", label: "自动隐藏 Header", help: "移动端默认不隐藏，焦点进入 Header 时恢复。" },
    { section: "navigation", key: "sidebarPosition", type: "select", label: "Sidebar 位置", help: "窄屏会保留原站移动抽屉。" },
    { section: "navigation", key: "autoHideSidebar", type: "toggle", label: "自动隐藏 Sidebar", help: "仅宽屏启用，并保留悬停和键盘热区。" },
    { section: "navigation", key: "showSettingsTrigger", type: "toggle", label: "显示设置入口", help: "使用 runtime.openOptionsPage() 打开本页。" },
    { section: "navigation", key: "showThemeToggle", type: "toggle", label: "显示主题切换入口", help: "保留原站主题切换语义。" },
    { section: "navigation", key: "actionRailEnabled", type: "toggle", label: "启用浮动操作栏", help: "只创建一个 betterLD 操作组。" },
    { section: "navigation", key: "actionRailPosition", type: "select", label: "操作栏位置", help: "仅启用操作栏时生效。", dependsOn: ["actionRailEnabled", true] },
    { section: "navigation", key: "actionRailVisibility", type: "select", label: "操作栏显隐", help: "自动模式会随滚动半隐藏。", dependsOn: ["actionRailEnabled", true] },
    { section: "navigation", key: "actionRailGlow", type: "toggle", label: "操作栏发光", help: "仅作用于 betterLD 操作栏。", dependsOn: ["actionRailEnabled", true] },
    { section: "navigation", key: "showBackToTopButton", type: "toggle", label: "显示返回顶部", help: "使用 window.scrollTo，不改变路由。" },
    { section: "navigation", key: "showRefreshButton", type: "toggle", label: "显示刷新按钮", help: "使用原生 location.reload()。" },
    { section: "navigation", key: "separateNavigationActions", type: "toggle", label: "分离导航操作", help: "避免与原站按钮重复。" },
    { section: "navigation", key: "enableUndoRefresh", type: "toggle", label: "启用刷新撤销", help: "需要刷新前状态恢复链路支持。" },

    { section: "filter", key: "topicFilterEnabled", type: "toggle", label: "启用主题过滤", help: "只影响 betterLD 生成的卡片。" },
    { section: "filter", key: "topicFilterMode", type: "select", label: "过滤命中行为", help: "标题、作者和分类规则统一使用此模式。", dependsOn: ["topicFilterEnabled", true] },

    { section: "search", key: "searchMode", type: "select", label: "搜索结果模式", help: "当前 /search 仍以原生结果为默认。" },
    { section: "search", key: "searchHistoryEnabled", type: "toggle", label: "保存搜索历史", help: "只保存用户实际提交的搜索词。" },
    { section: "search", key: "searchRecommendationEnabled", type: "toggle", label: "启用搜索推荐", help: "需确认 LinuxDo 搜索建议来源后生效。" },
    { section: "search", key: "searchFocusDimming", type: "toggle", label: "搜索聚焦遮罩", help: "只遮罩 betterLD 自有背景。" },
    { section: "search", key: "searchFocusBlur", type: "toggle", label: "搜索聚焦模糊", help: "独立于全局壁纸模糊，可能影响性能。" },
    { section: "search", key: "searchResultsPaginationMode", type: "select", label: "搜索结果分页", help: "真实分页机制确认后生效。" },
    { section: "search", key: "searchPageWallpaperMode", type: "select", label: "搜索页壁纸", help: "默认继承全局壁纸。" },
    { section: "search", key: "searchPageWallpaperId", type: "text", label: "搜索页内置壁纸 ID", help: "仅在搜索页壁纸选择内置图片时生效。", dependsOn: ["searchPageWallpaperMode", "builtin"] },
    { section: "search", key: "searchPageWallpaperUrl", type: "url", label: "搜索页远程壁纸 URL", help: "只接受 HTTPS 地址。", dependsOn: ["searchPageWallpaperMode", "url"] },

    { section: "interaction", key: "topicCardOpenMode", type: "select", label: "主题卡片打开方式", help: "默认保持当前标签页行为。" },
    { section: "interaction", key: "navigationOpenMode", type: "select", label: "导航链接打开方式", help: "保留 modifier-click 和键盘行为。" },
    { section: "interaction", key: "searchOpenMode", type: "select", label: "搜索链接打开方式", help: "只作用于 betterLD 接管的搜索链接。" },
    { section: "interaction", key: "notificationOpenMode", type: "select", label: "通知链接打开方式", help: "不修改原站通知内容。" },
    { section: "interaction", key: "drawerCloseOnOverlay", type: "toggle", label: "点击遮罩关闭抽屉", help: "抽屉关闭后焦点回到触发卡片。" },
    { section: "interaction", key: "drawerCloseOnEscape", type: "toggle", label: "按 Escape 关闭抽屉", help: "保留原生键盘关闭路径。" },
    { section: "interaction", key: "touchOptimization", type: "select", label: "触屏优化", help: "开启时操作目标至少 44 × 44px。" },
    { section: "interaction", key: "enableHorizontalNavigationScroll", type: "toggle", label: "允许导航横向滚动", help: "只作用于主题导航和设置页标签。" },
    { section: "interaction", key: "showHomeButtonInTouchMode", type: "toggle", label: "触屏显示首页按钮", help: "提供可发现的返回首页路径。" },
    { section: "interaction", key: "shortcutsEnabled", type: "toggle", label: "启用快捷键", help: "输入框、编辑器和可编辑元素聚焦时不触发。" },
    { section: "interaction", key: "syncEnabled", type: "toggle", label: "启用浏览器同步", help: "下一步同步实现会使用 storage.sync；本地壁纸和搜索历史不会同步。" }
  ];

  const labelMap = {
    latest: "最新", new: "新主题", unread: "未读", hot: "热门", top: "热门排行", posted: "我发布的", read: "已读", bookmarks: "书签", categories: "分类",
    settings: "设置", theme: "主题", refresh: "刷新",
    openCurrentTab: "当前标签页打开", openNewTab: "新标签页打开", openBackground: "后台标签页打开", openDrawer: "打开摘要抽屉",
    copyTopicUrl: "复制主题 URL", copyCleanUrl: "复制干净 URL", copyTopicId: "复制主题 ID", openCategory: "打开分类", openAuthor: "打开作者主页"
  };

  const controlMap = new Map();
  const settingsSearch = document.querySelector("#settings-search");
  const settingsSearchClear = document.querySelector("#settings-search-clear");
  const settingsSearchEmpty = document.querySelector("#settings-search-empty");
  const maintenanceStatus = document.querySelector("#maintenance-status");
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

  function createSettingsField(definition) {
    const item = document.createElement("label");
    item.className = `settings-item${definition.wide ? " settings-item--wide" : ""}`;
    item.dataset.settingsItem = "true";
    item.dataset.settingsKey = definition.key;
    if (definition.dependsOn) {
      item.dataset.dependsOn = definition.dependsOn[0];
      item.dataset.dependsValue = String(definition.dependsOn[1]);
    }

    const controlId = `setting-${definition.key.replace(/[^a-z0-9-]/gi, "-")}`;
    const input = document.createElement(definition.type === "select" ? "select" : definition.type === "textarea" ? "textarea" : "input");
    input.id = controlId;
    input.dataset.settingKey = definition.key;
    input.name = definition.key;
    input.setAttribute("aria-label", definition.label);

    if (definition.type === "toggle") {
      item.classList.add("settings-item--check");
      input.type = "checkbox";
      const title = document.createElement("span");
      title.className = "settings-item__label";
      title.textContent = definition.label;
      item.append(input, title);
    } else {
      const title = document.createElement("span");
      title.className = "settings-item__label";
      title.textContent = definition.label;
      const wrapper = document.createElement("span");
      wrapper.className = "settings-item__control";
      if (definition.type === "range") {
        input.type = "range";
        const output = document.createElement("output");
        output.dataset.settingOutput = definition.key;
        wrapper.append(input, output);
        input.addEventListener("input", () => {
          output.textContent = displayRangeValue(definition, input.value);
        });
      } else if (definition.type === "color") {
        input.type = "color";
      } else if (definition.type === "time") {
        input.type = "time";
      } else if (definition.type === "url") {
        input.type = "url";
        input.inputMode = "url";
      } else if (definition.type === "text") {
        input.type = "text";
        input.autocomplete = "off";
      } else if (definition.type === "select") {
        fieldOptions(definition).forEach((option) => {
          const optionElement = document.createElement("option");
          optionElement.value = String(option.value);
          optionElement.textContent = option.label;
          input.append(optionElement);
        });
      }
      wrapper.append(input);
      item.append(title, wrapper);
    }

    if (definition.help) {
      const help = document.createElement("small");
      help.textContent = definition.help;
      item.append(help);
    }
    controlMap.set(definition.key, input);
    return item;
  }

  function renderFieldDefinitions() {
    const containers = {
      appearance: document.querySelector("#appearance-settings"),
      card: document.querySelector("#card-settings"),
      navigation: document.querySelector("#navigation-settings"),
      filter: document.querySelector("#filter-settings"),
      search: document.querySelector("#search-settings"),
      interaction: document.querySelector("#interaction-settings"),
      advanced: document.querySelector("#advanced-settings")
    };
    fieldDefinitions.forEach((definition) => containers[definition.section]?.append(createSettingsField(definition)));
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

  function renderOrderedEditor(containerId, title, key, items) {
    const container = document.querySelector(containerId);
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("div");
    list.className = "settings-ordered-list";
    list.dataset.orderedKey = key;
    items.forEach((id, index) => {
      const row = document.createElement("div");
      row.className = "settings-ordered-row";
      row.dataset.orderedId = id;
      const label = document.createElement("span");
      label.className = "settings-ordered-row__label";
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
    container.replaceChildren(heading, list);
  }

  function renderRuleEditor(container, kind, title, emptyLabel) {
    const section = document.createElement("section");
    section.className = "rule-editor";
    section.dataset.ruleEditor = kind;
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("div");
    list.className = "rule-list";
    list.dataset.ruleList = kind;
    const empty = document.createElement("small");
    empty.className = "rule-empty";
    empty.textContent = emptyLabel;
    list.append(empty);
    const actions = document.createElement("div");
    actions.className = "settings-subsection__actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button button-tonal";
    add.dataset.addRule = kind;
    add.textContent = "添加规则";
    actions.append(add);
    section.append(heading, list, actions);
    container.append(section);
  }

  function createRuleRow(kind, rule = {}) {
    const row = document.createElement("div");
    row.className = "settings-rule-row";
    row.dataset.ruleRow = kind;
    const keyword = document.createElement("input");
    keyword.type = "text";
    keyword.placeholder = "关键词";
    keyword.value = rule.keyword || "";
    keyword.dataset.ruleKeyword = "true";
    keyword.setAttribute("aria-label", "关键词");
    const remark = document.createElement("input");
    remark.type = "text";
    remark.placeholder = "备注（可选）";
    remark.value = rule.remark || "";
    remark.dataset.ruleRemark = "true";
    remark.setAttribute("aria-label", "规则备注");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-tonal";
    remove.textContent = "删除";
    remove.addEventListener("click", () => row.remove());
    row.append(keyword, remark, remove);
    return row;
  }

  function writeRuleEditors(settings) {
    ["topicTitleRules", "topicAuthorRules", "topicCategoryRules"].forEach((kind) => {
      const list = document.querySelector(`[data-rule-list="${kind}"]`);
      if (!list) {
        return;
      }
      const rules = Array.isArray(settings[kind]) ? settings[kind] : [];
      list.replaceChildren(...(rules.length ? rules.map((rule) => createRuleRow(kind, rule)) : [Object.assign(document.createElement("small"), { className: "rule-empty", textContent: "暂无规则" })]));
    });
  }

  function readRuleEditors() {
    const result = {};
    ["topicTitleRules", "topicAuthorRules", "topicCategoryRules"].forEach((kind) => {
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

  function renderShortcutEditor() {
    const container = document.querySelector("#shortcut-settings");
    const heading = document.createElement("h3");
    heading.textContent = "快捷键（可选）";
    const list = document.createElement("div");
    list.className = "settings-fields";
    [
      ["refreshTopics", "刷新主题列表"],
      ["openSettings", "打开设置"],
      ["toggleListControls", "切换列表控制栏"]
    ].forEach(([key, label]) => {
      const item = document.createElement("label");
      item.className = "settings-item";
      const title = document.createElement("span");
      title.className = "settings-item__label";
      title.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = config.settingsLimits.shortcut.maxLength;
      input.placeholder = "例如 R 或 Ctrl+Shift+R";
      input.dataset.shortcutKey = key;
      input.setAttribute("aria-label", label);
      item.append(title, input);
      list.append(item);
    });
    container.replaceChildren(heading, list);
  }

  function renderShadowCurveEditor() {
    const container = document.querySelector("#shadow-curve-settings");
    const heading = document.createElement("h3");
    heading.textContent = "自定义阴影曲线";
    const description = document.createElement("small");
    description.textContent = "固定 3 个控制点，从近处到远处调整透明度。仅在自定义阴影模式下生效。";
    const list = document.createElement("div");
    list.className = "settings-fields";
    [[0, "近处"], [0.5, "中段"], [1, "远处"]].forEach(([position, label]) => {
      const item = document.createElement("label");
      item.className = "settings-item";
      item.dataset.shadowCurveItem = String(position);
      const title = document.createElement("span");
      title.className = "settings-item__label";
      title.textContent = label;
      const wrapper = document.createElement("span");
      wrapper.className = "settings-item__control";
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
      item.append(title, wrapper);
      list.append(item);
    });
    container.replaceChildren(heading, description, list);
  }

  function renderStructuredEditors() {
    renderShadowCurveEditor();
    renderOrderedEditor("#topic-navigation-settings", "主题导航项目", "topicNavigationConfig", config.topicNavigationItems);
    renderOrderedEditor("#action-rail-settings", "操作栏项目", "actionRailItemsConfig", config.actionRailItems);
    renderOrderedEditor("#card-menu-settings", "卡片菜单项目", "topicCardContextMenuConfig", config.topicCardContextMenuActions);
    const gridContainer = document.querySelector("#grid-columns-settings");
    const heading = document.createElement("h3");
    heading.textContent = "固定网格断点列数";
    const list = document.createElement("div");
    list.className = "settings-ordered-list";
    Object.keys(config.gridBreakpoints).forEach((key) => {
      const row = document.createElement("label");
      row.className = "settings-ordered-row";
      row.dataset.gridColumn = key;
      const text = document.createElement("span");
      text.className = "settings-ordered-row__label";
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
    gridContainer.replaceChildren(heading, list);
    const rules = document.querySelector("#rule-editors");
    renderRuleEditor(rules, "topicTitleRules", "标题规则", "暂无标题规则");
    renderRuleEditor(rules, "topicAuthorRules", "作者规则", "暂无作者规则");
    renderRuleEditor(rules, "topicCategoryRules", "分类规则", "暂无分类规则");
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

  function filterSettings() {
    const query = settingsSearch.value.trim().toLocaleLowerCase();
    let hasVisibleGroup = false;
    document.querySelectorAll("[data-settings-group]").forEach((group) => {
      const groupText = `${group.dataset.settingsTitle || ""} ${group.textContent}`.toLocaleLowerCase();
      let visibleItems = 0;
      group.querySelectorAll("[data-settings-item]").forEach((item) => {
        const searchable = `${item.dataset.settingsKey || ""} ${item.textContent}`.toLocaleLowerCase();
        const visible = !query || searchable.includes(query) || groupText.includes(query);
        item.hidden = !visible;
        if (visible) {
          visibleItems += 1;
        }
      });
      const visible = !query || groupText.includes(query) || visibleItems > 0;
      group.hidden = !visible;
      hasVisibleGroup ||= visible;
    });
    settingsSearchClear.hidden = !query;
    settingsSearchEmpty.hidden = hasVisibleGroup;
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

  async function importRulesFile(file) {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("规则文件必须是 JSON 对象");
    }
    const keys = ["topicTitleRules", "topicAuthorRules", "topicCategoryRules"];
    if (!keys.some((key) => Array.isArray(parsed[key]))) {
      throw new Error("规则文件没有可识别的规则数组");
    }
    const importedRules = Object.fromEntries(keys.filter((key) => Array.isArray(parsed[key])).map((key) => [key, parsed[key]]));
    validateRuleValues(importedRules);
    const next = normalizeSettings({ ...state.settings, ...importedRules });
    writeRuleEditors(next);
    await save(next);
    setStatusMessage(maintenanceStatus, "筛选规则已导入并保存。", "success");
  }

  renderFieldDefinitions();
  addRangeLimits();
  renderStructuredEditors();
  document.querySelectorAll("[data-add-rule]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.addRule;
      const list = document.querySelector(`[data-rule-list="${kind}"]`);
      list.querySelector(".rule-empty")?.remove();
      list.append(createRuleRow(kind));
      list.lastElementChild?.querySelector("input")?.focus();
    });
  });
  settingsSearch.addEventListener("input", filterSettings);
  settingsSearchClear.addEventListener("click", () => {
    settingsSearch.value = "";
    filterSettings();
    settingsSearch.focus();
  });
  document.querySelectorAll("[data-setting-key]").forEach((input) => input.addEventListener("change", updateDependencies));

  document.querySelector("#export-settings").addEventListener("click", () => {
    const size = downloadJson(`betterld-settings-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}.json`, {
      schema: "betterld.settings",
      settingsVersion: state.settings.settingsVersion,
      exportedAt: new Date().toISOString(),
      ...state.settings
    });
    setStatusMessage(maintenanceStatus, `设置已导出（${size} 字节，${Object.keys(state.settings).length} 个字段）。`, "success");
  });
  document.querySelector("#import-settings").addEventListener("click", () => settingsImportFile.click());
  settingsImportFile.addEventListener("change", async () => {
    const file = settingsImportFile.files?.[0];
    settingsImportFile.value = "";
    if (!file) {
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
    try {
      await importRulesFile(file);
    } catch (error) {
      setStatusMessage(maintenanceStatus, `规则导入失败，当前规则未改变。 ${error instanceof Error ? error.message : "文件格式无效"}`, "error");
    }
  });
  document.querySelector("#about-version").textContent = `版本 ${api.runtime?.getManifest?.().version || "0.1.0"} · Manifest V3`;

  wallpaperSources.replaceChildren(...sourceOptions.map(createSourceOption));
  renderWallpaperCatalog();
  setRangeAttributes(maskOpacity, config.settingsLimits.maskOpacity);
  setRangeAttributes(blur, config.settingsLimits.blurPx);
  setRangeAttributes(cardOpacity, config.settingsLimits.cardOpacity);
  maskOpacity.addEventListener("input", updateOutputs);
  blur.addEventListener("input", updateOutputs);
  cardOpacity.addEventListener("input", updateOutputs);
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
      setStatusMessage(wallpaperStatus, "图片已准备，保存设置后生效", "success");
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
    setStatusMessage(wallpaperStatus, "本地图片将在保存后移除");
  });

  clearSearchHistory.addEventListener("click", async () => {
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatusMessage(status, "");
    if (selectedMode() !== modes.url) {
      setStatusMessage(wallpaperStatus, "");
    }
    try {
      await save(readForm());
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setStatusMessage(status, `设置保存失败，已保留当前输入。${detail}`, "error");
      console.error("[betterLD] settings save failed", error);
    }
  });

  reset.addEventListener("click", async () => {
    state.removeLocalWallpaper = false;
    populate(config.settingsDefaults);
    setStatusMessage(status, "");
    setStatusMessage(wallpaperStatus, "");
    try {
      await save(normalizeSettings(config.settingsDefaults));
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setStatusMessage(status, `默认设置保存失败，已保留当前输入。${detail}`, "error");
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
