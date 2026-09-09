(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);
  const modes = config?.wallpaperModes;
  const catalog = config?.wallpaperCatalog || [];

  if (!config || !api || !modes) {
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
    removeLocalWallpaper: false
  };

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

  function clamp(value, limits) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(limits.max, Math.max(limits.min, number)) : limits.min;
  }

  function validMode(value) {
    return Object.values(modes).includes(value) ? value : null;
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

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const legacyWallpaper = String(source.wallpaper || "").trim();
    const configuredMode = validMode(source.wallpaperMode);
    let wallpaperMode = configuredMode || (legacyWallpaper ? modes.url : config.settingsDefaults.wallpaperMode);
    let wallpaperId = String(source.wallpaperId || "").trim();
    const wallpaperUrl = storedWallpaperUrl(source.wallpaperUrl || (wallpaperMode === modes.url ? legacyWallpaper : ""));

    if (wallpaperMode === modes.random) {
      wallpaperId = randomWallpaper()?.id || "";
    } else if (wallpaperMode === modes.builtin && !catalogItem(wallpaperId, modes.builtin)) {
      wallpaperMode = modes.none;
      wallpaperId = "";
    } else if (wallpaperMode !== modes.builtin) {
      wallpaperId = wallpaperMode === modes.random ? wallpaperId : "";
    }

    return {
      wallpaper: legacyWallpaper,
      wallpaperMode,
      wallpaperId,
      wallpaperUrl,
      wallpaperLocalId: String(source.wallpaperLocalId || "").trim(),
      wallpaperRandomDate: String(source.wallpaperRandomDate || "").trim(),
      wallpaperRandomUrl: storedWallpaperUrl(source.wallpaperRandomUrl),
      maskOpacity: clamp(source.maskOpacity ?? config.settingsDefaults.maskOpacity, config.settingsLimits.maskOpacity),
      blurPx: clamp(source.blurPx ?? config.settingsDefaults.blurPx, config.settingsLimits.blurPx),
      cardOpacity: clamp(source.cardOpacity ?? config.settingsDefaults.cardOpacity, config.settingsLimits.cardOpacity)
    };
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
      input?.toggleAttribute("checked", selected);
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
      return;
    }
    wallpaperLocalImage.src = localWallpaper.dataUrl;
    wallpaperLocalName.textContent = localWallpaper.name || "本地图片";
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
  }

  function createSourceOption(option) {
    const label = document.createElement("label");
    label.className = "wallpaper-source";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "wallpaperMode";
    input.value = option.mode;
    input.addEventListener("change", () => setWallpaperMode(option.mode));

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
    state.selectedWallpaperId = settings.wallpaperId;
    wallpaper.value = settings.wallpaperUrl || (settings.wallpaperMode === modes.url ? settings.wallpaper : "");
    maskOpacity.value = String(settings.maskOpacity);
    blur.value = String(settings.blurPx);
    cardOpacity.value = String(settings.cardOpacity);
    const mode = settings.wallpaperMode === modes.builtin && !catalogItem(settings.wallpaperId, modes.builtin)
      ? modes.none
      : settings.wallpaperMode;
    renderWallpaperCatalog();
    setWallpaperMode(mode);
    updateOutputs();
  }

  function readForm() {
    const mode = selectedMode();
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

  async function save(value) {
    const values = { [config.storageKey]: value };
    if (state.localWallpaper) {
      values[config.wallpaperLocalStorageKey] = state.localWallpaper;
    }
    await storageSet(values);
    if (state.removeLocalWallpaper) {
      await storageRemove(config.wallpaperLocalStorageKey);
      state.removeLocalWallpaper = false;
    }
    state.settings = value;
    status.textContent = "设置已保存";
  }

  wallpaperSources.replaceChildren(...sourceOptions.map(createSourceOption));
  renderWallpaperCatalog();
  setRangeAttributes(maskOpacity, config.settingsLimits.maskOpacity);
  setRangeAttributes(blur, config.settingsLimits.blurPx);
  setRangeAttributes(cardOpacity, config.settingsLimits.cardOpacity);
  maskOpacity.addEventListener("input", updateOutputs);
  blur.addEventListener("input", updateOutputs);
  cardOpacity.addEventListener("input", updateOutputs);
  wallpaperFile.addEventListener("change", async () => {
    const file = wallpaperFile.files?.[0];
    if (!file) {
      return;
    }
    wallpaperStatus.textContent = "正在处理图片…";
    try {
      state.localWallpaper = await prepareLocalWallpaper(file);
      state.removeLocalWallpaper = false;
      setWallpaperMode(modes.local);
      wallpaperStatus.textContent = "图片已准备，保存设置后生效";
    } catch (error) {
      wallpaperStatus.textContent = error instanceof Error ? error.message : "本地图片处理失败";
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
    wallpaperStatus.textContent = "本地图片将在保存后移除";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    wallpaperStatus.textContent = "";
    try {
      await save(readForm());
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "设置保存失败";
      console.error("[betterLD] settings save failed", error);
    }
  });

  reset.addEventListener("click", async () => {
    populate(config.settingsDefaults);
    status.textContent = "";
    wallpaperStatus.textContent = "";
    try {
      await save(normalizeSettings(config.settingsDefaults));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "默认设置保存失败";
      console.error("[betterLD] default settings save failed", error);
    }
  });

  storageGet([config.storageKey, config.wallpaperLocalStorageKey])
    .then((stored) => {
      state.localWallpaper = isStoredLocalWallpaper(stored[config.wallpaperLocalStorageKey])
        ? stored[config.wallpaperLocalStorageKey]
        : null;
      populate(stored[config.storageKey]);
    })
    .catch((error) => {
      state.localWallpaper = null;
      populate(config.settingsDefaults);
      status.textContent = "读取设置失败，当前显示默认值";
      console.error("[betterLD] settings load failed", error);
    });
})();
