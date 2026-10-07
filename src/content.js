(() => {
  "use strict";

  if (window !== window.top) {
    return;
  }

  const config = globalThis.BETTERLD_CONFIG;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);
  const normalizeSettings = settingsApi?.normalizeSettings;
  const markdownApi = globalThis.BETTERLD_MARKDOWN;

  // 站点自己的前端请求带这两个指纹头；只带 Accept 时 Cloudflare 会对 *.json 返回 403 质询
  const discourseAjaxHeaders = Object.freeze({
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Discourse-Present": "true"
  });

  // 操作栏布局按钮的循环顺序与提示文案；取值本身以 config.settingsEnums.topicListLayoutMode 为准
  const topicListLayoutLabels = Object.freeze({
    reading: "阅读卡",
    native: "原生主题列表"
  });

  if (!config || !settingsApi || typeof normalizeSettings !== "function" || typeof markdownApi?.render !== "function" || !api?.storage?.local) {
    console.error("[betterLD] content script could not initialize: extension API is unavailable");
    return;
  }

  if (globalThis.__betterldContentScriptActive) {
    return;
  }
  globalThis.__betterldContentScriptActive = true;

  const state = {
    currentHref: "",
    currentSettings: config.settingsDefaults,
    settingsResolved: false,
    activeStorageArea: "local",
    syncTimer: 0,
    mutating: false,
    wallpaperRequest: 0,
    wallpaperState: "default",
    wallpaperColorUrl: "",
    wallpaperColor: null,
    localWallpaper: null,
    remoteWallpaperCache: null,
    topicSortRedirect: "",
    excerptCache: new Map(),
    metadataQueue: [],
    metadataRunning: false,
    metadataStarts: [],
    responseRequests: new Map(),
    pageRefreshBridge: null,
    refreshPromise: null,
    refreshNextAt: 0,
    excerptStorageChain: Promise.resolve(),
    metadataNextAt: 0,
    excerptTokens: config.excerptRequestBurst,
    excerptTokensAt: 0,
    excerptRequestNextAt: 0,
    metadataCooldownUntil: 0,
    topicListMetadata: new Map(),
    preloadedTopicListSeeded: false,
    topicListSync: null,
    topicListSyncAgain: false,
    excerptObserver: null,
    excerptVisible: new Set(),
    excerptIdleTimer: 0,
    excerptPrefetchTimer: 0,
  excerptThrottleRetryTimer: 0,
    excerptLastScrollAt: 0,
    // 立发预算属于「一次列表重建 / 一次路由切换」，同一次里多次同步不再重复吃突发额度。
    excerptPrimeBudget: config.excerptPrimeCount,
    searchLoadMoreBusy: false,
    undoRefreshSnapshot: null,
    refreshScrollTopSince: 0,
    managedSources: new Map(),
    listControlsCollapsed: false,
    lastScrollY: 0,
    scrollDirection: 0,
    scrollDistance: 0,
    openMenu: null,
    drawerTrigger: null,
    // 抽屉触发卡的正文请求在 showModal() 之前就会进队列，标志位让这段窗口里也判定为「需要」。
    drawerRequestPending: false,
    drawerRequest: 0,
    topicDrawer: null,
    settingsDialog: null,
    settingsDialogTrigger: null,
    filterBin: new Set(),
    filterBinFrame: 0,
    filterBinHost: null,
    filterBinOpen: false,
    filterSignature: "",
    visitedTopics: new Set(),
    searchHistoryPanel: null,
    listRefreshAt: 0,
    toastTimer: 0,
    replyTree: null,
    replyTreeNativeTopicId: "",
    replyTreeSnapshot: null
  };

  function storageGet(keys = [config.storageKey, config.wallpaperLocalStorageKey, config.wallpaperRemoteCacheKey, config.topicRequestCooldownStorageKey]) {
    const storageKeys = keys;
    if (firefoxApi) {
      return api.storage.local.get(storageKeys);
    }

    return new Promise((resolve, reject) => {
      api.storage.local.get(storageKeys, (value) => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(value);
      });
    });
  }

  function syncGet(keys) {
    if (!api.storage?.sync?.get) {
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

  async function getActiveSettings(localSettings = state.currentSettings) {
    const normalizedLocal = normalizeSettings(localSettings);
    if (!normalizedLocal.syncEnabled) {
      state.activeStorageArea = "local";
      return normalizedLocal;
    }
    try {
      const stored = await syncGet([config.storageKey]);
      const remoteSettings = stored?.[config.storageKey];
      if (remoteSettings && typeof remoteSettings === "object") {
        state.activeStorageArea = "sync";
        return normalizeSettings(remoteSettings);
      }
    } catch (error) {
      console.error("[betterLD] active sync settings read failed; using local settings", error);
    }
    state.activeStorageArea = "local";
    return normalizedLocal;
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

  function catalogItem(id, mode) {
    return config.wallpaperCatalog.find((item) => item.id === id && (!mode || item.mode === mode)) || null;
  }

  function randomWallpaper() {
    return config.wallpaperCatalog.find((item) => item.mode === config.wallpaperModes.random) || null;
  }

  function safeWallpaperUrl(value, allowData = false) {
    const input = String(value || "").trim();
    if (!input) {
      return "";
    }
    if (allowData && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(input)) {
      return input;
    }

    try {
      const url = new URL(input);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function setWallpaperState(root, stateName) {
    state.wallpaperState = stateName;
    root.setAttribute("data-betterld-wallpaper-state", stateName);
  }

  function localDateKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function dailyRandomUrl(date) {
    const random = randomWallpaper();
    const pattern = String(config.wallpaperRandomSeedPattern || "").replace("{date}", encodeURIComponent(date));
    return safeWallpaperUrl(pattern || random?.url);
  }

  function isStoredLocalWallpaper(value) {
    return Boolean(value && typeof value === "object" && typeof value.dataUrl === "string" && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value.dataUrl));
  }

  function isSearchPage() {
    return currentPath() === "/search";
  }

  function canCacheRemoteWallpaper(settings, url) {
    return Number(settings.wallpaperRemoteCacheDays) > 0 && /^https:/i.test(url);
  }

  function remoteWallpaperCacheIsFresh(settings, url) {
    const cache = state.remoteWallpaperCache;
    const days = Number(settings.wallpaperRemoteCacheDays);
    return canCacheRemoteWallpaper(settings, url)
      && cache?.url === url
      && cache.ok === true
      && Number.isFinite(Number(cache.checkedAt))
      && Date.now() - Number(cache.checkedAt) >= 0
      && Date.now() - Number(cache.checkedAt) <= days * 86400000;
  }

  function recordRemoteWallpaperCache(settings, url, ok) {
    if (!canCacheRemoteWallpaper(settings, url)) {
      return;
    }
    const cache = { url, checkedAt: Date.now(), ok: Boolean(ok) };
    state.remoteWallpaperCache = cache;
    storageSet({ [config.wallpaperRemoteCacheKey]: cache }).catch((error) => {
      console.error("[betterLD] remote wallpaper cache save failed", error);
    });
  }

  function resolveWallpaper(settings) {
    const modes = config.wallpaperModes;
    if (isSearchPage() && settings.searchPageWallpaperMode !== "inherit") {
      if (settings.searchPageWallpaperMode === "builtin") {
        return safeWallpaperUrl(catalogItem(settings.searchPageWallpaperId, modes.builtin)?.url);
      }
      if (settings.searchPageWallpaperMode === "url") {
        return safeWallpaperUrl(settings.searchPageWallpaperUrl);
      }
      return "";
    }
    if (settings.wallpaperMode === modes.random) {
      const date = localDateKey();
      const cached = safeWallpaperUrl(settings.wallpaperRandomUrl);
      if (settings.wallpaperRandomDate === date && cached) {
        return cached;
      }

      const url = dailyRandomUrl(date);
      if (url && (settings.wallpaperRandomDate !== date || settings.wallpaperRandomUrl !== url)) {
        const updated = { ...settings, wallpaperRandomDate: date, wallpaperRandomUrl: url };
        state.currentSettings = updated;
        storageSet({ [config.storageKey]: updated }).catch((error) => {
          console.error("[betterLD] daily wallpaper state save failed", error);
        });
      }
      return url;
    }
    if (settings.wallpaperMode === modes.builtin) {
      return safeWallpaperUrl(catalogItem(settings.wallpaperId, modes.builtin)?.url);
    }
    if (settings.wallpaperMode === modes.url) {
      return safeWallpaperUrl(settings.wallpaperUrl || settings.wallpaper);
    }
    if (settings.wallpaperMode === modes.local) {
      const localWallpaper = state.localWallpaper;
      if (!isStoredLocalWallpaper(localWallpaper)) {
        return "";
      }
      if (settings.wallpaperLocalId && settings.wallpaperLocalId !== localWallpaper.id) {
        return "";
      }
      return safeWallpaperUrl(localWallpaper.dataUrl, true);
    }
    return "";
  }

  function applyCustomCss(settings) {
    const existing = document.querySelector("style[data-betterld-custom-css]");
    if (!settings.customCssEnabled || !settings.customCss) {
      existing?.remove();
      return;
    }
    const validation = settingsApi.validateCustomCss(settings.customCss);
    if (!validation.valid) {
      existing?.remove();
      console.error("[betterLD] custom CSS rejected", validation.errors);
      return;
    }
    const style = existing || document.createElement("style");
    style.dataset.betterldCustomCss = "true";
    style.textContent = validation.css;
    if (!existing) {
      document.head?.append(style);
    }
  }

  function applyVisualSettings(value, options = {}) {
    const settings = normalizeSettings(value);
    const root = document.documentElement;
    const wallpaperRequest = ++state.wallpaperRequest;

    const previousReplyTreeNameMode = state.currentSettings.replyTreeNameMode;
    state.currentSettings = settings;
    if (state.replyTree?.posts.size && previousReplyTreeNameMode !== settings.replyTreeNameMode) {
      renderReplyTree(state.replyTree);
    }
    const wallpaperUrl = resolveWallpaper(settings);
    if (wallpaperUrl !== state.wallpaperColorUrl) {
      state.wallpaperColorUrl = wallpaperUrl;
      state.wallpaperColor = null;
    }
    const materialSupported = Boolean(
      globalThis.CSS?.supports?.("backdrop-filter", "blur(1px)")
      || globalThis.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)")
    );
    root.dataset.betterldMaterial = materialSupported ? "ready" : "fallback";
    root.dataset.betterldTopicListLayout = settings.topicListLayoutMode;
    root.dataset.betterldGridMode = settings.gridMode;
    root.dataset.betterldShadowMode = settings.shadowMode;
    root.dataset.betterldFrostedGlass = String(settings.frostedGlassEnabled);
    root.dataset.betterldShowTopicAvatar = String(settings.showTopicAvatar);
    root.dataset.betterldShowTopicAuthor = String(settings.showTopicAuthor);
    root.dataset.betterldShowTopicCategory = String(settings.showTopicCategory);
    root.dataset.betterldShowTopicExcerpt = String(settings.showTopicExcerpt);
    root.dataset.betterldShowTopicTags = String(settings.showTopicTags);
    root.dataset.betterldShowTopicMeta = String(settings.showTopicMeta);
    root.dataset.betterldShowTopicActivityTime = String(settings.showTopicActivityTime);
    root.dataset.betterldShowTopicReplies = String(settings.showTopicReplies);
    root.dataset.betterldShowTopicLikes = String(settings.showTopicLikes);
    root.dataset.betterldShowTopicViews = String(settings.showTopicViews);
    root.dataset.betterldShowTopicUnreadState = String(settings.showTopicUnreadState);
    root.dataset.betterldShowTopicPinnedState = String(settings.showTopicPinnedState);
    root.dataset.betterldShowTopicWatchedState = String(settings.showTopicWatchedState);
    root.dataset.betterldTopicTitleSize = settings.topicTitleFontSize;
    root.dataset.betterldTopicAuthorSize = settings.topicAuthorFontSize;
    root.dataset.betterldTopicMetaSize = settings.topicMetaFontSize;
    root.dataset.betterldFontScope = settings.fontScope;
    root.dataset.betterldRemovePunctuationIndent = String(settings.removeChinesePunctuationIndent);
    const fontFamily = settings.fontMode === "recommended"
      ? config.fontRecommendedStack
      : settings.fontMode === "custom"
        ? settings.fontFamily
        : "";
    if (fontFamily) {
      root.style.setProperty("--betterld-font-family", fontFamily);
    } else {
      root.style.removeProperty("--betterld-font-family");
    }
    root.style.setProperty("--betterld-mask-opacity", String(settings.maskOpacity));
    root.style.setProperty("--betterld-background-blur", `${settings.blurPx}px`);
    root.style.setProperty("--betterld-card-opacity", String(settings.cardOpacity));
    root.style.setProperty("--betterld-card-motion", `${config.topicCardMotion.durationMs}ms ${config.topicCardMotion.easing}`);
    root.style.setProperty("--betterld-card-hover-spread", `${config.topicCardMotion.spreadPx}px`);
    root.style.setProperty("--betterld-card-hover-opacity", String(config.topicCardMotion.hoverOpacity));
    root.style.setProperty("--betterld-card-active-opacity", String(config.topicCardMotion.activeOpacity));
    root.style.setProperty("--betterld-card-min-size", `${settings.cardMinSize}px`);
    root.style.setProperty("--betterld-card-unit-ratio", String(config.cardScale.ratioPerWidth));
    root.style.setProperty("--betterld-card-unit-max", `${config.cardScale.maxPx}px`);
    root.style.setProperty("--betterld-reading-narrow-height", `${config.cardScale.narrowHeightPx}px`);
    root.style.setProperty("--betterld-reading-narrow-unit", `${config.cardScale.narrowUnitPx}px`);
    root.style.setProperty("--betterld-card-side-gutter", `${settings.cardSideGutter}px`);
    root.style.setProperty("--betterld-grid-gap", `${settings.gridGap}px`);
    root.style.setProperty("--betterld-topic-grid-max-width", `${config.topicGridMaxWidthPx}px`);
    root.style.setProperty("--betterld-surface-blur", settings.frostedGlassEnabled ? `${settings.surfaceBlurPx}px` : "0px");
    root.style.setProperty("--betterld-reply-quote-collapse-height", `${config.replyTreeQuoteCollapseHeightPx}px`);
    root.style.setProperty("--betterld-user-card-cover-mask-opacity", settings.userCardCoverMaskEnabled ? String(settings.userCardCoverMaskOpacity) : "0");
    root.style.setProperty("--betterld-shadow-level-2", `0 ${2 * settings.shadowHeight}px 6px rgb(var(--betterld-shadow-color) / 0.10), 0 ${12 * settings.shadowHeight}px 28px rgb(var(--betterld-shadow-color) / 0.16)`);
    root.style.setProperty("--betterld-shadow-level-2-hover", `0 ${4 * settings.shadowHeight}px 10px rgb(var(--betterld-shadow-color) / 0.12), 0 ${18 * settings.shadowHeight}px 36px rgb(var(--betterld-shadow-color) / 0.20)`);
    Object.entries(settings.gridColumns || {}).forEach(([key, value]) => {
      root.style.setProperty(`--betterld-grid-columns-${key}`, String(value));
    });
    if (settings.shadowMode === "custom") {
      const curve = settings.shadowCurve || [];
      const blurSizes = [12, 28, 56];
      const offsets = [4, 12, 28].map((offset) => offset * settings.shadowHeight);
      const shadow = curve.map((point, index) => `0 ${offsets[index]}px ${blurSizes[index]}px rgb(var(--betterld-shadow-color) / ${point.opacity})`).join(", ");
      root.style.setProperty("--betterld-card-shadow", shadow);
    } else {
      root.style.removeProperty("--betterld-card-shadow");
    }
    root.style.removeProperty("--betterld-wallpaper-image");
    if (!Number(settings.wallpaperRemoteCacheDays) && state.remoteWallpaperCache) {
      state.remoteWallpaperCache = null;
      storageRemove(config.wallpaperRemoteCacheKey).catch((error) => {
        console.error("[betterLD] remote wallpaper cache removal failed", error);
      });
    }
    applyColorMode();
    applyCustomCss(settings);
    resetFilterOverrides(settings);
    syncManagedCardContent();
    syncCardMenus();
    syncFloatingActions();
    syncNavigationSettings();
    syncConfiguredLinkModes();
    applyChromeSettings();
    applySearchSettings();

    if (!wallpaperUrl) {
      const hasWallpaperCandidate = settings.wallpaperMode !== config.wallpaperModes.none;
      setWallpaperState(root, options.forceFallback || hasWallpaperCandidate ? "fallback" : "default");
      return;
    }

    if (remoteWallpaperCacheIsFresh(settings, wallpaperUrl)) {
      root.style.setProperty("--betterld-wallpaper-image", `url(${JSON.stringify(wallpaperUrl)})`);
      setWallpaperState(root, "ready");
      updateWallpaperColor(wallpaperUrl, wallpaperRequest);
      return;
    }

    setWallpaperState(root, "loading");

    const image = new Image();
    image.decoding = "async";
    const fallback = () => {
      if (wallpaperRequest !== state.wallpaperRequest) {
        return;
      }
      root.style.removeProperty("--betterld-wallpaper-image");
      recordRemoteWallpaperCache(settings, wallpaperUrl, false);
      setWallpaperState(root, "fallback");
      state.wallpaperColor = null;
      applyThemeTokens(settings);
      console.warn("[betterLD] wallpaper could not be decoded; using the safe gradient", wallpaperUrl);
    };
    const ready = () => {
      if (wallpaperRequest !== state.wallpaperRequest) {
        return;
      }
      root.style.setProperty("--betterld-wallpaper-image", `url(${JSON.stringify(wallpaperUrl)})`);
      recordRemoteWallpaperCache(settings, wallpaperUrl, true);
      setWallpaperState(root, "ready");
      updateWallpaperColor(wallpaperUrl, wallpaperRequest);
    };
    image.onload = () => {
      if (typeof image.decode !== "function") {
        ready();
        return;
      }
      try {
        Promise.resolve(image.decode()).then(ready).catch(fallback);
      } catch {
        fallback();
      }
    };
    image.onerror = fallback;
    image.src = wallpaperUrl;
  }

  async function updateWallpaperColor(url, request) {
    if (!state.currentSettings.wallpaperThemeColor) return;
    if (state.wallpaperColor) {
      applyThemeTokens(state.currentSettings);
      return;
    }
    let objectUrl;
    try {
      // Firefox 内容脚本直接解码跨域图片会报 Invalid image request；改用同源 Blob 解码。
      const image = new Image();
      if (firefoxApi && !url.startsWith("data:")) {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) throw new Error(`壁纸取色请求失败：${response.status}`);
        objectUrl = URL.createObjectURL(await response.blob());
        image.src = objectUrl;
      } else {
        image.crossOrigin = "anonymous";
        image.src = url;
      }
      await image.decode();
      if (request !== state.wallpaperRequest) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = config.wallpaperColorSampleSize;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const buckets = new Map();
      for (let i = 0; i < pixels.length; i += 4) {
        if (!pixels[i + 3]) continue;
        const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
        const key = rgb.map((channel) => channel >> 5).join(",");
        const bucket = buckets.get(key) || { weight: 0, sum: [0, 0, 0] };
        const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
        const lightness = (Math.max(...rgb) + Math.min(...rgb)) / (2 * 255);
        // 阴影和白云不应压过壁纸中有辨识度的颜色；灰度图片仍保留权重。
        const weight = (pixels[i + 3] / 255) * (1 / 255 + chroma) * (1 / 255 + lightness * (1 - lightness));
        bucket.weight += weight;
        rgb.forEach((channel, index) => { bucket.sum[index] += channel * weight; });
        buckets.set(key, bucket);
      }
      const dominant = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
      if (!dominant) throw new Error("壁纸没有可读取的非透明像素");
      state.wallpaperColor = dominant.sum.map((channel) => Math.round(channel / dominant.weight));
      applyThemeTokens(state.currentSettings);
    } catch (error) {
      if (request !== state.wallpaperRequest) return;
      document.documentElement.dataset.betterldWallpaperColor = "unavailable";
      console.warn("[betterLD] 壁纸取色失败，保留手动主题色", error);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  function relativeLuminance(rgb) {
    const linear = rgb.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function wallpaperPrimary() {
    const dark = document.documentElement.dataset.betterldMode === "dark";
    const background = dark ? hexToRgb(state.currentSettings.darkModeBaseColor).split(" ").map(Number) : [255, 255, 255];
    const base = relativeLuminance(background);
    const rgb = [...state.wallpaperColor];
    const target = dark ? 255 : 0;
    // 逐步调整亮度，保留壁纸色相并保证强调文本的对比度。
    while (true) {
      const luminance = relativeLuminance(rgb);
      if ((Math.max(base, luminance) + 0.05) / (Math.min(base, luminance) + 0.05) >= 4.5 || rgb.every((channel) => channel === target)) break;
      rgb.forEach((channel, index) => { rgb[index] = channel + Math.sign(target - channel); });
    }
    return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  function themeFromValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return "";
    }
    if (/(?:^|[-_\s])dark(?:$|[-_\s])/.test(normalized) || /(?:^|[-_\s])dark-mode(?:$|[-_\s])/.test(normalized)) {
      return "dark";
    }
    if (/(?:^|[-_\s])light(?:$|[-_\s])/.test(normalized) || /(?:^|[-_\s])light-mode(?:$|[-_\s])/.test(normalized)) {
      return "light";
    }
    return "";
  }

  function computedThemeValue(element) {
    const scheme = element ? getComputedStyle(element).colorScheme.trim().toLowerCase() : "";
    return scheme === "dark" || scheme === "light" ? scheme : "";
  }

  function hexToRgb(value) {
    const color = String(value || "").trim().replace("#", "");
    if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) {
      return "";
    }
    const expanded = color.length === 3 ? color.split("").map((part) => part + part).join("") : color;
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)).join(" ");
  }

  function contrastColor(value) {
    const rgb = hexToRgb(value).split(" ").map(Number);
    if (rgb.length !== 3 || rgb.some((part) => !Number.isFinite(part))) {
      return "#ffffff";
    }
    return relativeLuminance(rgb) > 0.179 ? "#000000" : "#ffffff";
  }

  function scheduledMode(settings) {
    const start = String(settings.themeScheduleStart || "18:00").split(":").map(Number);
    const end = String(settings.themeScheduleEnd || "07:00").split(":").map(Number);
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = start[0] * 60 + start[1];
    const endMinutes = end[0] * 60 + end[1];
    const inRange = startMinutes <= endMinutes
      ? minutes >= startMinutes && minutes <= endMinutes
      : minutes >= startMinutes || minutes <= endMinutes;
    return inRange ? "dark" : "light";
  }

  function applyThemeTokens(settings) {
    const root = document.documentElement;
    const fromWallpaper = settings.wallpaperThemeColor && state.wallpaperColor;
    const primary = fromWallpaper ? wallpaperPrimary() : settings.themeColor;
    root.dataset.betterldWallpaperColor = fromWallpaper ? "ready" : "manual";
    const background = settings.darkModeBaseColor;
    const primaryRgb = hexToRgb(primary);
    const backgroundRgb = hexToRgb(background);
    if (primaryRgb) {
      root.style.setProperty("--betterld-primary", primary);
      root.style.setProperty("--betterld-primary-rgb", primaryRgb.split(" ").join(", "));
      root.style.setProperty("--betterld-on-primary", contrastColor(primary));
    }
    if (root.dataset.betterldMode === "dark" && backgroundRgb) {
      root.style.setProperty("--betterld-background-rgb", backgroundRgb);
    } else {
      root.style.removeProperty("--betterld-background-rgb");
    }
    if (settings.useGradientThemeColorBackground && primary) {
      root.style.setProperty("--betterld-default-wallpaper", `radial-gradient(circle at 18% 12%, color-mix(in srgb, ${primary} 42%, transparent), transparent 34%), radial-gradient(circle at 86% 84%, color-mix(in srgb, ${primary} 30%, transparent), transparent 38%), linear-gradient(135deg, color-mix(in srgb, ${primary} 26%, rgb(var(--betterld-background-rgb))), rgb(var(--betterld-background-rgb)))`);
    } else {
      root.style.removeProperty("--betterld-default-wallpaper");
    }
  }

  function applyColorMode() {
    const root = document.documentElement;
    const body = document.body;
    const explicitValues = [
      root.dataset.colorScheme,
      body?.dataset.colorScheme,
      root.dataset.theme,
      body?.dataset.theme,
      root.dataset.themeName,
      body?.dataset.themeName,
      root.className,
      body?.className
    ];
    const explicitMode = explicitValues.map(themeFromValue).find(Boolean) || "";
    const computedMode = [computedThemeValue(root), computedThemeValue(body)]
      .map(themeFromValue)
      .find(Boolean) || "";
    const prefersDark = Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    const configuredMode = state.currentSettings?.themeMode || "auto";
    const detectedMode = explicitMode || computedMode || (prefersDark ? "dark" : "light");
    const mode = configuredMode === "light" || configuredMode === "dark"
      ? configuredMode
      : configuredMode === "system"
        ? (prefersDark ? "dark" : "light")
        : configuredMode === "scheduled"
          ? scheduledMode(state.currentSettings)
          : detectedMode;
    root.dataset.betterldMode = mode;
    applyThemeTokens(state.currentSettings);
  }

  function currentPath() {
    return location.pathname.replace(/\/+$/, "") || "/";
  }

  function isHomepage() {
    return currentPath() === config.homepagePath;
  }

  function userTopicsUsername() {
    return currentPath().match(/^\/u\/([^/]+)\/activity\/topics$/)?.[1] || "";
  }

  function isTopicListPage() {
    const path = currentPath();
    return isHomepage()
      || Boolean(userTopicsUsername())
      || /^\/(?:latest|new|unread|unseen|hot|top|read|posted|bookmarks)(?:\/|$)/.test(path)
      || /^\/my\/[^/]+(?:\/|$)/.test(path)
      || /^\/l\/(?:latest|new|unread|unseen|hot|top|read)(?:\/|$)/.test(path)
      || /^\/c\/(?:[^/]+\/)+\d+(?:\/l\/(?:latest|new|unread|unseen|hot|top|read))?$/.test(path)
      || /^\/tag\/[^/]+(?:\/\d+)?(?:\/l\/(?:latest|new|unread|unseen|hot|top|read))?$/.test(path);
  }

  function isCategoriesPage() {
    return currentPath() === "/categories";
  }

  // 热门与最高有各自的排序语义，不接管
  function hasOwnTopicRanking() {
    const path = currentPath();
    return /^\/(?:hot|top)(?:\/|$)/.test(path) || /^\/l\/(?:hot|top)(?:\/|$)/.test(path);
  }

  // 个人空间的话题列表不在 betterLD 管理的页面集合里，排序靠 Discourse 的 order 参数生效
  function isUserSpaceTopicListPage() {
    return /^\/u\/[^/]+\/activity\/topics$/.test(currentPath());
  }

  function isSortableTopicListPage() {
    return isUserSpaceTopicListPage() || (isTopicListPage() && !hasOwnTopicRanking());
  }

  function topicIdFromPath() {
    const match = location.pathname.match(/^\/t\/(?:(\d+)|[^/]+\/(\d+))(?:\/|$)/);
    return match?.[1] || match?.[2] || "";
  }

  // 已看记录只写本机存储，用于卡片上的「已看」标记，不碰服务端的已读状态
  function recordVisitedTopic() {
    const id = topicIdFromPath();
    if (!id || state.visitedTopics.has(id)) {
      return;
    }
    state.visitedTopics.add(id);
    const ids = [...state.visitedTopics].slice(-config.visitedTopicMaxEntries);
    state.visitedTopics = new Set(ids);
    storageSet({ [config.visitedTopicStorageKey]: ids }).catch((error) => {
      console.error("[betterLD] visited topic save failed", error);
    });
  }

  // 只由 checkRoute 的轮询调用：启动时会先拿默认设置跑一遍，那时不能动 URL
  function applyTopicSort() {
    const path = currentPath();
    if (!state.settingsResolved || !isSortableTopicListPage() || state.topicSortRedirect === path || state.settingsDialog?.dialog?.open) {
      return;
    }
    const orderParam = config.topicSortOrderParam;
    const orderValue = config.topicSortOrders[state.currentSettings.topicSortMode] || "";
    const managedValues = Object.values(config.topicSortOrders).filter(Boolean);
    const url = new URL(location.href);
    const currentValue = url.searchParams.get(orderParam);
    if (orderValue) {
      if (currentValue) {
        return;
      }
      url.searchParams.set(orderParam, orderValue);
    } else {
      if (!managedValues.includes(currentValue)) {
        return;
      }
      url.searchParams.delete(orderParam);
    }
    state.topicSortRedirect = path;
    location.replace(url.href);
  }

  function isTagsPage() {
    return currentPath() === "/tags";
  }

  // 首页也是主题列表（/ 上是未读列表），导航底板同样要随滚动收起，因此把 betterld-home 一并纳入
  const listControlsSelector = "body:is(.betterld-home, .betterld-topic-page, .betterld-categories-page) #main-outlet-wrapper #main-outlet > .list-controls.list-controls";

  function pageScrollTop() {
    return Math.max(
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body?.scrollTop || 0
    );
  }

  function applyListControlsScrollState() {
    const controls = new Set(document.querySelectorAll(listControlsSelector));
    document.querySelectorAll("[data-betterld-scroll-state]").forEach((control) => {
      if (controls.has(control)) {
        return;
      }
      delete control.dataset.betterldScrollState;
      if (control.inert) {
        control.inert = false;
      }
    });
    controls.forEach((control) => {
      const hidden = state.listControlsCollapsed;
      const scrollState = hidden ? "hidden" : "visible";
      if (control.dataset.betterldScrollState !== scrollState) {
        control.dataset.betterldScrollState = scrollState;
      }
      if (control.inert !== hidden) {
        control.inert = hidden;
      }
    });
  }

  function updateListControlsScrollState() {
    const scrollTop = pageScrollTop();
    const delta = scrollTop - state.lastScrollY;
    if (!delta) {
      return;
    }

    state.lastScrollY = scrollTop;
    if (scrollTop <= config.scrollTopThreshold) {
      state.scrollDirection = 0;
      state.scrollDistance = 0;
      if (state.listControlsCollapsed) {
        state.listControlsCollapsed = false;
        applyListControlsScrollState();
      }
      syncChromeScrollState();
      return;
    }

    const direction = delta > 0 ? 1 : -1;
    if (direction !== state.scrollDirection) {
      state.scrollDirection = direction;
      state.scrollDistance = 0;
    }
    state.scrollDistance += Math.abs(delta);
    if (state.scrollDistance < config.listControlsScrollThreshold) {
      syncChromeScrollState();
      return;
    }

    state.scrollDistance = 0;
    const collapsed = direction > 0;
    if (collapsed === state.listControlsCollapsed) {
      syncChromeScrollState();
      return;
    }
    state.listControlsCollapsed = collapsed;
    applyListControlsScrollState();
    syncChromeScrollState();
  }

  function syncChromeScrollState() {
    const settings = state.currentSettings;
    const narrow = Boolean(globalThis.matchMedia?.("(max-width: 720px)")?.matches);
    const touchAllowed = document.documentElement.dataset.betterldTouchMode === "true";
    const autoHideAllowed = !narrow || touchAllowed;
    const hidden = state.listControlsCollapsed;
    const headerHidden = settings.headerVisible && settings.autoHideHeader && autoHideAllowed && hidden;
    const sidebarHidden = settings.autoHideSidebar && !narrow && hidden;
    document.documentElement.dataset.betterldHeaderState = headerHidden ? "hidden" : "visible";
    document.documentElement.dataset.betterldSidebarState = sidebarHidden ? "hidden" : "visible";
    document.documentElement.dataset.betterldScrollTop = pageScrollTop() <= config.scrollTopThreshold ? "true" : "false";
    const rail = document.querySelector("[data-betterld-action-rail]");
    if (rail) {
      rail.dataset.scrollState = hidden ? "hidden" : "visible";
    }
  }

  function applyChromeSettings() {
    const root = document.documentElement;
    const settings = state.currentSettings;
    const coarsePointer = Boolean(globalThis.matchMedia?.("(pointer: coarse)")?.matches);
    const touchMode = settings.touchOptimization === "on"
      || (settings.touchOptimization === "auto" && coarsePointer);
    root.dataset.betterldHeaderVisible = String(settings.headerVisible);
    root.dataset.betterldHeaderVisual = settings.headerVisualMode;
    root.dataset.betterldSidebarPosition = settings.sidebarPosition;
    root.dataset.betterldSidebarAutoHide = String(settings.autoHideSidebar);
    root.dataset.betterldSidebarCover = String(settings.sidebarCoverBlurEnabled);
    root.dataset.betterldNavigationSticky = String(settings.topicNavigationSticky);
    root.dataset.betterldNavigationScroll = String(settings.enableHorizontalNavigationScroll);
    root.dataset.betterldSiteLogoVisible = String(settings.siteLogoVisible);
    root.dataset.betterldSiteLogoOutline = String(settings.siteLogoOutline);
    root.dataset.betterldSiteLogoGlow = String(settings.siteLogoGlow);
    root.dataset.betterldTouchMode = String(touchMode);
    syncChromeScrollState();
    syncTouchHomeButton();
  }

  // 页面内改动设置的统一出口：规范化后立即写入存储，由 storage.onChanged 驱动运行时应用
  function persistSettings(patch, statusMessage = "") {
    state.currentSettings = normalizeSettings({ ...state.currentSettings, ...patch });
    if (statusMessage) {
      showActionStatus(statusMessage, "success");
    }
    return storageSet({ [config.storageKey]: state.currentSettings }).catch((error) => {
      console.error("[betterLD] settings save failed", error);
    });
  }

  function recordSearchTerm(value) {
    const maxLength = config.settingsLimits?.searchHistory?.maxLength || 200;
    const maxItems = config.settingsLimits?.searchHistory?.maxItems || 50;
    const term = cleanText(value).slice(0, maxLength);
    if (!term || !state.currentSettings.searchHistoryEnabled) {
      return;
    }
    const history = [term, ...(state.currentSettings.searchHistory || [])]
      .filter((item, index, values) => values.findIndex((candidate) => candidate.toLocaleLowerCase() === item.toLocaleLowerCase()) === index)
      .slice(0, maxItems);
    persistSettings({ searchHistory: history });
  }

  function searchInputs() {
    return [...document.querySelectorAll('form[action*="/search"] input[name="q"], input.search-query, input.search-term__input, input[name="q"]')]
      .filter((input) => input instanceof HTMLInputElement);
  }

  function recommendedSearchTerm(settings) {
    if (!settings.searchHistoryEnabled) {
      return "";
    }
    const history = Array.isArray(settings.searchHistory) ? settings.searchHistory : [];
    return cleanText(history[0]);
  }

  // 推荐词来自本机保存的搜索历史（不请求站点接口）；空白回车会直接搜索该推荐词
  function syncSearchRecommendation(settings) {
    const term = settings.searchRecommendationEnabled ? recommendedSearchTerm(settings) : "";
    searchInputs().forEach((input) => {
      if (!term) {
        if (input.dataset.betterldSearchRecommendation) {
          input.placeholder = input.dataset.betterldPlaceholder || "";
          delete input.dataset.betterldSearchRecommendation;
        }
        return;
      }
      if (input.dataset.betterldPlaceholder === undefined) {
        input.dataset.betterldPlaceholder = input.placeholder || "";
      }
      input.placeholder = term;
      input.dataset.betterldSearchRecommendation = term;
      if (input.dataset.betterldSearchRecommendationHandler) {
        return;
      }
      input.dataset.betterldSearchRecommendationHandler = "true";
      // 捕获阶段先补上推荐词，站点自己的回车处理随后就能搜到它
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || input.value.trim()) {
          return;
        }
        const current = input.dataset.betterldSearchRecommendation;
        if (current) {
          input.value = current;
        }
      }, { capture: true });
    });
  }

  // 搜索历史浮层：只在输入框聚焦时出现，点击回填并提交、单条删除、清空全部
  function searchHistoryEntries() {
    const settings = state.currentSettings;
    if (!settings.searchHistoryEnabled || !settings.searchHistoryPanelEnabled) {
      return [];
    }
    return (settings.searchHistory || []).slice(0, config.searchHistoryPanelMaxItems);
  }

  function closeSearchHistoryPanel() {
    state.searchHistoryPanel?.remove();
    state.searchHistoryPanel = null;
  }

  function renderSearchHistoryPanel(input) {
    const entries = searchHistoryEntries();
    if (!document.body || !entries.length) {
      closeSearchHistoryPanel();
      return;
    }
    const reused = state.searchHistoryPanel;
    const panel = reused || createElement("div", "betterld-search-history");
    if (!reused) {
      panel.dataset.betterldSearchHistory = "true";
      panel.setAttribute("role", "listbox");
      panel.setAttribute("aria-label", "搜索历史");
      // 面板内的点击不能让输入框失焦，否则 blur 处理器会把面板先关掉
      panel.addEventListener("mousedown", (event) => event.preventDefault());
    }
    const list = createElement("div", "betterld-search-history__list");
    entries.forEach((term) => {
      const row = createElement("div", "betterld-search-history__row");
      const use = createElement("button", "betterld-search-history__term", term);
      use.type = "button";
      use.setAttribute("role", "option");
      use.addEventListener("click", () => {
        input.value = term;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        closeSearchHistoryPanel();
        input.form?.requestSubmit?.();
      });
      const remove = createElement("button", "betterld-search-history__remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除搜索历史：${term}`);
      remove.addEventListener("click", () => {
        persistSettings({ searchHistory: (state.currentSettings.searchHistory || []).filter((item) => item !== term) });
        renderSearchHistoryPanel(input);
      });
      row.append(use, remove);
      list.append(row);
    });
    const clear = createElement("button", "betterld-search-history__clear", "清空历史");
    clear.type = "button";
    clear.addEventListener("click", () => {
      if (!globalThis.confirm("清空搜索历史会删除全部已保存的搜索词，是否继续？")) {
        return;
      }
      persistSettings({ searchHistory: [] });
      closeSearchHistoryPanel();
    });
    panel.replaceChildren(list, clear);
    if (!panel.isConnected) {
      document.body.append(panel);
    }
    state.searchHistoryPanel = panel;
    const rect = input.getBoundingClientRect();
    const width = Math.max(Math.round(rect.width), 240);
    const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    // 先定宽再量高，否则换行后的真实高度会算错，面板会溢出视口底部
    const height = panel.getBoundingClientRect().height;
    const below = rect.bottom + 6;
    panel.style.top = `${Math.round(below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6))}px`;
  }

  function syncSearchHistoryPanel(settings) {
    if (!settings.searchHistoryEnabled || !settings.searchHistoryPanelEnabled) {
      closeSearchHistoryPanel();
    }
    searchInputs().forEach((input) => {
      if (input.dataset.betterldSearchHistoryHandler) {
        return;
      }
      input.dataset.betterldSearchHistoryHandler = "true";
      input.addEventListener("focus", () => renderSearchHistoryPanel(input));
      input.addEventListener("blur", () => window.setTimeout(() => {
        if (!state.searchHistoryPanel?.contains(document.activeElement)) {
          closeSearchHistoryPanel();
        }
      }, 0));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeSearchHistoryPanel();
        }
      });
    });
  }

  function hideSearchSentinel(sentinel) {
    sentinel.style.setProperty("position", "absolute", "important");
    sentinel.style.setProperty("left", "-10000px", "important");
    sentinel.style.setProperty("top", "0", "important");
  }

  function showSearchSentinel(sentinel) {
    sentinel.style.removeProperty("position");
    sentinel.style.removeProperty("left");
    sentinel.style.removeProperty("top");
  }

  // 翻页模式：隐藏站点的自动加载触点，改用 betterLD 自己的「加载更多结果」按钮；
  // 点击时把触点恢复到视图内并补发一次 scroll，让站点自己的加载器接住这次请求。
  function searchResultsExhausted() {
    const text = document.querySelector(".loading-container")?.textContent.trim();
    return Boolean(text) && config.searchNoMoreLabels.some((label) => text.includes(label));
  }

  function searchLoadMoreButton() {
    return document.querySelector("[data-betterld-search-more]");
  }

  function syncSearchLoadMoreButton(button) {
    const exhausted = searchResultsExhausted();
    button.disabled = exhausted;
    button.textContent = exhausted ? "没有更多结果" : "加载更多结果";
  }

  function syncSearchLoadMore(settings, searchPage) {
    const existing = searchLoadMoreButton();
    const sentinel = document.querySelector(".load-more-sentinel");
    const manual = searchPage && settings.searchResultsPaginationMode === "pagination" && sentinel?.parentElement;
    if (!manual) {
      existing?.remove();
      if (sentinel?.style.position) {
        showSearchSentinel(sentinel);
      }
      return;
    }
    if (state.searchLoadMoreBusy) {
      return;
    }
    if (!sentinel.style.position) {
      hideSearchSentinel(sentinel);
    }
    if (existing?.isConnected) {
      syncSearchLoadMoreButton(existing);
      return;
    }
    const button = createElement("button", "betterld-search-more");
    button.type = "button";
    button.dataset.betterldSearchMore = "true";
    button.addEventListener("click", () => {
      const entries = sentinel.parentElement?.querySelector(".fps-result-entries");
      const before = entries ? entries.childElementCount : 0;
      button.disabled = true;
      state.searchLoadMoreBusy = true;
      showSearchSentinel(sentinel);
      sentinel.scrollIntoView({ block: "end", behavior: "auto" });
      // 站点的加载器挂在 scroll 上，补发一次让它在已经在底部时也能触发
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
      const observer = new MutationObserver(() => {
        if ((entries?.childElementCount || 0) > before) {
          finish();
        }
      });
      const timer = window.setTimeout(finish, config.searchLoadMoreTimeoutMs);
      function finish() {
        observer.disconnect();
        window.clearTimeout(timer);
        state.searchLoadMoreBusy = false;
        hideSearchSentinel(sentinel);
        syncSearchLoadMoreButton(button);
      }
      if (entries) {
        observer.observe(entries, { childList: true });
      }
    });
    syncSearchLoadMoreButton(button);
    sentinel.parentElement.append(button);
  }

  function applySearchSettings() {
    const root = document.documentElement;
    const settings = state.currentSettings;
    const searchPage = isSearchPage();
    root.dataset.betterldSearchPage = String(searchPage);
    root.dataset.betterldSearchMode = settings.searchMode;
    root.dataset.betterldSearchFocusDimming = String(settings.searchFocusDimming);
    root.dataset.betterldSearchFocusBlur = String(settings.searchFocusBlur);
    root.dataset.betterldSearchPagination = settings.searchResultsPaginationMode;
    syncSearchRecommendation(settings);
    syncSearchHistoryPanel(settings);
    syncSearchLoadMore(settings, searchPage);
    if (!searchPage) {
      delete root.dataset.betterldSearchFocused;
      return;
    }
    const inputs = searchInputs();
    inputs.forEach((input) => {
      if (input.dataset.betterldSearchHandler) {
        return;
      }
      input.dataset.betterldSearchHandler = "true";
      input.addEventListener("focus", () => {
        root.dataset.betterldSearchFocused = "true";
      });
      input.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (!inputs.some((candidate) => candidate === document.activeElement)) {
            delete root.dataset.betterldSearchFocused;
          }
        }, 0);
      });
      const form = input.form;
      if (form && !form.dataset.betterldSearchSubmitHandler) {
        form.dataset.betterldSearchSubmitHandler = "true";
        form.addEventListener("submit", () => recordSearchTerm(input.value));
      }
    });
  }

  function editableTarget(target) {
    return target?.matches?.("input, textarea, select, [contenteditable=true], [contenteditable=\"\"]") || target?.isContentEditable;
  }

  function shortcutMatches(event, value) {
    const parts = cleanText(value).split("+").map((part) => part.trim().toLocaleLowerCase()).filter(Boolean);
    if (!parts.length) {
      return false;
    }
    const key = parts[parts.length - 1];
    const has = (name) => parts.includes(name);
    const expectedKey = key === "space" ? " " : key;
    return event.key.toLocaleLowerCase() === expectedKey
      && event.ctrlKey === (has("ctrl") || has("control"))
      && event.metaKey === (has("cmd") || has("command") || has("meta"))
      && event.shiftKey === has("shift")
      && event.altKey === (has("alt") || has("option"));
  }

  function handleShortcut(event) {
    const settings = state.currentSettings;
    if (!settings.shortcutsEnabled || editableTarget(event.target) || event.repeat) {
      return;
    }
    const shortcuts = settings.shortcuts || {};
    const action = Object.keys(shortcuts).find((key) => shortcutMatches(event, shortcuts[key]));
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "refreshTopics") {
      refreshTopicsList();
    } else if (action === "openSettings") {
      openSettingsPage();
    } else if (action === "toggleListControls") {
      state.listControlsCollapsed = !state.listControlsCollapsed;
      applyListControlsScrollState();
      syncChromeScrollState();
      showActionStatus(state.listControlsCollapsed ? "列表控制栏已隐藏" : "列表控制栏已显示", "success");
    }
  }

  function mainRoot() {
    const candidates = [...document.querySelectorAll("#main-outlet, #main-container, #main-outlet-wrapper")];
    return candidates.find((root) => root.querySelector(".topic-list-item, .latest-topic-list-item")) || candidates[0] || null;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeColor(value) {
    const color = String(value || "").trim();
    if (!color || /[;{}"']/.test(color) || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)$/i.test(color)) {
      return "";
    }
    if (/^#[\da-f]{3,8}$/i.test(color)) {
      return color;
    }
    return globalThis.CSS?.supports?.("color", color) ? color : "";
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function settingsResourceUrl(file) {
    const getURL = api.runtime?.getURL;
    if (typeof getURL !== "function") {
      return "";
    }
    try {
      return new URL(getURL.call(api.runtime, file), location.href).href;
    } catch (error) {
      console.error("[betterLD] settings resource URL is invalid", error);
      return "";
    }
  }

  function scopedOptionsStyles(cssText) {
    return cssText
      .replace(/:root\\b/g, ":host")
      .replace(/\\bhtml\\b/g, ":host")
      .replace(/\\bbody\\b/g, ":host");
  }

  function renderSettingsLoadState(shadowRoot, message, statusType = "") {
    const style = document.createElement("style");
    style.textContent = `:host { display: grid; place-items: center; min-height: 220px; padding: 32px; color: var(--betterld-on-surface, #1c1b1f); } .betterld-settings-load-state { margin: 0; text-align: center; } .betterld-settings-load-state[data-status=error] { color: var(--betterld-error, #ba1a1a); }`;
    const status = document.createElement("p");
    status.className = "betterld-settings-load-state";
    status.dataset.status = statusType;
    status.textContent = message;
    shadowRoot.replaceChildren(style, status);
  }

  async function loadOptionsScript(scriptUrl) {
    const scriptLocation = new URL(scriptUrl, location.href);
    if (scriptLocation.protocol === "http:" && scriptLocation.hostname === "127.0.0.1") {
      const response = await fetch(scriptLocation.href);
      if (!response.ok) {
        throw new Error(`settings script request failed: ${response.status}`);
      }
      const nonceElement = document.querySelector("script[nonce]");
      const nonce = nonceElement?.nonce || nonceElement?.getAttribute("nonce");
      if (!nonce || !document.head) {
        throw new Error("page CSP nonce or head is unavailable");
      }
      const script = document.createElement("script");
      script.nonce = nonce;
      script.setAttribute("nonce", nonce);
      script.textContent = `(() => {
  globalThis.BETTERLD_OPTIONS_ROOT = document.querySelector("[data-betterld-settings-surface=\\"true\\"]")?.shadowRoot;
  try {
    ${await response.text()}
  } finally {
    delete globalThis.BETTERLD_OPTIONS_ROOT;
  }
})();`;
      document.head.append(script);
      script.remove();
      return;
    }
    await import(scriptLocation.href);
  }

  async function loadEmbeddedSettings(panel) {
    const htmlUrl = settingsResourceUrl("src/options.html");
    const cssUrl = settingsResourceUrl("src/options.css");
    const scriptUrl = settingsResourceUrl("src/options.js");
    if (!htmlUrl || !cssUrl || !scriptUrl) {
      throw new Error("settings resource API is unavailable");
    }

    const [htmlResponse, cssResponse] = await Promise.all([fetch(htmlUrl), fetch(cssUrl)]);
    if (!htmlResponse.ok || !cssResponse.ok) {
      throw new Error(`settings resource request failed: ${htmlResponse.status}/${cssResponse.status}`);
    }
    const [html, css] = await Promise.all([htmlResponse.text(), cssResponse.text()]);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    if (!parsed.body) {
      throw new Error("settings HTML has no body");
    }
    const content = parsed.body.cloneNode(true);
    content.querySelectorAll("script").forEach((node) => node.remove());
    const style = document.createElement("style");
    style.textContent = scopedOptionsStyles(css);
    panel.shadowRoot.replaceChildren(style, ...content.childNodes);

    const previousRoot = globalThis.BETTERLD_OPTIONS_ROOT;
    globalThis.BETTERLD_OPTIONS_ROOT = panel.shadowRoot;
    try {
      await loadOptionsScript(scriptUrl);
    } finally {
      if (previousRoot === undefined) {
        delete globalThis.BETTERLD_OPTIONS_ROOT;
      } else {
        globalThis.BETTERLD_OPTIONS_ROOT = previousRoot;
      }
    }
  }

  function ensureSettingsDialog() {
    if (state.settingsDialog || !document.body) {
      return state.settingsDialog;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "betterld-settings-dialog";
    dialog.dataset.betterldSettingsDialog = "true";
    const surface = document.createElement("div");
    surface.className = "betterld-settings-dialog__surface";
    surface.dataset.betterldEmbedded = "true";
    surface.dataset.betterldSettingsSurface = "true";
    const shadowRoot = surface.attachShadow({ mode: "open" });
    renderSettingsLoadState(shadowRoot, "正在加载 betterLD 设置…");
    shadowRoot.addEventListener("betterld-settings-close", closeSettingsDialog);

    dialog.setAttribute("aria-label", "betterLD 设置");
    dialog.append(surface);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeSettingsDialog();
      }
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSettingsDialog();
    });
    dialog.addEventListener("close", () => {
      const trigger = state.settingsDialogTrigger;
      state.settingsDialogTrigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
    document.body.append(dialog);

    const panel = { dialog, surface, shadowRoot, ready: null };
    state.settingsDialog = panel;
    panel.ready = loadEmbeddedSettings(panel);
    panel.ready.catch((error) => {
      panel.failed = true;
      renderSettingsLoadState(panel.shadowRoot, "设置界面加载失败，请重试。", "error");
      console.error("[betterLD] embedded settings could not load", error);
    });
    return panel;
  }

  function closeSettingsDialog() {
    const panel = state.settingsDialog;
    if (!panel) {
      return;
    }
    if (panel.failed) {
      panel.dialog.remove();
      state.settingsDialog = null;
      const trigger = state.settingsDialogTrigger;
      state.settingsDialogTrigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      }
      return;
    }
    if (panel.dialog.open && typeof panel.dialog.close === "function") {
      panel.dialog.close();
      return;
    }
    panel.dialog.removeAttribute("open");
    const trigger = state.settingsDialogTrigger;
    state.settingsDialogTrigger = null;
    if (trigger?.isConnected) {
      trigger.focus();
    }
  }

  function openSettingsPage() {
    const activeElement = document.activeElement;
    state.settingsDialogTrigger = activeElement !== document.body ? activeElement : null;
    if (settingsResourceUrl("src/options.html")) {
      const panel = ensureSettingsDialog();
      if (!panel) {
        showActionStatus("betterLD 设置面板不可用");
        return;
      }
      panel.surface.dataset.betterldTheme = document.documentElement.dataset.betterldMode || "";
      if (panel.dialog.open) {
        panel.shadowRoot.querySelector("#settings-close")?.focus();
        return;
      }
      if (typeof panel.dialog.showModal === "function") {
        panel.dialog.showModal();
      } else {
        panel.dialog.setAttribute("open", "");
      }
      window.requestAnimationFrame(() => panel.shadowRoot.querySelector("#settings-close")?.focus());
      return;
    }

    const openOptionsPage = api.runtime?.openOptionsPage;
    if (typeof openOptionsPage !== "function") {
      console.error("[betterLD] settings page API is unavailable");
      return;
    }

    try {
      const result = openOptionsPage.call(api.runtime);
      result?.catch((error) => {
        console.error("[betterLD] settings page could not be opened", error);
      });
    } catch (error) {
      console.error("[betterLD] settings page could not be opened", error);
    }
  }

  function createSettingsTrigger() {
    const trigger = createElement("button", "betterld-settings-trigger");
    trigger.type = "button";
    trigger.dataset.betterldSettingsTrigger = "true";
    trigger.setAttribute("aria-label", "打开 betterLD 设置");
    trigger.title = "打开 betterLD 设置";
    trigger.addEventListener("click", openSettingsPage);
    const icon = createElement("span", "betterld-settings-trigger__icon", "⚙");
    icon.setAttribute("aria-hidden", "true");
    trigger.append(icon, createElement("span", "betterld-settings-trigger__label", "设置"));
    return trigger;
  }

  function ensureSettingsTrigger() {
    if (!document.body || !state.currentSettings.showSettingsTrigger) {
      document.querySelector("[data-betterld-settings-trigger]")?.remove();
      return;
    }
    if (!document.querySelector("[data-betterld-settings-trigger]")) {
      document.body.append(createSettingsTrigger());
    }
  }

  function createTouchHomeButton() {
    const link = createElement("a", "betterld-touch-home", "⌂");
    link.href = config.homepagePath;
    link.setAttribute("aria-label", "返回首页");
    link.title = "返回首页";
    return link;
  }

  function syncTouchHomeButton() {
    const shouldShow = state.currentSettings.showHomeButtonInTouchMode
      && document.documentElement.dataset.betterldTouchMode === "true";
    const current = document.querySelector("[data-betterld-touch-home]");
    if (!shouldShow) {
      current?.remove();
      return;
    }
    if (!current && document.body) {
      const link = createTouchHomeButton();
      link.dataset.betterldTouchHome = "true";
      document.body.append(link);
    }
  }

  // 页面内切换卡片布局：取值顺序以 config.settingsEnums.topicListLayoutMode 为准
  function cycleTopicListLayout() {
    const order = config.settingsEnums.topicListLayoutMode;
    const current = state.currentSettings.topicListLayoutMode;
    const next = order[(order.indexOf(current) + 1) % order.length];
    persistSettings({ topicListLayoutMode: next }, `卡片样式：${topicListLayoutLabels[next] || next}`);
    syncFloatingActions();
  }

  function createActionButton(key) {
    const layoutLabel = topicListLayoutLabels[state.currentSettings.topicListLayoutMode] || "";
    const labels = {
      settings: "设置",
      theme: "主题",
      layout: layoutLabel ? `切换卡片样式（当前：${layoutLabel}）` : "切换卡片样式",
      top: "返回顶部",
      refresh: "刷新",
      undoRefresh: "撤销刷新"
    };
    const icons = { settings: "⚙", theme: "☼", layout: "⊞", top: "↑", refresh: "↻", undoRefresh: "↶" };
    const button = createElement("button", "betterld-action-rail__button");
    button.type = "button";
    button.dataset.betterldAction = key;
    button.setAttribute("aria-label", labels[key] || key);
    button.title = labels[key] || key;
    button.append(createElement("span", "betterld-action-rail__icon", icons[key] || "•"));
    button.addEventListener("click", () => {
      if (key === "settings") {
        openSettingsPage();
      } else if (key === "layout") {
        cycleTopicListLayout();
      } else if (key === "theme") {
        const nativeToggle = document.querySelector("[data-theme-toggle], #toggle-dark-mode, .toggle-dark-mode");
        if (nativeToggle) {
          nativeToggle.click();
        } else {
          showActionStatus("当前页面没有可用的主题切换入口");
        }
      } else if (key === "top") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (key === "refresh") {
        refreshTopicsList();
      } else if (key === "undoRefresh") {
        const restored = restoreUndoRefreshSnapshot();
        state.undoRefreshSnapshot = null;
        syncFloatingActions();
        if (!restored) showActionStatus("没有可恢复的刷新记录");
      }
    });
    return button;
  }

  // 合并后的「返回顶部或刷新」：两项各自是否可用决定图标与点击行为，未到顶部显示向上箭头，已在顶部显示刷新图标
  function createMergedNavigationButton(showTop, showRefresh) {
    const button = createElement("button", "betterld-action-rail__button");
    button.type = "button";
    button.dataset.betterldAction = "topOrRefresh";
    button.setAttribute("aria-label", "返回顶部或刷新");
    button.title = "返回顶部或刷新";
    if (showTop) {
      button.append(createElement("span", "betterld-action-rail__icon", "↑"));
    }
    if (showRefresh) {
      button.append(createElement("span", "betterld-action-rail__icon", "↻"));
    }
    button.addEventListener("click", () => {
      if (showTop && pageScrollTop() > config.scrollTopThreshold) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (showRefresh) {
        refreshTopicsList();
      }
    });
    return button;
  }

  function snapshotHref() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function readUndoRefreshSnapshot() {
    try {
      const stored = sessionStorage.getItem(config.undoRefreshStorageKey);
      if (!stored) {
        return null;
      }
      const entry = JSON.parse(stored);
      if (!entry?.html || entry.url !== snapshotHref() || Date.now() - Number(entry.at || 0) > config.undoRefreshSnapshotTtlMs) {
        return null;
      }
      return entry;
    } catch (error) {
      console.warn("[betterLD] undo refresh snapshot read failed", error);
      return null;
    }
  }

  function captureUndoRefreshSnapshot() {
    const grid = document.querySelector('[data-betterld-grid="true"]');
    if (!state.currentSettings.enableUndoRefresh || !grid?.childElementCount) {
      return;
    }
    const html = grid.outerHTML;
    if (html.length > config.undoRefreshSnapshotMaxBytes) {
      console.warn("[betterLD] undo refresh snapshot skipped: the card grid is too large");
      return;
    }
    try {
      sessionStorage.setItem(config.undoRefreshStorageKey, JSON.stringify({
        url: snapshotHref(),
        at: Date.now(),
        scrollY: pageScrollTop(),
        html
      }));
    } catch (error) {
      console.warn("[betterLD] undo refresh snapshot write failed", error);
    }
  }

  function clearRefreshScrollTop() {
    try {
      sessionStorage.removeItem(config.refreshScrollTopStorageKey);
    } catch (error) {
      console.warn("[betterLD] refresh scroll intent clear failed", error);
    }
  }

  // 刷新后回到页首：站点启动时会把话题页滚回上次阅读位置，浏览器也可能恢复滚动位置。
  // 意图在刷新前写入，由刷新后的页面接管；接管后的时间窗内把位置钉在顶部（已在顶部时不动作）。
  function enforceRefreshScrollTop() {
    if (!state.refreshScrollTopSince) {
      let pending = 0;
      try {
        pending = Number(sessionStorage.getItem(config.refreshScrollTopStorageKey)) || 0;
      } catch (error) {
        return;
      }
      if (!pending) {
        return;
      }
      clearRefreshScrollTop();
      state.refreshScrollTopSince = Date.now();
    }
    if (Date.now() - state.refreshScrollTopSince > config.refreshScrollTopWindowMs) {
      return;
    }
    if (pageScrollTop() > config.scrollTopThreshold) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function restoreUndoRefreshSnapshot() {
    const snapshot = readUndoRefreshSnapshot();
    const grid = document.querySelector('[data-betterld-grid="true"]');
    if (!snapshot || !grid) {
      return false;
    }
    const holder = document.createElement("template");
    holder.innerHTML = snapshot.html.trim();
    const restored = holder.content.firstElementChild;
    if (!restored?.children.length) {
      return false;
    }
    // 只替换网格内容，保留当前网格元素本身，避免 managedSources 里留下失效引用
    grid.replaceChildren(...restored.children);
    clearRefreshScrollTop();
    window.scrollTo({ top: Number(snapshot.scrollY) || 0, behavior: "auto" });
    sessionStorage.removeItem(config.undoRefreshStorageKey);
    return true;
  }

  function syncFloatingActions() {
    if (!document.body) {
      return;
    }
    const settings = state.currentSettings;
    const href = snapshotHref();
    if (!settings.enableUndoRefresh) {
      state.undoRefreshSnapshot = null;
    } else if (state.undoRefreshSnapshot?.url !== href) {
      state.undoRefreshSnapshot = readUndoRefreshSnapshot();
    }
    const needsRail = settings.actionRailEnabled || settings.showBackToTopButton || settings.showRefreshButton || Boolean(state.undoRefreshSnapshot);
    let rail = document.querySelector("[data-betterld-action-rail]");
    if (!needsRail) {
      rail?.remove();
      ensureSettingsTrigger();
      syncTouchHomeButton();
      return;
    }
    document.querySelector("[data-betterld-settings-trigger]")?.remove();
    if (!rail) {
      rail = createElement("div", "betterld-action-rail");
      rail.dataset.betterldActionRail = "true";
      rail.setAttribute("role", "toolbar");
      rail.setAttribute("aria-label", "betterLD 快捷操作");
      document.body.append(rail);
    }
    rail.dataset.position = settings.actionRailPosition;
    rail.dataset.visibility = settings.actionRailVisibility;
    rail.dataset.glow = String(settings.actionRailGlow);
    rail.replaceChildren();
    const configured = Array.isArray(settings.actionRailItemsConfig) ? settings.actionRailItemsConfig : [];
    const mergedNavigationActions = !settings.separateNavigationActions;
    // 返回顶部与刷新只由各自的开关决定，不再叠一层「操作栏项目里是否可见」，否则开关打开也看不到按钮
    const mergedTop = settings.showBackToTopButton;
    const mergedRefresh = settings.showRefreshButton;
    configured.forEach((entry) => {
      if (!entry.visible || (entry.key === "settings" && !settings.showSettingsTrigger) || (entry.key === "theme" && !settings.showThemeToggle)) {
        return;
      }
      const button = createActionButton(entry.key);
      button.style.order = String(entry.order);
      rail.append(button);
    });
    if (mergedNavigationActions && (mergedTop || mergedRefresh)) {
      const merged = createMergedNavigationButton(mergedTop, mergedRefresh);
      merged.style.order = String(config.actionRailTailOrder);
      rail.append(merged);
    } else {
      if (mergedTop) {
        const button = createActionButton("top");
        button.style.order = String(config.actionRailTailOrder);
        rail.append(button);
      }
      if (mergedRefresh) {
        const button = createActionButton("refresh");
        button.style.order = String(config.actionRailTailOrder + 1);
        rail.append(button);
      }
    }
    if (state.undoRefreshSnapshot) {
      rail.append(createActionButton("undoRefresh"));
    }
    if (!rail.childElementCount) {
      rail.remove();
      ensureSettingsTrigger();
    }
    syncTouchHomeButton();
  }

  function topicInfo(item) {
    const link = item.querySelector('a.title[href], a.raw-link[href*="/t/"], a[href*="/t/"]');
    if (!link) {
      return null;
    }

    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return null;
    }

    if (url.origin !== location.origin || !url.pathname.startsWith("/t/")) {
      return null;
    }

    const idMatch = url.pathname.match(/^\/t\/[^/]+\/(\d+)/) || url.pathname.match(/^\/t\/(\d+)/);
    const title = cleanText(link.textContent || item.querySelector(".link-top-line")?.textContent) || "未命名主题";
    return { href: url.href, id: idMatch?.[1] || "", title };
  }

  function authorName(item) {
    const creator = item.querySelector(".topic-creator-data, .topic-poster, .posters, .creator, .author");
    const creatorNodes = creator ? [creator, ...creator.querySelectorAll("[data-user-card], [aria-label]")] : [];
    const name = creatorNodes
      .flatMap((node) => [node.getAttribute("data-user-card"), node.getAttribute("aria-label")])
      .map((value) => cleanText(value?.replace(/的个人资料\s*$/, "")))
      .find(Boolean);

    return name || config.authorLoadingLabel;
  }

  function avatarElement(item) {
    const wrapper = createElement("span", "betterld-topic-card__avatar");
    const source = item.querySelector(".topic-avatar img, .posters img.avatar, .avatar img, img.avatar");

    if (source) {
      const image = source.cloneNode(false);
      image.className = "";
      image.alt = "";
      image.loading = "lazy";
      wrapper.append(image);
      return wrapper;
    }

    wrapper.dataset.betterldAvatarFallback = "true";
    wrapper.textContent = "•";
    return wrapper;
  }

  function categoryInfo(item) {
    const source = item.querySelector(".badge-category__name, .badge-category, .category-name, .discourse-tag");
    const wrapper = source?.closest(".badge-category__wrapper") || source;
    const name = cleanText(source?.textContent) || cleanText(item.querySelector(".category")?.textContent) || "未分类";
    const style = source ? getComputedStyle(source) : null;
    const colorToken = wrapper?.style.getPropertyValue("--category-badge-color") || source?.style.getPropertyValue("--category-badge-color");
    const textToken = wrapper?.style.getPropertyValue("--category-badge-text-color") || source?.style.getPropertyValue("--category-badge-text-color");
    const color = safeColor(colorToken) || safeColor(style?.backgroundColor) || safeColor(style?.color);
    const text = safeColor(textToken) || safeColor(style?.color);
    return { name, color, text };
  }

  function topicTags(item, categoryName) {
    const tags = [...item.querySelectorAll(".discourse-tag, .topic-tag, .tag")]
      .map((node) => cleanText(node.textContent))
      .filter((value) => value && value !== categoryName);
    return [...new Set(tags)].slice(0, 4);
  }

  function topicLevel(item) {
    const token = [...item.classList].find((name) => /-lv[1-4]$/.test(name));
    if (token) {
      return Number(token.slice(-1));
    }
    const suffix = /,\s*Lv([1-4])$/.exec(categoryInfo(item).name);
    return suffix ? Number(suffix[1]) : 0;
  }

  // 元信息拆成「回复数」与「活动时间」两段，以便单独显隐；分隔符由 CSS 负责
  function compactMetaParts(item) {
    const groups = [
      { kind: "replies", selectors: [".topic-list-data.num.posts", ".topic-list-data.posts", ".num.posts", ".posts"] },
      { kind: "activity", selectors: [".topic-list-data.activity", ".activity", ".last-posted-at", ".relative-date"] }
    ];
    const parts = [];
    groups.forEach((group) => {
      const text = group.selectors
        .map((selector) => cleanText(item.querySelector(selector)?.textContent))
        .find((value) => value && !parts.some((part) => part.text === value));
      if (text) {
        parts.push({ kind: group.kind, text });
      }
    });
    return parts;
  }

  function createCard(item) {
    const topic = topicInfo(item);
    if (!topic) {
      return null;
    }

    const author = topic.id ? authorName(item) : config.authorPlaceholder;
    const category = categoryInfo(item);
    const card = createElement("article", "betterld-topic-card betterld-topic-card--reading");
    const badges = createElement("span", "betterld-topic-card__badges");
    // 标题必须保留 __link：抽屉关闭后的焦点回归依赖 content.js 的 openTopicDrawer 查询
    const title = createElement("a", "betterld-topic-card__link betterld-topic-card__title betterld-topic-card__reading-title", topic.title);
    const excerpt = createElement("div", "betterld-topic-card__excerpt", topic.id ? config.excerptLoadingLabel : config.excerptPlaceholder);
    const authorElement = createElement("a", "betterld-topic-card__author");
    authorElement.addEventListener("click", (event) => {
      if (authorElement.hasAttribute("href")) {
        event.stopPropagation();
      }
    });
    applyAuthorIdentity(authorElement, author);
    const chip = createElement("span", "betterld-topic-card__chip", category.name);
    const meta = createElement("span", "betterld-topic-card__meta");
    compactMetaParts(item).forEach((part, index) => {
      if (index) {
        const separator = createElement("span", "betterld-topic-card__meta-separator", " · ");
        separator.setAttribute("aria-hidden", "true");
        meta.append(separator);
      }
      const element = createElement("span", "betterld-topic-card__meta-part", part.text);
      element.dataset.betterldMetaPart = part.kind;
      meta.append(element);
    });

    title.href = topic.href;
    title.setAttribute("aria-label", topic.title);
    title.addEventListener("click", (event) => handleTopicCardClick(event, card, topic.href));
    card.dataset.topicHref = topic.href;
    card.dataset.topicId = topic.id;
    card.dataset.filterTitle = topic.title;
    card.dataset.filterCategory = category.name;
    card.dataset.filterTags = topicTags(item, category.name).join(" ");
    card.dataset.filterLevel = String(topicLevel(item));
    card.dataset.filterActivity = "";
    card.dataset.filterAuthor = "";
    card.dataset.authorState = topic.id ? "loading" : "failed";
    card.dataset.excerptState = topic.id ? "loading" : "failed";
    card.setAttribute("aria-busy", String(Boolean(topic.id)));
    excerpt.dataset.state = topic.id ? "loading" : "failed";
    chip.title = category.name;

    if (item.classList.contains("unread")) {
      card.classList.add("is-unread");
      const badge = createElement("span", "betterld-topic-card__badge", "未读");
      badge.dataset.betterldBadge = "unread";
      badges.append(badge);
    }
    if (item.classList.contains("pinned") || item.classList.contains("topic-list-item--pinned")) {
      card.classList.add("is-pinned");
      const badge = createElement("span", "betterld-topic-card__badge", "置顶");
      badge.dataset.betterldBadge = "pinned";
      badges.append(badge);
    }
    // 已看标记只来自本机浏览记录，不读服务端的已读状态
    if (topic.id && state.visitedTopics.has(topic.id)) {
      const badge = createElement("span", "betterld-topic-card__badge", "已看");
      badge.dataset.betterldBadge = "watched";
      badges.append(badge);
    }
    if (category.color) {
      card.style.setProperty("--betterld-category-color", category.color);
    }
    if (category.text) {
      card.style.setProperty("--betterld-category-text", category.text);
    }

    const menu = createCardMenu(card, item, topic);
    const shell = createElement("div", "betterld-topic-card__reading-shell");
    const header = createElement("div", "betterld-topic-card__reading-header");
    const infoRow = createElement("div", "betterld-topic-card__reading-info-row");
    const readingIdentity = createElement("span", "betterld-topic-card__reading-identity");
    const readingAvatar = avatarElement(item);
    const readingDetails = createElement("span", "betterld-topic-card__reading-details");
    const participants = createElement("span", "betterld-topic-card__participants");
    const tags = createElement("div", "betterld-topic-card__tags");
    const stats = createElement("span", "betterld-topic-card__reading-stats");
    const readingFooter = createElement("div", "betterld-topic-card__reading-footer");
    const action = createElement("a", "betterld-topic-card__reading-action", "View details");

    readingAvatar.classList.add("betterld-topic-card__reading-avatar");
    readingDetails.append(authorElement, chip, meta);
    readingIdentity.append(readingAvatar, readingDetails);
    participants.dataset.betterldReadingParticipants = "true";
    participants.hidden = true;
    tags.append(...topicTags(item, category.name).map((tag) => createElement("span", "betterld-topic-card__tag", `#${tag}`)));
    tags.hidden = !tags.childElementCount;
    stats.dataset.betterldReadingStats = "true";
    stats.hidden = true;
    action.href = topic.href;
    action.setAttribute("aria-label", `View details: ${topic.title}`);
    action.addEventListener("click", (event) => handleTopicCardClick(event, card, topic.href));
    meta.hidden = !cleanText(meta.textContent);
    infoRow.append(readingIdentity, participants);
    readingFooter.append(stats, action);
    header.append(badges, title, infoRow);
    shell.append(header, tags, excerpt, readingFooter);
    card.append(shell, menu);
    if (item.matches(".fps-result")) updateSearchCard(card, item);
    return card;
  }

  function safeSiteUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin ? url.href : "";
    } catch {
      return "";
    }
  }

  function safeTopicUrl(value) {
    const url = safeSiteUrl(value);
    if (!url) {
      return "";
    }
    try {
      return /^\/t\/[^/]+\/\d+(?:\/|$)/.test(new URL(url).pathname) ? url : "";
    } catch {
      return "";
    }
  }

  function topicCategoryHref(item) {
    const link = item.querySelector(".badge-category__wrapper a[href], .badge-category a[href], .category-name a[href]");
    return safeSiteUrl(link?.href);
  }

  function topicAuthorHref(item) {
    const link = item.querySelector(".topic-creator-data a[href], .topic-poster a[href], .creator a[href]");
    return safeSiteUrl(link?.href);
  }

  function userProfileHref(name) {
    const username = cleanText(name);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(username)) {
      return "";
    }
    return `${location.origin}${config.userProfilePath}${encodeURIComponent(username)}`;
  }

  function applyAuthorIdentity(authorElement, name) {
    const href = userProfileHref(name);
    if (authorElement.textContent !== name) {
      authorElement.textContent = name;
    }
    if (href && authorElement.getAttribute("href") !== href) {
      authorElement.href = href;
    } else if (!href && authorElement.hasAttribute("href")) {
      authorElement.removeAttribute("href");
    }
  }

  function showActionStatus(message, statusName = "error") {
    let status = document.querySelector("[data-betterld-action-status]");
    if (!status) {
      status = createElement("div", "betterld-action-status");
      status.dataset.betterldActionStatus = "true";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      document.body?.append(status);
    }
    status.textContent = message;
    status.dataset.status = statusName;
    status.hidden = false;
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
    }
    state.toastTimer = window.setTimeout(() => {
      status.hidden = true;
      state.toastTimer = 0;
    }, 3200);
  }

  function closeCardMenu(menu, returnFocus = false) {
    if (!menu) {
      return;
    }
    menu.dataset.open = "false";
    const card = menu.closest(".betterld-topic-card");
    if (card) {
      card.dataset.betterldMenuOpen = "false";
    }
    const trigger = menu.querySelector(".betterld-topic-card__menu-trigger");
    trigger?.setAttribute("aria-expanded", "false");
    if (state.openMenu === menu) {
      state.openMenu = null;
    }
    if (returnFocus) {
      trigger?.focus();
    }
  }

  function closeCardMenus(except) {
    document.querySelectorAll(".betterld-topic-card__menu[data-open=\"true\"]").forEach((menu) => {
      if (menu !== except) {
        closeCardMenu(menu);
      }
    });
  }

  function toggleCardMenu(menu) {
    const open = menu.dataset.open === "true";
    const nextOpen = !open;
    closeCardMenus(menu);
    menu.dataset.open = String(nextOpen);
    const card = menu.closest(".betterld-topic-card");
    if (card) {
      card.dataset.betterldMenuOpen = String(nextOpen);
    }
    const trigger = menu.querySelector(".betterld-topic-card__menu-trigger");
    trigger?.setAttribute("aria-expanded", String(nextOpen));
    state.openMenu = nextOpen ? menu : null;
    if (nextOpen) {
      menu.querySelector("[role=menuitem]")?.focus();
    }
  }

  function sendRuntimeMessage(message) {
    const sendMessage = api.runtime?.sendMessage;
    if (typeof sendMessage !== "function") {
      return Promise.reject(new Error("后台标签页打开 API 不可用"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      const onResponse = (response) => {
        const error = api.runtime?.lastError;
        if (error) {
          settle(reject, new Error(error.message));
          return;
        }
        settle(resolve, response);
      };
      try {
        const usePromiseApi = globalThis.browser && api === globalThis.browser;
        const result = usePromiseApi
          ? sendMessage.call(api.runtime, message)
          : sendMessage.call(api.runtime, message, onResponse);
        if (result?.then) {
          result.then((response) => settle(resolve, response)).catch((error) => settle(reject, error));
        }
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  // 后台标签页打开：只接受同站链接，实际创建标签页由后台 service worker 完成
  async function openBackgroundLink(url) {
    const safeUrl = safeSiteUrl(url);
    if (!safeUrl) {
      throw new Error("后台打开目标不是有效的 LinuxDo 链接");
    }
    const response = await sendRuntimeMessage({ type: "open-link", url: safeUrl, active: false });
    if (!response?.ok) {
      throw new Error(response?.error || "后台标签页打开失败");
    }
  }

  function copyText(value) {
    if (!navigator.clipboard?.writeText) {
      return Promise.reject(new Error("当前页面不支持剪贴板写入"));
    }
    return navigator.clipboard.writeText(value);
  }

  function actionLabel(action) {
    return {
      openCurrentTab: "当前页打开",
      openNewTab: "新标签页打开",
      openBackground: "后台打开",
      openDrawer: "打开原帖预览",
      copyTopicUrl: "复制主题 URL",
      copyCleanUrl: "复制干净 URL",
      copyTopicId: "复制主题 ID",
      openCategory: "打开分类",
      openAuthor: "打开作者主页",
      ignoreAuthor: "在服务端屏蔽作者"
    }[action] || action;
  }

  function cardActionEntries(card) {
    const settings = state.currentSettings;
    const categoryHref = card.dataset.categoryHref;
    const authorHref = card.dataset.authorHref;
    const configured = Array.isArray(settings.topicCardContextMenuConfig) ? settings.topicCardContextMenuConfig : [];
    return configured.filter((entry) => {
      if (!entry.visible) {
        return false;
      }
      if (entry.key === "openCategory") {
        return Boolean(categoryHref);
      }
      if (entry.key === "openAuthor") {
        return Boolean(authorHref);
      }
      return config.topicCardContextMenuActions.includes(entry.key);
    });
  }

  function renderCardMenuActions(menu, card) {
    const panel = menu.querySelector(".betterld-topic-card__menu-panel");
    if (!panel) {
      return;
    }
    panel.replaceChildren();
    cardActionEntries(card).forEach((entry) => {
      const action = entry.key;
      const button = createElement("button", "betterld-topic-card__menu-item", actionLabel(action));
      button.type = "button";
      button.dataset.betterldMenuAction = action;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        executeCardAction(action, card, menu);
      });
      button.style.order = String(entry.order);
      panel.append(button);
    });
    menu.hidden = panel.childElementCount === 0;
  }

  function createCardMenu(card, item, topic) {
    const menu = createElement("div", "betterld-topic-card__menu");
    menu.dataset.open = "false";
    card.dataset.betterldMenuOpen = "false";
    card.dataset.categoryHref = topicCategoryHref(item);
    card.dataset.authorHref = topicAuthorHref(item);
    const trigger = createElement("button", "betterld-topic-card__menu-trigger", "⋯");
    trigger.type = "button";
    trigger.setAttribute("aria-label", "打开主题操作菜单");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const panel = createElement("div", "betterld-topic-card__menu-panel");
    panel.setAttribute("role", "menu");
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCardMenu(menu);
    });
    menu.append(trigger, panel);
    renderCardMenuActions(menu, card);
    return menu;
  }

  async function ignoreAuthorOnServer(username) {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    if (!token) {
      throw new Error("无法读取登录状态或 CSRF 令牌");
    }
    const params = new URLSearchParams();
    params.set("notification_level", "ignore");
    params.set("expiring_at", config.discourseIgnoreExpiringAt);
    const response = await fetch(`/u/${encodeURIComponent(username)}/notification_level.json`, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        ...discourseAjaxHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-Token": token
      },
      body: params.toString()
    });
    if (!response.ok) {
      throw new Error(`服务端屏蔽失败（HTTP ${response.status}）`);
    }
    const result = await response.json();
    if (result.success !== "OK") {
      throw new Error(result.errors?.join("；") || "服务端未确认屏蔽成功");
    }
  }

  async function executeCardAction(action, card, menu) {
    closeCardMenu(menu);
    if (action === "ignoreAuthor") {
      const author = card.dataset.filterAuthor;
      if (!author) {
        showActionStatus("作者尚未加载完成，暂时无法屏蔽");
        return;
      }
      if (!globalThis.confirm(`确定屏蔽 @${author}？将写入 LinuxDo 账号，并加入本地作者规则、启用隐藏模式（白名单仍优先）。`)) {
        return;
      }
      try {
        await ignoreAuthorOnServer(author);
        const keyword = state.currentSettings.topicFilterMatchMode === "regex" ? `^${escapeRegExp(author)}$` : author;
        const settings = normalizeSettings({
          ...state.currentSettings,
          topicFilterEnabled: true,
          topicFilterMode: "hide",
          topicAuthorRules: [{ keyword }, ...state.currentSettings.topicAuthorRules]
        });
        try {
          await storageSet({ [config.storageKey]: settings });
          applyVisualSettings(settings);
          syncManagedCardContent();
          showActionStatus(`已屏蔽 @${author}，本地作者隐藏规则已生效`, "success");
        } catch (error) {
          console.error("[betterLD] local author rule save failed", error);
          showActionStatus(`服务端已屏蔽 @${author}，本地规则保存失败：${error.message}`);
        }
      } catch (error) {
        showActionStatus(error instanceof Error ? error.message : "服务端屏蔽失败");
      }
      return;
    }
    const topicUrl = safeTopicUrl(card.dataset.topicHref);
    if (!topicUrl) {
      showActionStatus("主题链接不可用");
      return;
    }
    try {
      if (action === "openCurrentTab") {
        location.assign(topicUrl);
        return;
      }
      if (action === "openNewTab") {
        const opened = globalThis.open(topicUrl, "_blank", "noopener,noreferrer");
        if (!opened) {
          throw new Error("新标签页打开被浏览器阻止");
        }
        return;
      }
      if (action === "openBackground") {
        await openBackgroundLink(topicUrl);
        showActionStatus("已在后台打开主题", "success");
        return;
      }
      if (action === "openDrawer") {
        openTopicDrawer(card);
        return;
      }
      if (action === "copyTopicUrl") {
        await copyText(topicUrl);
        showActionStatus("主题 URL 已复制", "success");
        return;
      }
      if (action === "copyCleanUrl") {
        const cleanUrl = new URL(topicUrl);
        cleanUrl.search = "";
        cleanUrl.hash = "";
        await copyText(cleanUrl.href);
        showActionStatus("干净 URL 已复制", "success");
        return;
      }
      if (action === "copyTopicId") {
        await copyText(card.dataset.topicId || "");
        showActionStatus("主题 ID 已复制", "success");
        return;
      }
      if (action === "openCategory" || action === "openAuthor") {
        const target = action === "openCategory" ? card.dataset.categoryHref : card.dataset.authorHref;
        const safeTarget = safeSiteUrl(target);
        if (!safeTarget) {
          throw new Error("目标链接不可用");
        }
        location.assign(safeTarget);
        return;
      }
      throw new Error("未知的卡片操作");
    } catch (error) {
      showActionStatus(error instanceof Error ? error.message : "卡片操作失败");
    }
  }

  function syncCardMenus() {
    document.querySelectorAll(".betterld-topic-card").forEach((card) => {
      const menu = card.querySelector(".betterld-topic-card__menu");
      if (menu) {
        renderCardMenuActions(menu, card);
      }
    });
  }

  function handleTopicCardClick(event, card, topicUrl) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const mode = state.currentSettings.topicCardOpenMode;
    if (mode === "currentTab") {
      return;
    }
    event.preventDefault();
    if (mode === "newTab") {
      const opened = globalThis.open(topicUrl, "_blank", "noopener,noreferrer");
      if (!opened) {
        showActionStatus("新标签页打开被浏览器阻止");
      }
      return;
    }
    if (mode === "background") {
      openBackgroundLink(topicUrl)
        .then(() => showActionStatus("已在后台打开主题", "success"))
        .catch((error) => showActionStatus(error instanceof Error ? error.message : "后台标签页打开失败"));
      return;
    }
    if (mode === "drawer") {
      openTopicDrawer(card);
    }
  }

  function ensureTopicDrawer() {
    if (state.topicDrawer || !document.body) {
      return state.topicDrawer;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "betterld-topic-drawer";
    dialog.dataset.betterldTopicDrawer = "true";
    const header = createElement("div", "betterld-topic-drawer__header");
    const title = createElement("h2", "betterld-topic-drawer__title");
    const close = createElement("button", "betterld-topic-drawer__close", "关闭");
    close.type = "button";
    close.addEventListener("click", () => closeTopicDrawer());
    header.append(title, close);
    title.id = "betterld-topic-preview-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const body = createElement("div", "betterld-topic-drawer__body");
    body.tabIndex = 0;
    const meta = createElement("div", "betterld-topic-drawer__meta");
    meta.hidden = true;
    const content = createElement("article", "cooked betterld-topic-drawer__cooked");
    body.append(meta, content);
    const openLink = createElement("a", "betterld-topic-drawer__open", "在当前页打开完整主题");
    openLink.target = "_self";
    dialog.append(header, body, openLink);
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && state.currentSettings.drawerCloseOnOverlay
        && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
        closeTopicDrawer();
      }
    });
    dialog.addEventListener("cancel", (event) => {
      if (!state.currentSettings.drawerCloseOnEscape) {
        event.preventDefault();
        showActionStatus("Escape 关闭抽屉已禁用");
      }
    });
    dialog.addEventListener("close", () => {
      // close 事件是异步派发的，且用户自己关（Esc/遮罩/requestClose）也会走到这里：
      // 只能看 dialog.open —— 它仍为真说明已经开了新的一轮（刚关又开），迟到的这次 close 不能清掉新内容与触发卡；
      // 为假就是真的关上了，按当前状态清理。这样调用方不需要记得同步任何代次。
      if (dialog.open) {
        return;
      }
      state.drawerRequest += 1;
      releaseTopicDrawer(dialog);
      clearTopicDrawerContent(state.topicDrawer);
      const trigger = state.drawerTrigger;
      state.drawerTrigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
    document.body.append(dialog);
    state.topicDrawer = { dialog, title, body, meta, content, openLink, close };
    return state.topicDrawer;
  }

  // 抽屉关闭（用户 Esc/遮罩、路由切换、程序化关闭）的统一收尾：迟到的正文预览回调不该再留下 pending 痕迹
  // （留着会让触发卡继续被当成「正在被读」而排队），从抽屉内容打开的灯箱/代码全屏也要跟着一起收掉。
  function releaseTopicDrawer(dialog) {
    state.drawerRequestPending = false;
    closeReplyOverlaysOwnedBy(dialog);
  }

  function clearTopicDrawerContent(drawer) {
    if (!drawer) {
      return;
    }
    drawer.meta.replaceChildren();
    drawer.meta.hidden = true;
    drawer.content.replaceChildren();
  }

  // 作者、活动时间与统计都来自列表载荷（零请求）；缺字段就不渲染对应项，不写「加载中」占位。
  function renderTopicDrawerMeta(drawer, metadata) {
    const parts = [];
    const author = cleanText(metadata?.author);
    if (author) {
      parts.push(createElement("span", "betterld-topic-drawer__author", author));
    }
    const activityAt = String(metadata?.activityAt || "");
    const activityTime = activityAt ? new Date(activityAt) : null;
    if (activityTime && !Number.isNaN(activityTime.getTime())) {
      const time = createElement("time", "betterld-topic-drawer__time", activityTime.toLocaleString());
      time.dateTime = activityAt;
      parts.push(time);
    }
    const stats = Array.isArray(metadata?.stats) ? metadata.stats : [];
    if (stats.length) {
      const list = createElement("span", "betterld-topic-drawer__stats");
      list.append(...stats.map((stat) => {
        const item = createElement("span", "betterld-topic-drawer__stat", `${stat.label} ${stat.value}`);
        item.dataset.betterldStat = stat.key;
        return item;
      }));
      parts.push(list);
    }
    drawer.meta.replaceChildren(...parts);
    drawer.meta.hidden = !parts.length;
  }

  // 列表载荷给出作者/活动时间/统计，正文请求只补它缺的部分
  // （纯文本端点没有这些字段，不能把已经渲染的列表元信息顶掉）。
  // 列表载荷是最新的站点列表数据（作者/活动时间/统计/参与者），优先用它；
  // 正文请求返回的同名字段只在列表缺该项时兜底（它的缓存可能比列表旧）。缺字段不写占位假值。
  function drawerMetadata(topicId, metadata) {
    const list = state.topicListMetadata.get(topicId) || {};
    if (!metadata) {
      return list;
    }
    return {
      author: list.author || metadata.author,
      activityAt: list.activityAt || metadata.activityAt,
      stats: list.stats?.length ? list.stats : metadata.stats,
      participants: list.participants?.length ? list.participants : metadata.participants
    };
  }

  // 抽屉触发卡在抽屉打开期间（含 showModal 之前的那一小段）都算「正在被读」：
  // 队列可能在 showModal() 之前就同步出队并判定 isNeeded()，只看 dialog.open 会把请求当成不再需要而拒掉。
  function drawerHoldsCard(card) {
    return Boolean(state.drawerTrigger?.closest(".betterld-topic-card") === card
      && (state.topicDrawer?.dialog.open || state.drawerRequestPending));
  }

  function setTopicDrawerContent(drawer, metadata) {
    if (metadata.cooked) {
      // 与回复树、Boost 共用同一条 cooked 渲染路径（callout/剧透/hashtag/代码块复制/灯箱/引用展开），不另写一套。
      drawer.content.replaceChildren(...replyCooked(metadata.cooked).childNodes);
    } else if (metadata.markdown) {
      // 纯文本端点没有 cooked，改用同一套 Markdown 渲染器把首帖排成 DOM。
      markdownApi.render(drawer.content, metadata.markdown);
    } else {
      drawer.content.textContent = metadata.text;
    }
  }

  function closeTopicDrawer() {
    const drawer = state.topicDrawer;
    if (!drawer) {
      return;
    }
    state.drawerRequest += 1;
    releaseTopicDrawer(drawer.dialog);
    clearTopicDrawerContent(drawer);
    if (drawer.dialog.open && typeof drawer.dialog.close === "function") {
      drawer.dialog.close();
    } else {
      drawer.dialog.removeAttribute("open");
      const trigger = state.drawerTrigger;
      state.drawerTrigger = null;
      trigger?.focus();
    }
  }

  function resizeTopicDrawer() {
    const dialog = state.topicDrawer?.dialog;
    if (!dialog?.open) return;
    const { aspectRatio, viewportArea, marginPx } = config.topicPreview;
    const width = Math.min(
      Math.sqrt(window.innerWidth * window.innerHeight * viewportArea * aspectRatio),
      window.innerWidth - marginPx * 2,
      (window.innerHeight - marginPx * 2) * aspectRatio
    );
    dialog.style.width = `${width}px`;
    dialog.style.height = `${width / aspectRatio}px`;
  }

  function openTopicDrawer(card) {
    const drawer = ensureTopicDrawer();
    if (!drawer) {
      showActionStatus("原帖预览不可用");
      return;
    }
    const topicUrl = safeTopicUrl(card.dataset.topicHref);
    if (!topicUrl) {
      showActionStatus("原帖链接无效");
      return;
    }
    closeCardMenus();
    const requestId = ++state.drawerRequest;
    const topicId = card.dataset.topicId;
    state.drawerTrigger = card.querySelector(".betterld-topic-card__link");
    drawer.title.textContent = card.querySelector(".betterld-topic-card__title")?.textContent || "原帖预览";
    drawer.openLink.href = topicUrl;
    renderTopicDrawerMeta(drawer, drawerMetadata(topicId));
    const cached = state.excerptCache.get(topicId);
    // 只有带完整 cooked 的条目才算能直接渲染：长帖的 cooked 超过存储上限时条目只剩截断的 markdown，
    // 这时走下面的请求分支，优先插队拿完整正文再渲染。
    if (cached?.state === "ready" && cached.cooked) {
      // 已经拿到的正文直接渲染，抽屉不再为一个整页 iframe 等几秒。
      renderTopicDrawerMeta(drawer, drawerMetadata(topicId, cached));
      setTopicDrawerContent(drawer, cached);
    } else if (state.metadataCooldownUntil > Date.now()) {
      drawer.content.textContent = config.excerptThrottledLabel;
    } else {
      drawer.content.textContent = config.excerptLoadingLabel;
      if (cached?.state === "failed") {
        state.excerptCache.delete(topicId);
      }
      // 抽屉触发卡本身就是预览队列里的最高优先级，这个请求会插到其它预览前面。
      // 标志位必须在请求之前设置：队列可能在这里同步出队并判定 isNeeded()，那时 showModal() 还没轮到。
      state.drawerRequestPending = true;
      requestTopicMetadata(topicId, false, true)
        .then((metadata) => {
          // 代次不匹配说明这条回调已经过期（关掉后又开了别的主题）：整段丢弃，
          // 否则旧回调会清掉新一轮的 pending，抽屉永远停在「正在读取正文预览…」。
          if (state.drawerRequest !== requestId) return;
          state.drawerRequestPending = false;
          if (!drawer.dialog.open) return;
          renderTopicDrawerMeta(drawer, drawerMetadata(topicId, metadata));
          setTopicDrawerContent(drawer, metadata);
        })
        .catch((error) => {
          if (state.drawerRequest !== requestId) return;
          state.drawerRequestPending = false;
          console.warn("[betterLD] topic preview unavailable", error);
          // 冷却期间被拒的请求与卡片用同一份原因文案（name 比 message 稳定）。
          if (error.name === "RateLimitError") {
            drawer.content.textContent = config.excerptThrottledLabel;
            return;
          }
          const blocked = /challenge|403|429/.test(error.message);
          drawer.content.textContent = blocked
            ? "站点验证阻止了原帖请求，请在当前页打开完整主题。"
            : "原帖正文加载失败，请在当前页打开完整主题。";
        });
    }
    if (typeof drawer.dialog.showModal === "function") {
      if (!drawer.dialog.open) {
        drawer.dialog.showModal();
      }
    } else {
      drawer.dialog.setAttribute("open", "");
    }
    resizeTopicDrawer();
    window.requestAnimationFrame(() => drawer.close.focus());
  }

  function plainText(markup) {
    const documentFragment = new DOMParser().parseFromString(String(markup || ""), "text/html");
    documentFragment.querySelectorAll("script, style, noscript, template, svg").forEach((node) => node.remove());
    return cleanText(documentFragment.body?.textContent).slice(0, config.excerptMaxCharacters);
  }

  function numericTopicValue(value) {
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function topicStats(data) {
    const posts = numericTopicValue(data?.posts_count);
    const replies = numericTopicValue(data?.reply_count) ?? (posts === null ? null : Math.max(posts - 1, 0));
    return [
      { key: "replies", label: "回复", icon: "comment", value: replies },
      { key: "likes", label: "点赞", icon: "heart", value: numericTopicValue(data?.like_count) },
      { key: "views", label: "浏览", icon: "views", value: numericTopicValue(data?.views) }
    ].filter((stat) => stat.value !== null);
  }

  function topicParticipants(data) {
    const candidates = [
      ...(Array.isArray(data?.details?.participants) ? data.details.participants : []),
      ...(Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [])
    ];
    const seen = new Set();
    return candidates
      .map((entry) => ({
        username: cleanText(entry?.username),
        avatarTemplate: String(entry?.avatar_template || "").trim()
      }))
      .filter((entry) => {
        const key = entry.username || entry.avatarTemplate;
        if (!entry.avatarTemplate || !key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, 4);
  }

  // 等上一请求完成再放行，确保挑战/限流响应先更新冷却时间，并给原站分页留出请求余量。
  // 正文预览属于批量流量（一屏卡片一次），单独走更慢的节奏与配额，
  // 不然它会占满队列、把回复加载这种阅读必需的请求一起拖住。
  function scheduleMetadataRequest(task, isNeeded, isPriority, isExcerpt = false, score = () => 0) {
    return new Promise((resolve, reject) => {
      state.metadataQueue.push({ task, isNeeded, isPriority, isExcerpt, score, resolve, reject });
      drainMetadataQueue();
    });
  }

  function requestWindowWait(starts, windowMs, maxPerWindow, now) {
    const recent = starts.filter((at) => now - at < windowMs);
    starts.length = 0;
    starts.push(...recent);
    return recent.length >= maxPerWindow ? recent[0] + windowMs : 0;
  }

  // 正文预览用令牌桶：一次阅读停顿需要的几张卡能立刻发出（突发额度），
  // 持续阅读时按固定速度补充，长期速率不会超过站点可接受的量。
  // 返回值是“下一个令牌可用的绝对时间”，与队列里其它门的写法定一致。
  function excerptTokenWait(now) {
    if (state.excerptTokens >= config.excerptRequestBurst) {
      state.excerptTokensAt = now;
      return 0;
    }
    const gained = Math.floor((now - state.excerptTokensAt) / config.excerptRequestRefillMs);
    if (gained > 0) {
      state.excerptTokens = Math.min(config.excerptRequestBurst, state.excerptTokens + gained);
      state.excerptTokensAt += gained * config.excerptRequestRefillMs;
    }
    return state.excerptTokens >= 1 ? 0 : state.excerptTokensAt + config.excerptRequestRefillMs;
  }

  // 选件顺序：悬停/聚焦/抽屉触发卡最优先；其次非正文的元数据请求（回复加载等）按先来先服务，
  // 不被预览挤位；最后才是正文预览，按阅读位置（视口内越靠上越先）取分最小者。
  function nextMetadataIndex() {
    const priorityIndex = state.metadataQueue.findIndex((entry) => entry.isPriority());
    if (priorityIndex >= 0) {
      return priorityIndex;
    }
    const plainIndex = state.metadataQueue.findIndex((entry) => !entry.isExcerpt);
    if (plainIndex >= 0) {
      return plainIndex;
    }
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < state.metadataQueue.length; index += 1) {
      const score = state.metadataQueue[index].score();
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  async function drainMetadataQueue() {
    if (state.metadataRunning) {
      return;
    }
    state.metadataRunning = true;
    try {
      while (state.metadataQueue.length) {
        // 站点在拦（挑战/429 冷却）期间一个请求都不发。正文预览是批量流量，留在队列里只会无限期挂起，
        // 卡片永远停在加载文案；这里把预览条目以可识别的错误拒绝，让卡片显示真实原因并在冷却到期后重排。
        // 其它请求（回复加载等）维持原有等待语义，冷却结束照常发出。
        if (state.metadataCooldownUntil > Date.now()) {
          for (let index = state.metadataQueue.length - 1; index >= 0; index -= 1) {
            const entry = state.metadataQueue[index];
            if (!entry.isExcerpt) {
              continue;
            }
            state.metadataQueue.splice(index, 1);
            entry.reject(topicThrottleError());
          }
          if (!state.metadataQueue.length) {
            break;
          }
        }
        while (true) {
          const entry = state.metadataQueue[nextMetadataIndex()];
          const now = Date.now();
          const wait = Math.max(
            state.metadataNextAt,
            state.metadataCooldownUntil,
            requestWindowWait(state.metadataStarts, config.topicRequestWindowMs, config.topicRequestMaxPerWindow, now),
            entry.isExcerpt
              ? Math.max(state.excerptRequestNextAt, excerptTokenWait(now))
              : 0
          ) - now;
          if (wait <= 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, wait));
        }
        // 到真正发请求时再按当前关注位置排序，悬停不会绕过限速或冷却。
        const [entry] = state.metadataQueue.splice(nextMetadataIndex(), 1);
        if (!entry.isNeeded()) {
          entry.reject(new DOMException("Topic request is no longer needed", "AbortError"));
          continue;
        }
        const startedAt = Date.now();
        state.metadataStarts.push(startedAt);
        state.metadataNextAt = startedAt + config.topicRequestMinIntervalMs;
        if (entry.isExcerpt) {
          state.excerptTokens -= 1;
          state.excerptRequestNextAt = startedAt + config.excerptRequestMinIntervalMs;
        }
        try {
          entry.resolve(await entry.task());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      state.metadataRunning = false;
      // 队列排空就是空闲窗口：等页面停住、令牌桶有令牌时把视口下方的卡提前排上
      // （prefetchExcerpts 自己会在条件不满足时重排，不在这里直接发）。
      if (!state.metadataQueue.length) {
        scheduleExcerptPrefetch();
      }
    }
  }

  // 冷却期间被拒绝的正文预览请求：卡片据此显示站点限制文案、并在冷却到期后重排一次，
  // 而不是永远停在加载文案上。用 name 而不是 message 识别，文案可自由调整。
  function topicThrottleError() {
    const error = new Error("topic excerpt requests are blocked by the site cooldown");
    error.name = "RateLimitError";
    return error;
  }

  // 冷却时间写进 storage.local：站点限速是按 IP 计的，同一窗口里再打开/切换页面时
  // 新页面不能从头再起一轮突发请求，而要接着等上一个窗口结束。
  function holdMetadataRequests(until) {
    state.metadataCooldownUntil = Math.max(state.metadataCooldownUntil, until);
    storageSet({ [config.topicRequestCooldownStorageKey]: state.metadataCooldownUntil })
      .catch((error) => console.warn("[betterLD] 请求冷却时间写入失败", error));
    // 冷却刚武装：当时还没出正文的卡（含尚未请求过的）先换上真实原因，不留在加载文案上。
    applyExcerptThrottleNoticeToAll();
    // 同时排定到期重排：不能依赖「刚好有卡被拒」——页面加载时就带着 storage 里的冷却、
    // 冷却只由抽屉或其它请求触发时，都没有卡片走到被拒那条路。
    scheduleExcerptThrottleRetry();
  }

  // 站点在拦（冷却中）时正文请求发不出去：把还没出正文的卡的正文区换成真实原因文案，
  // 而不是 createCard 写死的「正在读取正文预览…」（那既不是加载中也不是失败，而是一直不会动）。
  // 状态仍是 loading：冷却到期后 retryThrottledExcerpts 按视口重排，滚动进视口的卡照常走 loadExcerpt。
  function applyExcerptThrottleNotice(card) {
    if (card.dataset.excerptState !== "loading") {
      return;
    }
    const excerpt = card.querySelector(".betterld-topic-card__excerpt");
    if (excerpt?.dataset.state === "loading") {
      excerpt.textContent = config.excerptThrottledLabel;
    }
  }

  function applyExcerptThrottleNoticeToAll() {
    if (!state.currentSettings.showTopicExcerpt || state.metadataCooldownUntil <= Date.now()) {
      return;
    }
    managedCards().forEach(applyExcerptThrottleNotice);
  }

  // 站点前面的 Cloudflare 会对不像站点自身 ajax 的 JSON 请求直接返回挑战页，
  // 一旦被打上挑战状态，站点自己的分页请求也会一起被挡、底部加载 spinner 永不结束。
  // 所以这里带上 Discourse ajax 同款的 X-Requested-With，并在被挑战时长时间停发。
  function applyRateLimit(retryAfter) {
    const seconds = Number(retryAfter);
    const delay = seconds > 0 ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    holdMetadataRequests(Date.now() + Math.min(
      Math.max(config.topicRequestCooldownMs, Number.isFinite(delay) ? delay : 0),
      config.topicChallengeCooldownMs));
  }

  function requestTopicResponse(url, isNeeded = () => true, isPriority = () => false, isExcerpt = false, score = () => 0, read = (response) => response.json()) {
    const existing = state.responseRequests.get(url);
    if (existing) {
      existing.consumers.push({ isNeeded, isPriority, score });
      return existing.promise;
    }
    const consumers = [{ isNeeded, isPriority, score }];
    const promise = scheduleMetadataRequest(async () => {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: discourseAjaxHeaders
      });
      if (response.headers.get("cf-mitigated") === "challenge") {
        holdMetadataRequests(Date.now() + config.topicChallengeCooldownMs);
        throw new Error("topic request blocked by the site challenge; cooling down");
      }
      if (response.status === 429) {
        applyRateLimit(response.headers.get("Retry-After"));
        throw new Error("topic request rate limited; cooling down");
      }
      if (!response.ok) {
        throw new Error(`topic request failed with ${response.status}`);
      }
      return read(response);
    }, () => consumers.some((consumer) => consumer.isNeeded()),
    () => consumers.some((consumer) => consumer.isNeeded() && consumer.isPriority()),
    isExcerpt,
    () => consumers.reduce((best, consumer) => Math.min(best, consumer.score()), Number.POSITIVE_INFINITY))
      .finally(() => state.responseRequests.delete(url));
    state.responseRequests.set(url, { promise, consumers });
    return promise;
  }

  function openingPost(data) {
    const post = data?.post_stream?.posts?.find((entry) => entry.post_number === 1);
    if (!post) throw new Error("topic opening post unavailable");
    return post;
  }

  // 正文端点集中在这里：`/t/{id}.json?include_raw=1` 返回 JSON（cooked + raw），
  // `/raw/{id}/1` 返回纯文本（首帖 markdown，体积小得多）。换端点只改这个函数的 url 与 read。
  function topicContentRequest(topicId) {
    const endpoint = new URL(`/t/${topicId}.json`, location.origin);
    endpoint.searchParams.set("include_raw", "1");
    return { url: endpoint.href, read: (response) => response.json() };
  }

  // 两种响应形态归一成同一份 metadata：对象形态带 cooked；文本形态只有 markdown（抽屉按 markdown 渲染）。
  function topicMetadataFromResponse(data) {
    if (typeof data === "string") {
      const markdown = data.trim().slice(0, config.excerptMaxCharacters);
      return {
        text: markdown ? plainText(markdown) : config.excerptEmptyLabel,
        markdown,
        cooked: "",
        contentState: markdown ? "ready" : "empty",
        author: "",
        activityAt: "",
        stats: [],
        participants: []
      };
    }
    const post = openingPost(data);
    const raw = String(post?.raw || "").trim().slice(0, config.excerptMaxCharacters);
    const cooked = String(post?.cooked || "").trim();
    const text = plainText(cooked || raw);
    const markdown = raw || text;
    const contentState = markdown ? "ready" : "empty";
    return {
      text: contentState === "ready" ? text || markdown : config.excerptEmptyLabel,
      markdown,
      cooked,
      contentState,
      author: cleanText(data?.details?.created_by?.username),
      activityAt: cleanText(data?.last_posted_at || data?.bumped_at || data?.created_at),
      stats: topicStats(data),
      participants: topicParticipants(data)
    };
  }

  async function fetchTopicMetadata(topicId) {
    const request = topicContentRequest(topicId);
    const data = await requestTopicResponse(request.url, () => managedCards().some((card) => {
      if (card.dataset.topicId !== topicId) {
        return false;
      }
      const rect = card.getBoundingClientRect();
      return card.dataset.authorState === "loading"
        || drawerHoldsCard(card)
        || prefetchNeeded(card)
        || (excerptLoadable(card) && rect.bottom > 0 && rect.top < window.innerHeight);
    }), () => managedCards().some((card) => card.dataset.topicId === topicId
      && (card.matches(":hover, :focus-within") || drawerHoldsCard(card))),
    true, () => excerptScore(topicId), request.read);
    return topicMetadataFromResponse(data);
  }

  // 阅读位置分（只用于正文预览请求之间的排序）：悬停/聚焦/抽屉触发卡最优先（0），
  // 视口内用 rect.top（越靠上越小），视口外整体排在视口之后。
  const excerptOutOfViewScore = 1e6;

  function excerptScore(topicId) {
    let score = Number.POSITIVE_INFINITY;
    managedCards().forEach((card) => {
      if (card.dataset.topicId !== topicId) {
        return;
      }
      const focused = card.matches(":hover, :focus-within") || drawerHoldsCard(card);
      const rect = card.getBoundingClientRect();
      const value = focused ? 0
        : !card.hidden && rect.bottom > 0 && rect.top < window.innerHeight ? rect.top : rect.top + excerptOutOfViewScore;
      score = Math.min(score, value);
    });
    return score;
  }

  // requireAuthor：作者回退只在缓存条目确实带 author 时才算命中 —— storage 回填的正文条目没有作者，
  // 不能让它把作者请求挡掉（否则卡片直接显示作者不可用，不再走网络）。
  // requireCooked：抽屉要的是完整首帖；只有截断 markdown 的条目（长帖的 cooked 超过存储上限
  // 或老条目没存 cooked）不算命中，必须再发一次请求拿完整 cooked。
  function requestTopicMetadata(topicId, requireAuthor = false, requireCooked = false) {
    const cached = state.excerptCache.get(topicId);
    if (cached?.state === "ready" && (!requireAuthor || cached.author) && (!requireCooked || cached.cooked)) {
      return Promise.resolve(cached);
    }
    if (cached?.state === "failed") {
      return Promise.reject(cached.error);
    }
    if (cached?.state === "pending") {
      return cached.promise;
    }
    if (cached) {
      state.excerptCache.delete(topicId);
    }

    const promise = fetchTopicMetadata(topicId)
      .then((metadata) => {
        state.excerptCache.set(topicId, { state: "ready", ...metadata });
        return metadata;
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          state.excerptCache.delete(topicId);
        } else {
          state.excerptCache.set(topicId, { state: "failed", error });
        }
        throw error;
      });

    state.excerptCache.set(topicId, { state: "pending", promise });
    return promise;
  }

  async function requestExcerpt(topicId) {
    const key = `${config.excerptStoragePrefix}${location.hostname}.${topicId}`;
    try {
      const stored = (await storageGet([key]))[key];
      // 异常条目按未命中处理：savedAt 超前（时钟不对，会让 TTL 看起来永远没过期）；
      // 标成 ready 却连 text 与 markdown 都是空的（正常写入不会产生这种条目）。
      const savedAt = Number(stored?.savedAt);
      const savedAtValid = Number.isFinite(savedAt) && savedAt <= Date.now() + config.excerptSavedAtSkewMs;
      const contentValid = !(stored?.contentState === "ready" && !stored.text && !stored.markdown);
      if (stored && savedAtValid && contentValid
        && Date.now() - savedAt < config.excerptCacheTtlMs
        && typeof stored.markdown === "string" && typeof stored.text === "string"
        && ["ready", "empty"].includes(stored.contentState)) {
        // 抽屉只查内存 Map：storage 命中且内存里还没有该主题条目时回填（字段与网络路径一致）；
        // 只有写入时确实存下 cooked 的条目才有可用 cooked（老条目没有 cookedStored，按「无 cooked」处理，
        // 抽屉为此再请求一次拿完整正文）。已有条目不动，避免降级覆盖。
        if (!state.excerptCache.has(topicId)) {
          state.excerptCache.set(topicId, {
            state: "ready",
            text: stored.text,
            markdown: stored.markdown,
            contentState: stored.contentState,
            cooked: stored.cookedStored === true && typeof stored.cooked === "string" ? stored.cooked : ""
          });
        }
        return stored;
      }
    } catch (error) {
      console.error("[betterLD] excerpt cache read failed", error);
    }
    const metadata = await requestTopicMetadata(topicId);
    // 只持久化正文，缓存命中不能替代作者、活动时间或互动元数据。
    const { text, markdown, contentState, cooked } = metadata;
    state.excerptStorageChain = state.excerptStorageChain.then(async () => {
      const entry = { text, markdown, contentState, savedAt: Date.now() };
      // cooked 是原站生成并 sanitize 的 HTML，抽屉靠它保住图片/表格/details 等保真；太大就只留 markdown。
      // 存没存下 cooked 都显式记在条目上：抽屉据此判断要不要为完整正文再请求一次。
      if (cooked && cooked.length <= config.excerptCookedStorageLimit) {
        entry.cooked = cooked;
      }
      entry.cookedStored = typeof entry.cooked === "string";
      // 先淘汰再写入：配额满时写入会直接抛 QUOTA_BYTES，旧顺序（先写后淘汰）等于一次都没淘汰，
      // 新条目全丢、错误只进 console。淘汰的口径要含这条待写条目（名额与字节），否则写完就超上限。
      const entryBytes = utf8ByteLength(key) + utf8ByteLength(JSON.stringify(entry));
      await evictExcerptCache(key, entryBytes);
      try {
        await storageSet({ [key]: entry });
      } catch (error) {
        // 还是写不进（配额满/异常）就再淘汰一批重试一次，仍失败就只留内存，不把错误抛给调用方。
        // 追加淘汰按实际条目数丢最旧的一批：只下调条数上限时，条目少但体积大的缓存一个都删不掉，重试等于没做。
        console.warn("[betterLD] excerpt cache write retry", error);
        await evictExcerptCache(key, entryBytes, 0.25).catch(() => {});
        try {
          await storageSet({ [key]: entry });
        } catch (retryError) {
          console.warn("[betterLD] excerpt cache kept in memory only", retryError);
        }
      }
    }).catch((error) => console.error("[betterLD] excerpt cache write failed", error));
    return metadata;
  }

  // storage 配额按 UTF-8 字节计，而 String.length 数的是 UTF-16 码元：中文条目实际占用约为它的 3 倍，
  // 预算按 .length 算会让缓存实际超出配额。
  function utf8ByteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  // 正文缓存的淘汰：按 savedAt 从新到旧保留，超出条数上限、超出字节预算或已过 TTL 的条目删掉。
  // reserveKey/reserveBytes 是即将写入的那一条：它同样占一个名额与一份字节，先记进预算，写完才不会超上限。
  // 被淘汰条目的字节不计入保留预算，否则一个大项会连坐把它后面的健康小条目也一起删掉。
  // extraRatio 是写入失败后的追加淘汰比例：按实际条目数丢掉最旧的这一比例（条数上限式淘汰对
  // 「条目少但体积大」的缓存零作用，配额失败后必须有真正减少条目的动作）。
  async function evictExcerptCache(reserveKey = "", reserveBytes = 0, extraRatio = 0) {
    const stored = await storageGet(null);
    const entries = Object.entries(stored)
      .filter(([name]) => name.startsWith(config.excerptStoragePrefix) && name !== reserveKey)
      .sort((a, b) => (b[1]?.savedAt ?? 0) - (a[1]?.savedAt ?? 0));
    const quotaKeep = Math.max(config.excerptCacheMaxEntries - 1, 0);
    const ratioKeep = extraRatio > 0 ? Math.floor(entries.length * (1 - extraRatio)) : quotaKeep;
    const keepEntries = Math.min(quotaKeep, ratioKeep);
    let bytes = reserveBytes;
    const evicted = [];
    entries.forEach(([name, value], index) => {
      const size = utf8ByteLength(name) + utf8ByteLength(JSON.stringify(value));
      if (index >= keepEntries || bytes + size > config.excerptCacheByteBudget
        || Date.now() - (value?.savedAt ?? 0) >= config.excerptCacheTtlMs) {
        evicted.push(name);
        return;
      }
      bytes += size;
    });
    if (evicted.length) {
      await storageRemove(evicted);
    }
  }

  // 逐主题请求 /t/{id}.json 一屏就是几十个请求，会触发站点防护并连带把站点自己的分页请求挡成 429，
  // 而列表接口的每一页本来就已经被站点自己下载过一个（无限滚动 / 客户端路由），再取一遍等于把这份流量翻倍。
  // 所以列表元数据只从站点自己已有的数据里读：首屏读服务端预载，其余读原站当前列表路由的模型；
  // /t/{id}.json 只留给视口内卡片的正文预览。
  // 原站列表模型里的主题自带 creator（BasicUser）与活动时间；服务端预载的列表接口载荷没有这个字段，
  // 用 posters[0] + users 映射：Discourse 的 TopicPostersSummary 只把最新发帖人挪到末尾，所以 posters[0] 恒为创建者，
  // users 数组给出该 user_id 的 username，与 /t/{id}.json 的 details.created_by.username 同源。
  // 列表载荷里的统计字段与 /t/{id}.json 同构（posts_count/reply_count/like_count/views），直接复用 topicStats；
  // 参与者只能由 posters + users 合成（列表模型没有 details.participants），头像保留原样的 {size} 占位，
  // 由 setReadingParticipants 自己替换尺寸并做同源校验。
  // 列表里的正文文本实测普遍缺失（预载 0/30、路由模型 0/30），有则先用纯文本充数，没有就跳过。
  function topicListEntries(payload) {
    const users = new Map(
      (Array.isArray(payload?.users) ? payload.users : []).map((user) => [user.id, user])
    );
    return (Array.isArray(payload?.topic_list?.topics) ? payload.topic_list.topics : []).map((topic) => {
      const posters = Array.isArray(topic.posters) ? topic.posters : [];
      const seen = new Set();
      return {
        id: String(topic.id),
        author: (typeof topic.creator === "string" ? cleanText(topic.creator) : "")
          || cleanText(users.get(posters[0]?.user_id)?.username),
        activityAt: cleanText(topic.last_posted_at || topic.bumped_at || topic.created_at),
        excerpt: cleanText(topic.excerpt),
        stats: topicStats(topic),
        participants: posters
          .map((poster) => users.get(poster.user_id))
          .filter(Boolean)
          .map((user) => ({
            username: cleanText(user.username),
            avatarTemplate: String(user.avatar_template || "").trim()
          }))
          .filter((entry) => {
            if (!entry.avatarTemplate || seen.has(entry.avatarTemplate)) return false;
            seen.add(entry.avatarTemplate);
            return true;
          })
          .slice(0, 4),
        thumbnails: Array.isArray(topic.thumbnails) ? topic.thumbnails : []
      };
    });
  }

  function requestSiteTopicListPayload() {
    return loadPageRefreshBridge().then(() => new Promise((resolve) => {
      const id = crypto.randomUUID();
      const finish = (payload) => {
        window.clearTimeout(timer);
        document.removeEventListener("betterld:topic-list", onResult);
        resolve(payload);
      };
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id === id) {
          finish(result.payload || null);
        }
      };
      const timer = window.setTimeout(() => finish(null), config.siteTopicListTimeoutMs);
      document.addEventListener("betterld:topic-list", onResult);
      document.dispatchEvent(new CustomEvent("betterld:topic-list-request", { detail: JSON.stringify({ id }) }));
    })).catch((error) => {
      console.warn("[betterLD] 原站主题列表读取不可用", error);
      return null;
    });
  }

  function seedPreloadedTopicList() {
    if (state.preloadedTopicListSeeded) {
      return;
    }
    const node = document.getElementById("data-preloaded");
    if (!node?.textContent) {
      return;
    }
    state.preloadedTopicListSeeded = true;
    let entries;
    try {
      const preloaded = JSON.parse(node.textContent);
      if (!preloaded.topic_list) {
        return;
      }
      entries = topicListEntries(JSON.parse(preloaded.topic_list));
    } catch (error) {
      console.warn("[betterLD] 预载主题列表解析失败", error);
      return;
    }
    if (!entries.length) {
      return;
    }
    entries.forEach((entry) => state.topicListMetadata.set(entry.id, entry));
  }

  function managedCards() {
    return [...document.querySelectorAll('[data-betterld-grid="true"] > .betterld-topic-card')];
  }

  function applyTopicListMetadata(card) {
    const metadata = state.topicListMetadata.get(card.dataset.topicId);
    if (!metadata) {
      return false;
    }
    let applied = false;
    if (metadata.author) {
      setAuthor(card, metadata.author, "ready");
      applied = true;
    }
    // 活动时间与作者是否可用无关：缺作者但有 activityAt 时也要写入过滤用的数据集。
    if (metadata.activityAt) {
      setTopicActivity(card, metadata.activityAt);
      applied = true;
    }
    // 列表摘要只是先行层：先出纯文本，完整 Markdown 稍后按阅读优先级升级（setExcerpt 保证不降级）。
    if (metadata.excerpt) {
      setExcerpt(card, metadata.excerpt, "list");
      applied = true;
    }
    // 统计与参与者与作者是否可用无关；显示开关全关时不再填（与正文请求的闸口同一套开关）。
    if (state.currentSettings.showTopicExcerpt || state.currentSettings.showTopicMeta) {
      if (metadata.stats?.length) {
        setReadingStats(card, metadata.stats);
        applied = true;
      }
      if (metadata.participants?.length) {
        setReadingParticipants(card, metadata.participants);
        applied = true;
      }
    }
    return applied;
  }

  function applyTopicListMetadataToAll() {
    managedCards().forEach(applyTopicListMetadata);
  }

  function uncoveredTopicCards() {
    return managedCards().filter((card) => card.dataset.topicId && card.dataset.authorState === "loading");
  }

  // 站点自己已经为当前列表路由下载过主题数据（无限滚动 / 客户端路由切换），原站模型里就有，
  // 直接从那里读；读不到的主题（非列表路由、桥接不可用）才退回逐主题请求。
  async function syncTopicListMetadataFromSite() {
    const payload = await requestSiteTopicListPayload();
    if (!payload) {
      return;
    }
    const routeHref = location.href;
    const entries = topicListEntries(payload);
    if (!entries.length || location.href !== routeHref) {
      return;
    }
    entries.forEach((entry) => state.topicListMetadata.set(entry.id, entry));
    applyTopicListMetadataToAll();
  }

  function syncTopicListMetadata() {
    if (isSearchPage()) return;
    if (state.topicListSync) {
      state.topicListSyncAgain = true;
      return;
    }
    state.topicListSync = Promise.resolve()
      .then(async () => {
        if (!isTopicListPage() || state.currentSettings.topicListLayoutMode !== "reading") {
          return;
        }
        // 预载元素在文档末尾，注入过早时第一次读不到，这里补一次
        seedPreloadedTopicList();
        applyTopicListMetadataToAll();
        if (uncoveredTopicCards().length) {
          await syncTopicListMetadataFromSite();
        }
        // 原站列表数据覆盖不到的主题（非列表路由、创建者缺失等）退回逐主题请求
        uncoveredTopicCards().forEach(loadAuthor);
      })
      .catch((error) => {
        console.warn("[betterLD] 主题列表元数据同步失败", error);
      })
      .finally(() => {
        state.topicListSync = null;
        if (state.topicListSyncAgain) {
          state.topicListSyncAgain = false;
          syncTopicListMetadata();
        }
      });
  }

  // aria-busy 只反映真正在飞的请求：正文预览关闭时不会再有正文请求，卡片不该停在 busy。
  function cardBusy(card, excerptState) {
    const excerptName = excerptState ?? card.dataset.excerptState;
    return String(card.dataset.authorState === "loading"
      || (excerptName === "loading" && state.currentSettings.showTopicExcerpt));
  }

  function setTopicActivity(card, activityAt) {
    const timestamp = activityAt ? Date.parse(activityAt) : Number.NaN;
    card.dataset.filterActivity = Number.isFinite(timestamp) ? String(timestamp) : "";
    applyCardFilter(card);
  }

  function setAuthor(card, author, stateName) {
    const authorElement = card.querySelector(".betterld-topic-card__author");
    if (!authorElement) {
      return;
    }
    applyAuthorIdentity(authorElement, author);
    card.dataset.authorState = stateName;
    card.dataset.filterAuthor = stateName === "ready" ? author : "";
    applyCardFilter(card);
    const fallback = card.querySelector("[data-betterld-avatar-fallback=\"true\"]");
    if (fallback && author && stateName === "ready") {
      fallback.textContent = author.slice(0, 1).toUpperCase();
    }
    card.setAttribute("aria-busy", cardBusy(card));
  }

  function setReadingStats(card, stats) {
    const container = card.querySelector("[data-betterld-reading-stats]");
    if (!container) {
      return;
    }
    container.replaceChildren(...(Array.isArray(stats) ? stats : []).map((stat) => {
      const item = createElement("span", "betterld-topic-card__reading-stat");
      const icon = createElement("span", "betterld-topic-card__reading-stat-icon");
      const value = createElement("span", "betterld-topic-card__reading-stat-value", String(stat.value));
      item.dataset.betterldStat = stat.key;
      icon.dataset.betterldStatIcon = stat.icon;
      icon.setAttribute("aria-hidden", "true");
      item.setAttribute("aria-label", `${stat.label} ${stat.value}`);
      item.append(icon, value);
      return item;
    }));
    container.hidden = !container.childElementCount;
  }

  function setReadingParticipants(card, participants) {
    const container = card.querySelector("[data-betterld-reading-participants]");
    if (!container) {
      return;
    }
    const entries = (Array.isArray(participants) ? participants : [])
      .map((entry) => ({
        username: cleanText(entry?.username),
        url: safeSiteUrl(String(entry?.avatarTemplate || "").replace("{size}", "40"))
      }))
      .filter((entry) => entry.url);
    container.replaceChildren(...entries.map((entry) => {
      const avatar = createElement("span", "betterld-topic-card__avatar betterld-topic-card__participant");
      const image = document.createElement("img");
      image.src = entry.url;
      image.alt = "";
      image.loading = "lazy";
      if (entry.username) {
        image.title = entry.username;
      }
      avatar.append(image);
      return avatar;
    }));
    container.hidden = !container.childElementCount;
  }

  function setExcerpt(card, text, stateName, markdown) {
    const excerpt = card.querySelector(".betterld-topic-card__excerpt");
    if (!excerpt) {
      return;
    }
    // 正文状态单向前进（loading → list → ready）：已经升级到 Markdown 的卡片不再被列表摘要覆盖。
    if (stateName === "list" && card.dataset.excerptState !== "loading") {
      return;
    }
    if (stateName === "ready") {
      markdownApi.render(excerpt, markdown || text);
    } else {
      excerpt.textContent = text;
    }
    excerpt.dataset.state = stateName;
    card.dataset.excerptState = stateName;
    card.setAttribute("aria-busy", cardBusy(card, stateName));
  }

  // delayMs 默认是普通失败的重试间隔；站点在拦时的重排要等到冷却到期（传 0 表示冷却已到期、立刻重排）。
  function scheduleTopicMetadataRecovery(card, delayMs = config.topicRequestRecoveryDelayMs) {
    const recoveryCount = Number(card.dataset.topicRecoveryCount || 0);
    if (recoveryCount >= config.topicRequestRecoveryCount || !card.isConnected) {
      return;
    }
    card.dataset.topicRecoveryCount = String(recoveryCount + 1);
    window.setTimeout(() => {
      if (!card.isConnected || !card.dataset.topicId) {
        return;
      }
      const authorFailed = card.dataset.authorState === "failed";
      const excerptFailed = card.dataset.excerptState === "failed";
      if (!authorFailed && !excerptFailed) {
        return;
      }
      state.excerptCache.delete(card.dataset.topicId);
      if (authorFailed) {
        setAuthor(card, config.authorLoadingLabel, "loading");
      }
      if (excerptFailed) {
        setExcerpt(card, config.excerptLoadingLabel, "loading");
      }
      if (authorFailed) {
        loadAuthor(card);
      }
      if (excerptFailed) {
        loadExcerpt(card);
      }
    }, delayMs);
  }

  // 站点在拦时正文预览请求被拒（RateLimitError）：冷却期间不发任何新请求，
  // 到冷却到期时刻把当时视口内与视口下方一屏的卡重排一次；这条重排不走普通失败的重试配额，
  // 每轮冷却只排一次，其余卡滚动进视口时由观察者照常加载，不会无限重试。
  function scheduleExcerptThrottleRetry() {
    if (state.excerptThrottleRetryTimer) {
      return;
    }
    const remaining = state.metadataCooldownUntil - Date.now();
    if (remaining > 0) {
      armExcerptThrottleRetry(remaining);
    }
  }

  function armExcerptThrottleRetry(delayMs) {
    state.excerptThrottleRetryTimer = window.setTimeout(() => {
      state.excerptThrottleRetryTimer = 0;
      retryThrottledExcerpts();
    }, delayMs);
  }

  // 冷却到期：把因限速停在限速/失败文案上的卡整批复位，并重排一遍。
  // 限速不是普通失败：只清掉冷却期间留在缓存里的失败条目，正文复位也不受 topicRequestRecoveryCount 配额限制；
  // 每轮冷却只重排一次，天然有节流。立即排队的只有视口内与视口下方一屏，其余只复位状态并重新登记视口观察。
  function retryThrottledExcerpts() {
    // 冷却被延长（又撞了一次挑战），或定时器比到期时刻早了一拍落地（Date.now() 还没跨过到期时刻）：
    // 都不在冷却里重发，也不丢掉这次重排 —— 按剩余冷却（至少 1ms）再排一次。
    const remaining = state.metadataCooldownUntil - Date.now();
    if (remaining > 0) {
      armExcerptThrottleRetry(remaining + 1);
      return;
    }
    if (!state.currentSettings.showTopicExcerpt) {
      return;
    }
    managedCards().forEach((card) => {
      // 搜索卡永不被纳管（excerptLoadable 里唯一与滚动位置无关的一条）。
      if (card.dataset.betterldSearchResult === "true") {
        return;
      }
      const excerptState = card.dataset.excerptState;
      const authorFailed = card.dataset.authorState === "failed";
      // 只有正文本身没拿到（loading / failed）才重取；list 是升级到完整 Markdown，也进队列。
      const excerptRetry = excerptState === "failed" || excerptState === "loading";
      const excerptUpgrade = excerptState === "list";
      if (!excerptRetry && !excerptUpgrade && !authorFailed) {
        return;
      }
      // 冷却期间被拒的请求会在缓存里留下失败条目，不删的话重排会被缓存立刻拒绝；
      // ready 与 pending 条目保留（前者零请求命中，后者请求还在飞，删了会重复发）。
      if (state.excerptCache.get(card.dataset.topicId)?.state === "failed") {
        state.excerptCache.delete(card.dataset.topicId);
      }
      // 正文已经就绪的卡（含只有作者失败）不能被打回加载中：正文复位只对没拿到正文的 failed/loading 执行。
      if (excerptRetry) {
        setExcerpt(card, config.excerptLoadingLabel, "loading");
      }
      if (authorFailed) {
        setAuthor(card, config.authorLoadingLabel, "loading");
      }
      if (!excerptLoadable(card)) {
        // 被过滤掉的卡（隐藏 / 过滤待定）只复位状态：不排队、不登记观察。
        // 复位必须发生在这一层之前，否则冷却期间的 failed 会留在卡上，过滤解除时 observeExcerpt 不认 failed，卡永久停在文案上。
        // 待定筛选（作者规则命中但作者未知）必须有作者才能判定可见性：这里只把刚复位的失败作者放回作者队列，
        // 正文、搜索卡、无作者失败的卡与已确定 hidden 的卡都不受影响。
        if (authorFailed && card.dataset.filterState === "pending") {
          loadAuthor(card);
        }
        return;
      }
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight * 2) {
        // 加载完成后观察会被撤掉，不复登记的话这些卡滚回视口也不会再加载；这里只登记观察，不发请求。
        // 作者失败的卡正文可能已经就绪（excerptPending 为假），作者恢复同样只能靠观察者：滚回视口时由 scheduleExcerpt 补发。
        if (excerptPending(card) || card.dataset.authorState === "loading") {
          state.excerptObserver?.observe(card);
        }
        return;
      }
      // 下一屏的卡不在视口内，出队守卫只认预取候选，不标标记会被当成过期请求中止（标记由 finally 摘掉）。
      if (rect.top >= window.innerHeight && excerptPending(card)) {
        card.dataset.betterldExcerptPrefetch = "true";
      }
      // 两个加载函数自带状态守卫（作者只在 loading、正文只在 loading/list），不需要在这里再判一次。
      loadAuthor(card);
      loadExcerpt(card);
    });
  }

  function loadAuthor(card) {
    if (card.dataset.authorState !== "loading" || !card.dataset.topicId) {
      return;
    }

    const topicId = card.dataset.topicId;
    requestTopicMetadata(topicId, true)
      .then((metadata) => {
        if (!metadata.author) {
          throw new Error("topic creator username unavailable");
        }
        setAuthor(card, metadata.author, "ready");
        setTopicActivity(card, metadata.activityAt);
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          return;
        }
        if (error.name === "RateLimitError" || state.metadataCooldownUntil > Date.now()) {
          // 站点在拦：作者回退与正文预览共用 /t/ 端点，同样不烧重试预算，
          // 由正文预览那条路在冷却到期时统一重排（author + excerpt 一起）。
          // 触发挑战的那一张卡的错误来自请求本身，用冷却状态一并识别。
          setAuthor(card, config.authorPlaceholder, "failed");
          scheduleExcerptThrottleRetry();
          return;
        }
        console.warn(`[betterLD] topic creator unavailable for topic ${topicId}`, error);
        setAuthor(card, config.authorPlaceholder, "failed");
        scheduleTopicMetadataRecovery(card);
      });
  }

  // 正文预览关闭后不再发任何正文请求；元信息（统计/参与者）已由列表载荷零请求补齐。
  function loadExcerpt(card) {
    if (!state.currentSettings.showTopicExcerpt || !excerptPending(card) || !card.dataset.topicId) {
      return;
    }

    const topicId = card.dataset.topicId;
    requestExcerpt(topicId)
      .then((metadata) => {
        setExcerpt(card, metadata.text, metadata.contentState, metadata.markdown);
        // 纯文本端点不带统计/参与者，空集合不能把列表载荷已经填好的内容清掉。
        if (metadata.stats?.length) setReadingStats(card, metadata.stats);
        if (metadata.participants?.length) setReadingParticipants(card, metadata.participants);
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          if (card.isConnected) {
            observeExcerpt(card);
          }
          return;
        }
        if (error.name === "RateLimitError" || state.metadataCooldownUntil > Date.now()) {
          // 站点在拦：冷却期间不发新请求，并安排在冷却到期时重排一次。
          // 触发挑战的那一张卡的错误来自请求本身（不是队列拒绝），用冷却状态一并识别。
          // 已有列表摘要的卡保留自己的文字与状态：升级失败不该把看得见的摘要换成限速文案。
          if (card.dataset.excerptState !== "list") {
            setExcerpt(card, config.excerptThrottledLabel, "failed");
          }
          scheduleExcerptThrottleRetry();
          return;
        }
        console.warn(`[betterLD] topic excerpt unavailable for topic ${topicId}`, error);
        setExcerpt(card, config.excerptPlaceholder, "failed");
        scheduleTopicMetadataRecovery(card);
      })
      .finally(() => {
        delete card.dataset.betterldExcerptPrefetch;
      });
  }

  // 快速滚动时卡片只是一闪而过，给它们请求正文预览既拖慢真正在看的那几张，
  // 又会把一屏几十个请求打给站点（站点限速是按 IP 累计的，会连带把站点自己的分页请求挡成 429）。
  // 所以滚动期间不排队，等页面停住后再为当时可见的卡片请求正文预览。
  function deferExcerptLoads() {
    if (!state.excerptVisible.size) return;
    state.excerptVisible.forEach((card) => cancelExcerpt(card));
    window.clearTimeout(state.excerptIdleTimer);
    state.excerptIdleTimer = window.setTimeout(() => {
      state.excerptVisible.forEach((card) => {
        if (card.isConnected) scheduleExcerpt(card);
      });
    }, config.excerptScrollIdleMs);
  }

  function scheduleExcerptPrefetch(delayMs = config.excerptPrefetchIdleMs) {
    window.clearTimeout(state.excerptPrefetchTimer);
    state.excerptPrefetchTimer = window.setTimeout(prefetchExcerpts, delayMs);
  }

  // 令牌桶有额度却空转等于白等：页面已经停住、队列里又没有视口内的预览请求时，
  // 把视口下方一屏内的卡片提前排上 —— 总量不变，只是把接下来要读的那几张提前发出去。
  // 因令牌桶/队列条件而放弃时要再排一次，否则没有滚动事件的页面（或排空瞬间恰好没令牌）就再也等不到预取。
  function prefetchExcerpts() {
    state.excerptPrefetchTimer = 0;
    if (!state.currentSettings.showTopicExcerpt || state.metadataCooldownUntil > Date.now()) {
      return;
    }
    if (Date.now() - state.excerptLastScrollAt < config.excerptPrefetchIdleMs) {
      return;
    }
    const candidates = managedCards()
      .filter((card) => card.dataset.excerptState === "loading" && excerptLoadable(card))
      .map((card) => ({ card, top: card.getBoundingClientRect().top }))
      .filter(({ top }) => top >= window.innerHeight && top < window.innerHeight * 2)
      .sort((a, b) => a.top - b.top)
      .slice(0, config.excerptPrefetchCount);
    // 没有可预取的卡就直接停，不再排下一次（否则变成每 2.5s 空扫一遍）。
    if (!candidates.length) {
      return;
    }
    if (state.metadataQueue.some((entry) => entry.isExcerpt && entry.score() < excerptOutOfViewScore)) {
      scheduleExcerptPrefetch();
      return;
    }
    if (state.excerptTokens < 1) {
      // 令牌只在出队时补充：这里主动补算一次，并把下一次预取对齐到令牌可用时刻，而不是固定 2.5s 空转。
      const wait = excerptTokenWait(Date.now());
      if (wait > 0) {
        scheduleExcerptPrefetch(Math.max(wait - Date.now(), 0));
        return;
      }
    }
    candidates.forEach(({ card }) => {
      card.dataset.betterldExcerptPrefetch = "true";
      loadExcerpt(card);
    });
  }

  // 正文还没有最终正文（loading）或只有列表摘要（list）时都还需要一次升级请求。
  function excerptPending(card) {
    const stateName = card.dataset.excerptState;
    return stateName === "loading" || stateName === "list";
  }

  // 搜索卡、隐藏卡与过滤掉的卡不请求正文（与 observeExcerpt 同一套条件）。
  function excerptLoadable(card) {
    return card.dataset.betterldSearchResult !== "true"
      && !card.hidden
      && card.dataset.filterState !== "hidden"
      && card.dataset.filterState !== "pending";
  }

  // 预取的卡在出队时用同一条「还是预取候选」标准重新判定（不能复用只认视口内那套）：
  // 设置仍开、卡仍待补正文、没被过滤/隐藏（与 excerptLoadable 同一套条件，不另写一份）、
  // 并且仍在「视口下方一屏内」；滚进视口后由 isNeeded 的视口分支接管。
  function prefetchNeeded(card) {
    if (card.dataset.betterldExcerptPrefetch !== "true" || !state.currentSettings.showTopicExcerpt) {
      return false;
    }
    if (!excerptLoadable(card)) {
      return false;
    }
    const rect = card.getBoundingClientRect();
    return excerptPending(card) && rect.top >= window.innerHeight && rect.top < window.innerHeight * 2;
  }

  // 首屏最上面的几张卡几乎必然正在被读：卡片建好后不等滚动停住门（excerptScrollIdleMs / excerptDwellMs），
  // 直接占用突发额度先发请求。预算按「一次列表重建 / 一次路由切换」重置，不是每卡一次性标记。
  function primeExcerpts() {
    if (!state.currentSettings.showTopicExcerpt || state.excerptPrimeBudget <= 0) {
      return;
    }
    const primed = managedCards()
      .filter((card) => !card.dataset.betterldExcerptPrimed
        && card.dataset.excerptState === "loading"
        && excerptLoadable(card))
      .map((card) => ({ card, rect: card.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight)
      .sort((a, b) => a.rect.top - b.rect.top)
      .slice(0, state.excerptPrimeBudget);
    state.excerptPrimeBudget -= primed.length;
    primed.forEach(({ card }) => {
      card.dataset.betterldExcerptPrimed = "true";
      loadExcerpt(card);
    });
  }

  // 正文待补（loading/list）或作者仍在加载的卡都还需要一次请求：
  // 作者恢复没有独立的观察通路，靠这条视口路径在滚回时补发（两个加载函数各自守着自己的状态）。
  function scheduleExcerpt(card) {
    if (card.dataset.betterldExcerptTimer
      || (!excerptPending(card) && card.dataset.authorState !== "loading")) {
      return;
    }
    card.dataset.betterldExcerptTimer = String(window.setTimeout(() => {
      delete card.dataset.betterldExcerptTimer;
      state.excerptVisible.delete(card);
      loadAuthor(card);
      loadExcerpt(card);
      state.excerptObserver?.unobserve(card);
    }, config.excerptDwellMs));
  }

  function cancelExcerpt(card) {
    const timer = Number(card.dataset.betterldExcerptTimer);
    if (!timer) {
      return;
    }
    window.clearTimeout(timer);
    delete card.dataset.betterldExcerptTimer;
  }

  function observeExcerpt(card) {
    // 列表载荷已经给出作者/统计/参与者，正文预览不再为元信息发请求；
    // 关闭正文预览时整条正文通路不启动，列表页也就不再发 /t/*.json 预览请求。
    // 但 createCard 写死的加载文案不能留在正文区：这里清空它、撤掉观察与待发计时（状态仍是 loading，
    // 不是失败），等开关重新打开时由 syncManagedCardContent → observeExcerpt 重新排队。
    if (!state.currentSettings.showTopicExcerpt) {
      cancelExcerpt(card);
      state.excerptObserver?.unobserve(card);
      state.excerptVisible.delete(card);
      const excerpt = card.querySelector(".betterld-topic-card__excerpt");
      if (card.dataset.excerptState === "loading" && excerpt?.dataset.state === "loading") {
        excerpt.textContent = "";
      }
      return;
    }
    if (!excerptLoadable(card)) {
      return;
    }
    // 站点在拦：请求发不出去（队列里也会被拒），先直接显示真实原因，不排队、不假加载。
    // 仍登记观察：冷却到期后由 retryThrottledExcerpts 重排，滚动进视口的卡也照常走 loadExcerpt。
    if (state.metadataCooldownUntil > Date.now()) {
      applyExcerptThrottleNotice(card);
    }
    if (state.excerptObserver) {
      state.excerptObserver.observe(card);
      return;
    }
    loadExcerpt(card);
  }

  function observeCard(card) {
    applyCardFilter(card);
    if (card.dataset.betterldSearchResult === "true" || !card.dataset.topicId) {
      return;
    }
    applyTopicListMetadata(card);
    observeExcerpt(card);
  }

  function resetFilterOverrides(settings) {
    const signature = JSON.stringify([
      settings.topicFilterEnabled,
      settings.topicFilterMode,
      settings.topicFilterMatchMode,
      settings.topicFilterMaxAgeDays,
      settings.topicFilterHideLv1,
      settings.topicFilterHideLv2,
      settings.topicFilterHideLv3,
      settings.topicFilterBinEnabled,
      settings.topicTitleRules,
      settings.topicCategoryRules,
      settings.topicTagRules,
      settings.topicAuthorRules,
      settings.topicWhitelistRules
    ]);
    if (signature === state.filterSignature) {
      return;
    }
    // 规则集变化后，上一轮的「已还原」不再成立
    state.filterSignature = signature;
    document.querySelectorAll(".betterld-topic-card[data-filter-override]").forEach((card) => {
      delete card.dataset.filterOverride;
    });
  }

  function updateSearchCard(card, item) {
    card.dataset.betterldSearchResult = "true";
    const author = authorName(item);
    const authorState = author === config.authorLoadingLabel ? "failed" : "ready";
    if (card.dataset.authorState !== authorState || (authorState === "ready" && card.dataset.filterAuthor !== author)) {
      setAuthor(card, author, authorState);
    }
    const excerpt = card.querySelector(".betterld-topic-card__excerpt");
    const text = cleanText(item.querySelector(".blurb")?.textContent);
    if (excerpt.textContent !== text) excerpt.textContent = text;
    excerpt.dataset.state = text ? "ready" : "empty";
    card.dataset.excerptState = excerpt.dataset.state;
    const date = item.querySelector("[data-time], time[datetime]");
    const timestamp = Number(date?.dataset.time);
    const activityAt = date?.getAttribute("datetime") || (Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "");
    const activity = Date.parse(activityAt);
    if (card.dataset.filterActivity !== (Number.isFinite(activity) ? String(activity) : "")) setTopicActivity(card, activityAt);
    card.setAttribute("aria-busy", "false");
  }

  function syncManagedCardContent() {
    document.querySelectorAll('[data-betterld-grid="true"] .betterld-topic-card').forEach((card) => {
      applyCardFilter(card);
      if (card.dataset.betterldSearchResult !== "true") {
        applyTopicListMetadata(card);
        observeExcerpt(card);
      }
      card.setAttribute("aria-busy", cardBusy(card));
    });
    document.querySelectorAll('[data-betterld-grid="true"]').forEach(syncFilterEmptyState);
    syncTopicListMetadata();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function filterRuleMatches(value, rules, matchMode) {
    const text = cleanText(value);
    if (!text || !rules.length) {
      return false;
    }
    const lower = text.toLocaleLowerCase();
    return rules.some((rule) => {
      const keyword = cleanText(rule.keyword);
      if (!keyword) {
        return false;
      }
      if (matchMode === "regex") {
        try {
          return new RegExp(keyword, "iu").test(text);
        } catch (error) {
          console.warn("[betterLD] 过滤规则不是合法正则，已忽略", keyword, error);
          return false;
        }
      }
      if (matchMode === "whole") {
        return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, "iu").test(text);
      }
      return lower.includes(keyword.toLocaleLowerCase());
    });
  }

  function topicFilterSettings() {
    const levels = [];
    if (state.currentSettings.topicFilterHideLv1 === true) {
      levels.push(1);
    }
    if (state.currentSettings.topicFilterHideLv2 === true) {
      levels.push(2);
    }
    if (state.currentSettings.topicFilterHideLv3 === true) {
      levels.push(3);
    }
    return {
      enabled: state.currentSettings.topicFilterEnabled === true,
      mode: state.currentSettings.topicFilterMode,
      matchMode: state.currentSettings.topicFilterMatchMode,
      maxAgeDays: Number(state.currentSettings.topicFilterMaxAgeDays) || 0,
      hideLevels: levels,
      binEnabled: state.currentSettings.topicFilterBinEnabled !== false,
      titleRules: state.currentSettings.topicTitleRules || [],
      authorRules: state.currentSettings.topicAuthorRules || [],
      categoryRules: state.currentSettings.topicCategoryRules || [],
      tagRules: state.currentSettings.topicTagRules || [],
      whitelistRules: state.currentSettings.topicWhitelistRules || []
    };
  }

  function filterMatchesWhitelist(settings, title, category, tags, author) {
    return filterRuleMatches(title, settings.whitelistRules, settings.matchMode)
      || filterRuleMatches(category, settings.whitelistRules, settings.matchMode)
      || filterRuleMatches(tags, settings.whitelistRules, settings.matchMode)
      || filterRuleMatches(author, settings.whitelistRules, settings.matchMode);
  }

  function cardFilterVerdict(card, settings) {
    const authorKnown = card.dataset.authorState !== "loading";
    const titleMatch = filterRuleMatches(card.dataset.filterTitle, settings.titleRules, settings.matchMode);
    const categoryMatch = filterRuleMatches(card.dataset.filterCategory, settings.categoryRules, settings.matchMode);
    const tagMatch = filterRuleMatches(card.dataset.filterTags, settings.tagRules, settings.matchMode);
    const authorMatch = authorKnown && filterRuleMatches(card.dataset.filterAuthor, settings.authorRules, settings.matchMode);
    const domMatch = titleMatch || categoryMatch || tagMatch;
    const levelMatch = settings.hideLevels.includes(Number(card.dataset.filterLevel || 0));
    const activity = Number(card.dataset.filterActivity || 0);
    const ageMatch = settings.maxAgeDays > 0 && activity > 0 && Date.now() - activity > settings.maxAgeDays * 86400000;
    const whitelisted = filterMatchesWhitelist(
      settings,
      card.dataset.filterTitle,
      card.dataset.filterCategory,
      card.dataset.filterTags,
      authorKnown ? card.dataset.filterAuthor : ""
    );
    const pending = (settings.authorRules.length > 0 && !authorKnown && !domMatch)
      || (settings.maxAgeDays > 0 && activity === 0);
    return { match: domMatch || authorMatch || levelMatch || ageMatch, pending, whitelisted };
  }

  function itemPassesDomFilter(item) {
    const settings = topicFilterSettings();
    // 淡化与高亮模式不隐藏卡片；启用垃圾桶时保留卡片，否则命中项在列表里无法还原
    if (!settings.enabled || settings.mode !== "hide" || settings.binEnabled) {
      return true;
    }
    const title = topicInfo(item)?.title;
    const category = categoryInfo(item).name;
    const tags = topicTags(item, category).join(" ");
    if (filterMatchesWhitelist(settings, title, category, tags, "")) {
      return true;
    }
    const titleMatch = filterRuleMatches(title, settings.titleRules, settings.matchMode);
    const categoryMatch = filterRuleMatches(category, settings.categoryRules, settings.matchMode);
    const tagMatch = filterRuleMatches(tags, settings.tagRules, settings.matchMode);
    if (!settings.titleRules.length && !settings.categoryRules.length && !settings.tagRules.length) {
      return true;
    }
    return !titleMatch && !categoryMatch && !tagMatch && !settings.hideLevels.length;
  }

  function ruleMatchRanges(value, rules, matchMode) {
    const text = cleanText(value);
    const ranges = [];
    if (!text) {
      return ranges;
    }
    rules.forEach((rule) => {
      const keyword = cleanText(rule.keyword);
      if (!keyword) {
        return;
      }
      if (matchMode === "regex" || matchMode === "whole") {
        const source = matchMode === "regex" ? keyword : `(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`;
        let pattern;
        try {
          pattern = new RegExp(source, "giu");
        } catch (error) {
          console.warn("[betterLD] 过滤规则不是合法正则，已忽略", keyword, error);
          return;
        }
        for (const matched of text.matchAll(pattern)) {
          if (matched[0]) {
            ranges.push([matched.index, matched.index + matched[0].length]);
          }
        }
        return;
      }
      const lower = text.toLocaleLowerCase();
      const needle = keyword.toLocaleLowerCase();
      let index = lower.indexOf(needle);
      while (index >= 0) {
        ranges.push([index, index + needle.length]);
        index = lower.indexOf(needle, index + needle.length);
      }
    });
    return ranges.sort((left, right) => left[0] - right[0]);
  }

  function mergeRanges(ranges) {
    const merged = [];
    ranges.forEach(([start, end]) => {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
        return;
      }
      merged.push([start, end]);
    });
    return merged;
  }

  function applyTitleHighlight(card, settings) {
    const titleElement = card.querySelector(".betterld-topic-card__title");
    if (!titleElement) {
      return;
    }
    const text = card.dataset.filterTitle || "";
    const ranges = settings ? mergeRanges(ruleMatchRanges(text, settings.titleRules, settings.matchMode)) : [];
    if (!ranges.length) {
      if (titleElement.dataset.betterldHighlight === "true") {
        titleElement.textContent = text;
        delete titleElement.dataset.betterldHighlight;
      }
      return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    ranges.forEach(([start, end]) => {
      if (start > cursor) {
        fragment.append(text.slice(cursor, start));
      }
      fragment.append(createElement("mark", "betterld-topic-card__hit", text.slice(start, end)));
      cursor = end;
    });
    if (cursor < text.length) {
      fragment.append(text.slice(cursor));
    }
    titleElement.replaceChildren(fragment);
    titleElement.dataset.betterldHighlight = "true";
  }

  function applyChipHighlights(card, settings) {
    card.querySelectorAll(".betterld-topic-card__tag").forEach((tag) => {
      const name = cleanText(tag.textContent).replace(/^#/, "");
      const hit = Boolean(settings) && filterRuleMatches(name, settings.tagRules, settings.matchMode);
      tag.dataset.filterHit = hit ? "true" : "false";
    });
    const chip = card.querySelector(".betterld-topic-card__chip");
    if (chip) {
      const hit = Boolean(settings) && filterRuleMatches(chip.textContent, settings.categoryRules, settings.matchMode);
      chip.dataset.filterHit = hit ? "true" : "false";
    }
  }

  function updateFilterBin(card, hidden, settings) {
    if (hidden && settings.enabled && settings.binEnabled) {
      state.filterBin.add(card);
    } else {
      state.filterBin.delete(card);
    }
    scheduleFilterBinRender();
  }

  function scheduleFilterBinRender() {
    if (state.filterBinFrame) {
      return;
    }
    state.filterBinFrame = window.requestAnimationFrame(() => {
      state.filterBinFrame = 0;
      renderFilterBin();
    });
  }

  function restoreFilteredCard(card) {
    card.dataset.filterOverride = "visible";
    applyCardFilter(card);
    showActionStatus("已还原该主题", "success");
  }

  function ensureFilterBinHost() {
    if (state.filterBinHost) {
      return state.filterBinHost;
    }
    const host = createElement("div", "betterld-filter-bin");
    host.dataset.betterldFilterBin = "true";
    const trigger = createElement("button", "betterld-filter-bin__trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    const label = createElement("span", "betterld-filter-bin__label", "已过滤");
    const count = createElement("span", "betterld-filter-bin__count", "0");
    trigger.append(label, count);
    const panel = createElement("div", "betterld-filter-bin__panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "已过滤的主题");
    const title = createElement("p", "betterld-filter-bin__title");
    const list = createElement("ul", "betterld-filter-bin__list");
    const restoreAll = createElement("button", "betterld-filter-bin__action", "全部还原");
    restoreAll.type = "button";
    restoreAll.addEventListener("click", () => {
      [...state.filterBin].forEach((card) => {
        card.dataset.filterOverride = "visible";
        applyCardFilter(card);
      });
      showActionStatus("已还原本页全部过滤项", "success");
    });
    panel.append(title, list, restoreAll);
    trigger.addEventListener("click", () => {
      state.filterBinOpen = !state.filterBinOpen;
      renderFilterBin();
    });
    host.append(trigger, panel);
    document.body.append(host);
    state.filterBinHost = host;
    return host;
  }

  function renderFilterBin() {
    [...state.filterBin].forEach((card) => {
      if (!card.isConnected) {
        state.filterBin.delete(card);
      }
    });
    if (!state.filterBin.size) {
      state.filterBinHost?.remove();
      state.filterBinHost = null;
      state.filterBinOpen = false;
      return;
    }
    const host = ensureFilterBinHost();
    const count = String(state.filterBin.size);
    host.dataset.open = state.filterBinOpen ? "true" : "false";
    host.querySelector(".betterld-filter-bin__count").textContent = count;
    host.querySelector(".betterld-filter-bin__trigger").setAttribute("aria-expanded", String(state.filterBinOpen));
    host.querySelector(".betterld-filter-bin__title").textContent = `本页已过滤 ${count} 个主题`;
    host.querySelector(".betterld-filter-bin__list").replaceChildren(...[...state.filterBin].map((card) => {
      const item = createElement("li", "betterld-filter-bin__item");
      const text = createElement("span", "betterld-filter-bin__item-title", card.dataset.filterTitle || "未命名主题");
      const button = createElement("button", "betterld-filter-bin__action", "还原");
      button.type = "button";
      button.addEventListener("click", () => restoreFilteredCard(card));
      item.append(text, button);
      return item;
    }));
  }

  function applyCardFilter(card) {
    const settings = topicFilterSettings();
    if (!settings.enabled) {
      card.hidden = false;
      card.dataset.filterState = "visible";
      applyTitleHighlight(card, null);
      applyChipHighlights(card, null);
      updateFilterBin(card, false, settings);
      return true;
    }
    const verdict = cardFilterVerdict(card, settings);
    const restored = card.dataset.filterOverride === "visible";
    let visible;
    let filterState;
    if (restored || verdict.whitelisted) {
      visible = true;
      filterState = "visible";
    } else if (settings.mode === "include") {
      visible = verdict.match;
      filterState = visible ? "visible" : "hidden";
    } else if (settings.mode === "dim") {
      visible = true;
      filterState = verdict.pending ? "pending" : (verdict.match ? "dimmed" : "visible");
    } else if (settings.mode === "highlight") {
      visible = true;
      filterState = verdict.pending ? "pending" : (verdict.match ? "highlight" : "visible");
    } else {
      visible = !verdict.match && !verdict.pending;
      filterState = verdict.pending ? "pending" : (visible ? "visible" : "hidden");
    }
    card.hidden = !visible;
    card.dataset.filterState = filterState;
    applyTitleHighlight(card, filterState === "highlight" ? settings : null);
    applyChipHighlights(card, filterState === "highlight" ? settings : null);
    updateFilterBin(card, !visible, settings);
    if (visible) {
      observeExcerpt(card);
    }
    const grid = card.closest("[data-betterld-grid=\"true\"]");
    if (grid) {
      syncFilterEmptyState(grid);
    }
    return visible;
  }

  function disableTopicFilter() {
    const settings = normalizeSettings({ ...state.currentSettings, topicFilterEnabled: false });
    storageSet({ [config.storageKey]: settings })
      .then(() => showActionStatus("主题过滤已关闭", "success"))
      .catch((error) => showActionStatus(error instanceof Error ? error.message : "主题过滤关闭失败"));
  }

  function syncFilterEmptyState(grid) {
    const settings = topicFilterSettings();
    const cards = [...grid.querySelectorAll(":scope > .betterld-topic-card")];
    const visible = cards.some((card) => !card.hidden);
    const pending = cards.some((card) => card.dataset.filterState === "pending");
    let empty = grid.querySelector(":scope > .betterld-topic-empty");
    if (!settings.enabled || visible || pending || (!cards.length && grid.dataset.betterldFilterEmpty !== "true")) {
      empty?.remove();
      delete grid.dataset.betterldFilterEmpty;
      return;
    }
    if (!empty) {
      empty = createElement("section", "betterld-topic-empty");
      empty.setAttribute("role", "status");
      const title = createElement("strong", "betterld-topic-empty__title", "没有符合过滤条件的主题");
      const description = createElement("span", "betterld-topic-empty__description", "过滤只影响 betterLD 卡片，原始主题列表仍保留在页面中。");
      const button = createElement("button", "betterld-topic-empty__button", "关闭主题过滤");
      button.type = "button";
      button.addEventListener("click", disableTopicFilter);
      empty.append(title, description, button);
      grid.append(empty);
    }
    grid.dataset.betterldFilterEmpty = "true";
  }

  function topicContainers() {
    const root = mainRoot();
    if (!root) {
      return [];
    }

    if (isSearchPage()) {
      return [...root.querySelectorAll(".fps-result-entries")].map((container) =>
        [container, [...container.querySelectorAll(".fps-result")]]);
    }
    const groups = new Map();
    const items = root.querySelectorAll(".topic-list-item, .latest-topic-list-item");
    for (const item of items) {
      if (item.closest('[data-betterld-grid="true"]')) {
        continue;
      }
      const container = item.closest("table.topic-list, .latest-topic-list, .topic-list");
      if (!container || !root.contains(container)) {
        continue;
      }
      if (!groups.has(container)) {
        groups.set(container, []);
      }
      groups.get(container).push(item);
    }
    return [...groups.entries()];
  }

  function unobserveGrid(grid) {
    grid.querySelectorAll(".betterld-topic-card").forEach((card) => {
      state.excerptVisible.delete(card);
      cancelExcerpt(card);
      state.excerptObserver?.unobserve(card);
    });
  }

  function removeGridElement(grid) {
    unobserveGrid(grid);
    grid.remove();
    for (const [container, managedGrid] of state.managedSources) {
      if (managedGrid === grid) {
        state.managedSources.delete(container);
      }
    }
  }

  function managedGrid(container) {
    const trackedGrid = state.managedSources.get(container);
    if (trackedGrid) {
      return trackedGrid;
    }

    const adjacentGrid = container.nextElementSibling;
    if (adjacentGrid?.dataset.betterldGrid === "true") {
      state.managedSources.set(container, adjacentGrid);
      return adjacentGrid;
    }
    return null;
  }

  function removeGrid(container) {
    const grid = managedGrid(container);
    if (grid) {
      removeGridElement(grid);
    }
  }

  function restoreContainer(container) {
    removeGrid(container);
    const sourceBody = container.querySelector('[data-betterld-source-body="true"]');
    if (sourceBody) {
      sourceBody.hidden = sourceBody.dataset.betterldWasHidden === "true";
      delete sourceBody.dataset.betterldSourceBody;
      delete sourceBody.dataset.betterldWasHidden;
    }
    const originallyHidden = container.dataset.betterldWasHidden === "true";
    container.hidden = originallyHidden;
    delete container.dataset.betterldSource;
    delete container.dataset.betterldWasHidden;
  }

  function restoreAll() {
    [...state.managedSources.keys()].forEach((container) => restoreContainer(container));
    document.querySelectorAll('[data-betterld-source="true"]').forEach((container) => restoreContainer(container));
    document.querySelectorAll('[data-betterld-grid="true"]').forEach((grid) => removeGridElement(grid));
  }

  function navigationItemId(link) {
    try {
      const path = new URL(link.href, location.href).pathname.replace(/\/+$/, "") || "/";
      if (path === "/" || path.startsWith("/latest")) return "latest";
      if (path.startsWith("/new")) return "new";
      if (path.startsWith("/unread")) return "unread";
      if (path.startsWith("/unseen")) return "unseen";
      if (path.startsWith("/hot")) return "hot";
      if (path.startsWith("/top")) return "top";
      if (path.startsWith("/posted")) return "posted";
      if (path.startsWith("/read")) return "read";
      if (path.startsWith("/bookmarks")) return "bookmarks";
      if (path === "/categories") return "categories";
    } catch {
      return "";
    }
    return "";
  }

  // 打开方式的细分取值：background 用后台标签页，两个条件取值只在跳离首页时开新标签页
  function linkOpenBehavior(mode) {
    if (mode === "background" || mode === "newTab") {
      return mode;
    }
    if (mode === "currentTabIfHomepage") {
      return isHomepage() ? "currentTab" : "newTab";
    }
    if (mode === "currentTabIfNotHomepage") {
      return isHomepage() ? "newTab" : "currentTab";
    }
    return "currentTab";
  }

  function openConfiguredLink(event, mode) {
    // 修饰键点击保持浏览器原生行为（新标签页 / 新窗口 / 下载）
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const behavior = linkOpenBehavior(mode);
    if (behavior === "currentTab") {
      return;
    }
    const target = safeSiteUrl(event.currentTarget.href);
    if (!target) {
      return;
    }
    event.preventDefault();
    if (behavior === "background") {
      openBackgroundLink(target)
        .then(() => showActionStatus("已在后台标签页打开", "success"))
        .catch((error) => showActionStatus(error instanceof Error ? error.message : "后台标签页打开失败"));
      return;
    }
    const opened = globalThis.open(target, "_blank", "noopener,noreferrer");
    if (!opened) {
      showActionStatus("新标签页打开被浏览器阻止");
    }
  }

  function handleNavigationClick(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    openConfiguredLink(event, state.currentSettings.navigationOpenMode);
  }

  function syncNavigationSettings() {
    const navigation = document.querySelector("#navigation-bar.nav.nav-pills");
    if (!navigation) {
      return;
    }
    const settings = state.currentSettings;
    const root = document.documentElement;
    root.dataset.betterldNavigationAlignment = settings.topicNavigationAlignment;
    root.dataset.betterldNavigationSticky = String(settings.topicNavigationSticky);
    root.dataset.betterldNavigationCounts = String(settings.showTopicNavigationCounts);
    const configured = Array.isArray(settings.topicNavigationConfig) ? settings.topicNavigationConfig : [];
    const byId = new Map(configured.map((entry) => [entry.id, entry]));
    const items = [...navigation.querySelectorAll("a[href]")]
      .map((link) => ({ link, id: navigationItemId(link), item: link.closest("li") }))
      .filter(({ id, item }) => id && item);
    let visibleCount = 0;
    items.forEach(({ link, id, item }) => {
      const entry = byId.get(id);
      const visible = entry?.visible !== false;
      item.dataset.betterldNavigationItem = id;
      item.hidden = !visible;
      item.style.order = String(entry?.order ?? 999);
      if (visible) {
        visibleCount += 1;
      }
      if (!link.dataset.betterldNavigationAriaLabel) {
        link.setAttribute("aria-label", link.textContent.trim());
        link.dataset.betterldNavigationAriaLabel = "true";
      }
      if (!link.dataset.betterldNavigationHandler) {
        link.addEventListener("click", handleNavigationClick);
        link.dataset.betterldNavigationHandler = "true";
      }
      link.querySelectorAll(".badge-notification, .topic-list-data, .count").forEach((count) => {
        count.dataset.betterldNavigationCount = "true";
      });
    });
    if (visibleCount === 0 && items[0]) {
      items[0].item.hidden = false;
    }
  }

  function handleConfiguredLinkClick(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    openConfiguredLink(event, event.currentTarget.dataset.betterldLinkOpenMode);
  }

  function syncConfiguredLinkModes() {
    const settings = state.currentSettings;
    const selectors = [
      [`a[href^="/search"], a[href*="/search?"]`, settings.searchOpenMode],
      [`a[href*="/notifications"], .notifications-dropdown a[href], .user-menu a[href]`, settings.notificationOpenMode === "newTab" ? "newTab" : "currentTab"]
    ];
    selectors.forEach(([selector, mode]) => {
      document.querySelectorAll(selector).forEach((link) => {
        if (!link.dataset.betterldLinkOpenHandler) {
          link.addEventListener("click", handleConfiguredLinkClick);
          link.dataset.betterldLinkOpenHandler = "true";
        }
        link.dataset.betterldLinkOpenMode = mode;
      });
    });
  }

  function syncNavigationState() {
    const navigation = document.querySelector("#navigation-bar.nav.nav-pills");
    if (!navigation) {
      return;
    }
    const path = currentPath();
    navigation.querySelectorAll("a[href]").forEach((link) => {
      let linkPath = "";
      try {
        linkPath = new URL(link.href, location.href).pathname.replace(/\/+$/, "") || "/";
      } catch {
        return;
      }
      const active = linkPath === path;
      if (active) {
        link.setAttribute("aria-current", "page");
        link.dataset.betterldAriaCurrent = "true";
      } else if (link.dataset.betterldAriaCurrent === "true") {
        link.removeAttribute("aria-current");
        delete link.dataset.betterldAriaCurrent;
      }
    });
    syncNavigationSettings();
    syncConfiguredLinkModes();
  }

  function loadPageRefreshBridge() {
    if (!state.pageRefreshBridge) {
      state.pageRefreshBridge = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = api.runtime.getURL("src/page-refresh.js");
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = () => { script.remove(); reject(new Error("无法加载原站刷新桥接")); };
        document.head.append(script);
      }).catch((error) => { state.pageRefreshBridge = null; throw error; });
    }
    return state.pageRefreshBridge;
  }

  async function refreshSitePage(href) {
    await loadPageRefreshBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error) => {
        clearTimeout(timer);
        document.removeEventListener("betterld:refreshed", onResult);
        if (error) reject(error); else resolve();
      };
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id !== id) return;
        if (result.status === 429) applyRateLimit(result.retryAfter);
        finish(result.error ? new Error(result.error) : null);
      };
      const timer = window.setTimeout(() => finish(new Error("原站局部刷新超时")), config.pageRefreshTimeoutMs);
      document.addEventListener("betterld:refreshed", onResult);
      document.dispatchEvent(new CustomEvent("betterld:refresh", { detail: JSON.stringify({ id, href }) }));
    });
  }

  function refreshTopicsList() {
    if (state.refreshPromise) return state.refreshPromise;
    const wait = Math.max(state.refreshNextAt, state.metadataCooldownUntil) - Date.now();
    if (wait > 0) {
      showActionStatus(`请等待 ${Math.ceil(wait / 1000)} 秒后刷新`);
      return;
    }
    const href = location.href;
    const scrollY = pageScrollTop();
    captureUndoRefreshSnapshot();
    showActionStatus("正在局部刷新…", "success");
    state.refreshNextAt = Date.now() + config.pageRefreshMinIntervalMs;
    state.refreshPromise = scheduleMetadataRequest(() => refreshSitePage(href), () => location.href === href, () => true)
      .then(() => {
        if (location.href !== href) return;
        managedCards().forEach((card) => {
          const authorFailed = card.dataset.authorState === "failed";
          const excerptFailed = card.dataset.excerptState === "failed";
          if (!authorFailed && !excerptFailed) return;
          state.excerptCache.delete(card.dataset.topicId);
          card.dataset.topicRecoveryCount = "0";
          if (authorFailed) setAuthor(card, config.authorLoadingLabel, "loading");
          if (excerptFailed) {
            setExcerpt(card, config.excerptLoadingLabel, "loading");
            observeExcerpt(card);
          }
        });
        syncTopicListMetadata();
        state.undoRefreshSnapshot = readUndoRefreshSnapshot();
        syncFloatingActions();
        window.requestAnimationFrame(() => {
          if (location.href === href) window.scrollTo({ top: scrollY, behavior: "auto" });
        });
        showActionStatus("已更新当前页面", "success");
      })
      .catch((error) => {
        console.warn("[betterLD] local refresh failed", error);
        if (location.href === href) showActionStatus(`刷新失败：${error.message}`);
      })
      .finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  function cardSyncKey(item) {
    const topic = topicInfo(item);
    if (!topic) {
      return "";
    }
    if (item.matches(".fps-result")) return `search:${topic.href}`;
    return topic.id ? `topic:${topic.id}` : `href:${topic.href}`;
  }

  function syncCards(grid, items) {
    const known = new Map([...grid.children].map((child) => [child.dataset.betterldCardKey, child]));
    let anchor = null;
    let changed = false;
    if (isSearchPage()) {
      const keys = new Set(items.map(cardSyncKey));
      known.forEach((card, key) => {
        if (!keys.has(key)) {
          state.filterBin.delete(card);
          card.remove();
          known.delete(key);
          changed = true;
        }
      });
    }
    for (const item of items) {
      const key = cardSyncKey(item);
      if (!key) {
        continue;
      }
      let card = known.get(key);
      if (!card) {
        if (!itemPassesDomFilter(item)) {
          continue;
        }
        card = createCard(item);
        if (!card) {
          continue;
        }
        card.dataset.betterldCardKey = key;
        known.set(key, card);
        observeCard(card);
      }
      if (item.matches(".fps-result")) updateSearchCard(card, item);
      const reference = anchor ? anchor.nextElementSibling : grid.firstElementChild;
      if (card !== reference) {
        grid.insertBefore(card, reference);
        changed = true;
      }
      anchor = card;
    }
    return changed;
  }

  function finishListRefresh(changed) {
    if (!changed || !state.listRefreshAt) return;
    const recent = Date.now() - state.listRefreshAt <= config.listRefreshScrollTopWindowMs;
    state.listRefreshAt = 0;
    if (recent) window.scrollTo({ top: 0, behavior: "auto" });
  }

  function syncContainer(container, items) {
    const grid = managedGrid(container);
    if (grid?.isConnected) {
      finishListRefresh(syncCards(grid, items));
      return;
    }
    buildContainer(container, items);
  }

  function buildContainer(container, items) {
    const sourceBody = !isHomepage() ? container.querySelector(".topic-list-body") : null;
    const originallyHidden = container.dataset.betterldSource === "true"
      ? container.dataset.betterldWasHidden === "true"
      : container.hidden;
    const sourceBodyWasHidden = sourceBody
      ? sourceBody.dataset.betterldSourceBody === "true"
        ? sourceBody.dataset.betterldWasHidden === "true"
        : sourceBody.hidden
      : false;
    restoreContainer(container);

    const grid = createElement("div", "betterld-topic-grid");
    grid.dataset.betterldGrid = "true";
    grid.setAttribute("aria-label", "LinuxDo 主题");

    // 列表重建 = 新一轮立发预算。
    state.excerptPrimeBudget = config.excerptPrimeCount;
    syncCards(grid, items);

    if (!grid.childElementCount && state.currentSettings.topicFilterEnabled && items.length) {
      grid.dataset.betterldFilterEmpty = "true";
      syncFilterEmptyState(grid);
    }
    if (!grid.childElementCount) {
      return;
    }

    container.dataset.betterldSource = "true";
    container.dataset.betterldWasHidden = String(originallyHidden);
    container.hidden = sourceBody ? originallyHidden : true;
    if (sourceBody) {
      sourceBody.dataset.betterldSourceBody = "true";
      sourceBody.dataset.betterldWasHidden = String(sourceBodyWasHidden);
      sourceBody.hidden = true;
    }
    container.after(grid);
    state.managedSources.set(container, grid);
    finishListRefresh(true);
  }

  function syncHomepage() {
    const searchCards = isSearchPage() && state.currentSettings.searchMode === "cards";
    if (!searchCards && (!isTopicListPage() || state.currentSettings.topicListLayoutMode !== "reading")) {
      restoreAll();
      applyListControlsScrollState();
      return;
    }

    applyColorMode();
    syncNavigationState();
    const groups = topicContainers();
    const activeContainers = new Set(groups.map(([container]) => container));
    [...state.managedSources.keys()].forEach((container) => {
      if (!container.isConnected || !activeContainers.has(container)) {
        restoreContainer(container);
      }
    });
    document.querySelectorAll('[data-betterld-source="true"]').forEach((container) => {
      if (!activeContainers.has(container)) {
        restoreContainer(container);
      }
    });
    const trackedGrids = new Set(state.managedSources.values());
    document.querySelectorAll('[data-betterld-grid="true"]').forEach((grid) => {
      if (!trackedGrids.has(grid)) {
        removeGridElement(grid);
      }
    });

    state.mutating = true;
    try {
      for (const [container, items] of groups) {
        syncContainer(container, items);
      }
    } finally {
      state.mutating = false;
    }
    applyListControlsScrollState();
    syncTopicListMetadata();
    // 每次重建/路由切换后只为最靠上的几张卡立刻发请求，后续交给观察器与空闲预取。
    primeExcerpts();
  }

  function scheduleSync() {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
    }
    state.syncTimer = window.setTimeout(() => {
      state.syncTimer = 0;
      syncHomepage();
    }, config.syncDebounceMs);
  }

  function updateRouteState() {
    state.lastScrollY = pageScrollTop();
    state.listControlsCollapsed = false;
    // 路由切换 = 新一轮立发预算。
    state.excerptPrimeBudget = config.excerptPrimeCount;
    // 路由切换后原卡片会被重建/移除，抽屉留着会指向失效的触发卡：复用同一套关闭逻辑收掉。
    closeTopicDrawer();
    state.scrollDirection = 0;
    state.scrollDistance = 0;
    applyListControlsScrollState();
    const home = isHomepage();
    const topicListPage = isTopicListPage();
    const categoriesPage = isCategoriesPage();
    const tagsPage = isTagsPage();
    const directoryPage = categoriesPage || tagsPage;
    // 壳层视觉（壁纸、遮罩、Header/Sidebar）在所有页面生效，不随页面类型收窄
    document.body?.classList.add("betterld-shell");
    document.documentElement.classList.toggle("betterld-home", home);
    document.body?.classList.toggle("betterld-home", home);
    document.documentElement.classList.toggle("betterld-topic-page", topicListPage && !home);
    document.body?.classList.toggle("betterld-topic-page", topicListPage && !home);
    document.documentElement.classList.toggle("betterld-categories-page", directoryPage);
    document.body?.classList.toggle("betterld-categories-page", directoryPage);
    document.documentElement.classList.toggle("betterld-tags-page", tagsPage);
    document.body?.classList.toggle("betterld-tags-page", tagsPage);
    document.documentElement.classList.toggle("betterld-search-page", isSearchPage());
    document.body?.classList.toggle("betterld-search-page", isSearchPage());
    applyColorMode();
    syncNavigationState();
    applyChromeSettings();
    syncFloatingActions();
    if (topicListPage || isSearchPage()) {
      scheduleSync();
    } else {
      restoreAll();
    }
  }

  function topicReplyUrl(topicId, postNumber) {
    return `/t/topic/${topicId}/${postNumber}`;
  }

  // 与原站保持一致：cooked 由 Discourse 服务端生成并 sanitize，这里不再做客户端清理，
  // 否则 iframe（B 站播放器等）、内联 SVG、表单、帖子自带样式等内容会与原站不符。
  function replyCooked(markup) {
    const doc = new DOMParser().parseFromString(String(markup || ""), "text/html");
    doc.body.querySelectorAll("img").forEach((node) => {
      node.loading = "lazy";
    });
    return enhanceReplyContent(doc.body);
  }

  // 原站的 callout / 剧透 / hashtag 由 Discourse 客户端 JS 增强，服务端 cooked 里没有对应结构，
  // 树里也就拿不到原站的交互与样式。这里按原站 DOM 复刻（类名、data 属性、图标 sprite 照抄）。
  const replySvgNamespace = "http://www.w3.org/2000/svg";
  const replyCalloutPattern = /^\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/s;

  // 元素在游离状态下绑定事件，随 cooked 一起进树；树重建时会重新解析 → 自动重新绑定。
  function replyIconElement(doc, icon, className) {
    const svg = doc.createElementNS(replySvgNamespace, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("aria-hidden", "true");
    const use = doc.createElementNS(replySvgNamespace, "use");
    use.setAttribute("href", `#${icon}`);
    svg.append(use);
    return svg;
  }

  function replyCalloutType(name) {
    const key = String(name || "").toLowerCase();
    const types = config.replyTreeCalloutTypes;
    if (types[key]) return key;
    return Object.keys(types).find((type) => types[type].aliases.includes(key)) || "";
  }

  // #086ddd → rgba(8, 109, 221, 0.1)：原站把类型色按 10% 不透明度铺在引用块背景上。
  function replyCalloutBackground(hex) {
    const digits = String(hex).replace(/^#/, "");
    const expanded = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
    const value = Number.parseInt(expanded, 16) || 0;
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0.1)`;
  }

  function enhanceCallouts(root) {
    const doc = root.ownerDocument;
    root.querySelectorAll("blockquote:not([data-callout-type])").forEach((block) => {
      const lead = block.firstElementChild;
      if (!lead || lead.tagName !== "P") return;
      const match = replyCalloutPattern.exec(lead.textContent);
      const type = match && replyCalloutType(match[1]);
      if (!type) return;
      const meta = config.replyTreeCalloutTypes[type];
      const lines = String(match[3]).split("\n");
      const title = lines[0].trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const rest = lines.slice(1).join("\n").trim();
      // 首行 p 被消费：整段都是标题时删掉，标题后还有内容时留下剩余文本。
      if (rest) lead.textContent = rest; else lead.remove();
      const collapsed = match[2] === "-";
      const header = doc.createElement("div");
      header.className = "callout-title";
      header.style.color = meta.color;
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      const icon = doc.createElement("span");
      icon.className = "callout-icon";
      icon.append(replyIconElement(doc, meta.icon, `fa d-icon d-icon-${meta.icon} svg-icon fa-width-auto svg-string`));
      const inner = doc.createElement("span");
      inner.className = "callout-title-inner";
      inner.textContent = title;
      const fold = doc.createElement("span");
      fold.className = collapsed ? "callout-fold is-collapsed" : "callout-fold";
      fold.append(replyIconElement(doc, "chevron-down", "fa d-icon d-icon-chevron-down svg-icon fa-width-auto svg-string"));
      header.append(icon, inner, fold);
      const content = doc.createElement("div");
      content.className = "callout-content";
      content.append(...block.childNodes);
      block.className = collapsed ? "callout is-collapsible is-collapsed" : "callout is-collapsible";
      block.setAttribute("dir", "auto");
      block.setAttribute("data-callout-type", type);
      block.style.backgroundColor = replyCalloutBackground(meta.color);
      block.append(header, content);
      const setCollapsed = (value) => {
        block.classList.toggle("is-collapsed", value);
        fold.classList.toggle("is-collapsed", value);
      };
      header.addEventListener("click", () => setCollapsed(!block.classList.contains("is-collapsed")));
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setCollapsed(!block.classList.contains("is-collapsed"));
      });
    });
  }

  function replySpoilerSetState(node, revealed) {
    node.classList.toggle("spoiler-blurred", !revealed);
    node.setAttribute("data-spoiler-state", revealed ? "revealed" : "blurred");
    node.setAttribute("aria-expanded", String(revealed));
    node.setAttribute("aria-label", revealed ? config.replyTreeSpoilerLabels.revealed : config.replyTreeSpoilerLabels.blurred);
    [...node.children].forEach((child) => {
      if (revealed) child.removeAttribute("aria-hidden"); else child.setAttribute("aria-hidden", "true");
    });
  }

  function enhanceSpoilers(root) {
    root.querySelectorAll("div.spoiler:not([data-spoiler-state])").forEach((node) => {
      // 原站也移除了 spoiler 类，模糊只由 .spoiler-blurred 提供。
      node.classList.remove("spoiler");
      node.classList.add("spoiled", "spoiler-blurred");
      node.setAttribute("dir", "auto");
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-live", "polite");
      replySpoilerSetState(node, false);
      const toggle = () => replySpoilerSetState(node, node.getAttribute("data-spoiler-state") !== "revealed");
      node.addEventListener("click", toggle);
      node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    });
  }

  function enhanceHashtags(root) {
    const doc = root.ownerDocument;
    root.querySelectorAll("a.hashtag-cooked[data-icon]").forEach((link) => {
      const placeholder = link.querySelector(".hashtag-icon-placeholder");
      if (!placeholder) return;
      const icon = String(link.getAttribute("data-icon") || "").trim();
      const name = /^[a-z0-9-]+$/i.test(icon) ? icon : "tag";
      placeholder.replaceWith(replyIconElement(doc, name, `fa d-icon d-icon-${name} svg-icon`));
    });
  }

  // ---- 浮层工厂（代码全屏 / 图片灯箱共用）----
  // 浮层自己就是一个 <dialog>：打开时 showModal() 进 top layer，在抽屉（同为 modal dialog）之上覆盖整屏，
  // 不再需要猜「哪一个 open dialog 在最上层」；遮罩交给 ::backdrop（仅 modal 生效）。
  // 只有不支持 showModal 的老 Firefox 退回固定定位 + 自绘遮罩（.betterld-reply-overlay--fallback）。
  // owner 是浮层所属的宿主 dialog（回复树在页面里时为 null）：宿主关闭时一并收掉，不留悬空浮层。
  const replyOverlays = new Set();

  function closeReplyOverlaysOwnedBy(owner) {
    [...replyOverlays].forEach((record) => {
      if (record.owner === owner) {
        record.close();
      }
    });
  }

  function openReplyOverlay(className, ariaLabel, build, owner = null) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("dialog");
    overlay.className = `betterld-reply-overlay ${className}`;
    overlay.setAttribute("aria-label", ariaLabel);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "betterld-reply-overlay__close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "✕";
    const content = document.createElement("div");
    content.className = "betterld-reply-overlay__content";
    const modal = typeof overlay.showModal === "function";
    let closed = false;
    // modal dialog 的 Esc 由浏览器派发给最上层这一个（下面的抽屉收不到），只有非 modal 的老路径要自己接。
    const onKeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    };
    const finishClose = () => {
      // 幂等：close 事件与同步收尾路径可能都走到这里，remove/focus 只跑一次。
      if (closed) return;
      closed = true;
      replyOverlays.delete(record);
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      if (opener && opener.isConnected) {
        opener.focus();
      }
    };
    // 幂等：Esc、点遮罩、宿主一起关闭等路径重复触发时只收一次；close 事件（modal 的 Esc 也会走到）统一收尾。
    const closeOverlay = () => {
      if (closed) return;
      if (modal && overlay.open) {
        overlay.close();
        return;
      }
      overlay.removeAttribute("open");
      finishClose();
    };
    const record = { overlay, owner, close: closeOverlay };
    replyOverlays.add(record);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target === content) closeOverlay();
    });
    overlay.addEventListener("close", finishClose);
    close.addEventListener("click", closeOverlay);
    overlay.append(close, content);
    document.body.append(overlay);
    if (modal) {
      overlay.showModal();
    } else {
      overlay.classList.add("betterld-reply-overlay--fallback");
      overlay.setAttribute("open", "");
      document.addEventListener("keydown", onKeydown, true);
    }
    build(content, closeOverlay, close);
    close.focus();
    return overlay;
  }

  // ---- 代码块按钮（照抄原站 DOM：wrapper + 复制 / 全屏）----
  const replyCodeCopyLabel = "将代码复制到剪贴板";
  const replyCodeFullscreenLabel = "全屏显示代码";
  const replyCodeCopiedLabel = "已复制";
  const replyCodeCopiedMs = 2000;

  function replyCodeLanguage(code) {
    const found = [...code.classList].find((name) => name.startsWith("lang-"));
    return found ? found.slice(5) : "plaintext";
  }

  function replyCodeButton(doc, icon, className, label, onClick) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `btn nohighlight ${className} btn-flat`;
    button.setAttribute("aria-label", label);
    button.append(replyIconElement(doc, icon, `fa d-icon d-icon-${icon} svg-icon fa-width-auto svg-string`));
    button.addEventListener("click", onClick);
    return button;
  }

  async function copyReplyCode(code, button, label) {
    try {
      await navigator.clipboard.writeText(code.textContent);
    } catch (error) {
      console.warn("[betterLD] 复制代码失败", error);
      return;
    }
    button.setAttribute("aria-label", replyCodeCopiedLabel);
    button.setAttribute("title", replyCodeCopiedLabel);
    window.setTimeout(() => {
      button.setAttribute("aria-label", label);
      button.removeAttribute("title");
    }, replyCodeCopiedMs);
  }

  function openReplyCodeFullscreen(code) {
    openReplyOverlay("betterld-reply-overlay--code", replyCodeFullscreenLabel, (content) => {
      const pre = document.createElement("pre");
      pre.className = "betterld-reply-code-fullscreen__code";
      const clone = document.createElement("code");
      clone.textContent = code.textContent;
      pre.append(clone);
      content.append(pre);
    }, code.closest("dialog"));
  }

  // 高亮交给主世界桥接（页面全局没有 hljs）；pending 属性既是判重也是给桥接的选择器。
  let replyHighlightTimer = 0;
  let replyHighlightWarned = false;

  function requestReplyHighlight() {
    if (replyHighlightTimer) return;
    replyHighlightTimer = window.setTimeout(() => {
      replyHighlightTimer = 0;
      flushReplyHighlight();
    }, 100);
  }

  async function flushReplyHighlight() {
    if (!document.querySelector("[data-betterld-highlight-pending]")) return;
    try {
      await loadPageRefreshBridge();
    } catch (error) {
      if (!replyHighlightWarned) {
        replyHighlightWarned = true;
        console.warn("[betterLD] 代码高亮桥接不可用", error);
      }
      return;
    }
    document.dispatchEvent(new CustomEvent("betterld:highlight-code", {
      detail: JSON.stringify({ id: crypto.randomUUID() })
    }));
  }

  function enhanceCodeBlocks(root) {
    const doc = root.ownerDocument;
    root.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.classList.contains("codeblock-buttons")) return;
      const language = replyCodeLanguage(code);
      pre.classList.add("codeblock-buttons");
      code.classList.add("hljs", `language-${language}`);
      code.setAttribute("data-highlighted", "yes");
      code.setAttribute("data-betterld-highlight-pending", "yes");
      const wrapper = doc.createElement("div");
      wrapper.className = "codeblock-button-wrapper";
      wrapper.style.right = "0px";
      const copyButton = replyCodeButton(doc, "copy", "copy-cmd", replyCodeCopyLabel, () => copyReplyCode(code, copyButton, replyCodeCopyLabel));
      const fullscreenButton = replyCodeButton(doc, "discourse-expand", "fullscreen-cmd", replyCodeFullscreenLabel, () => openReplyCodeFullscreen(code));
      wrapper.append(copyButton, fullscreenButton);
      pre.prepend(wrapper);
    });
    requestReplyHighlight();
  }

  // ---- 图片灯箱（复用浮层工厂；原站 PhotoSwipe 绑在原站容器上，树里的点击不会触发）----
  const replyLightboxClassName = "betterld-reply-overlay--image";
  const replyLightboxLabel = "图片预览";
  const replyLightboxErrorText = "图片加载失败";

  function openReplyLightbox(anchor) {
    const source = anchor.querySelector("img");
    openReplyOverlay(replyLightboxClassName, replyLightboxLabel, (content, closeOverlay, closeButton) => {
      const image = document.createElement("img");
      image.className = "betterld-reply-lightbox__image";
      image.src = anchor.href;
      image.alt = (source && source.alt) || anchor.title || "";
      image.addEventListener("error", () => {
        // 不静默：加载失败时用一行文本替换内容，浮层仍可关闭（焦点交给关闭按钮）。
        const failure = document.createElement("p");
        failure.className = "betterld-reply-lightbox__error";
        failure.setAttribute("role", "alert");
        failure.textContent = replyLightboxErrorText;
        content.replaceChildren(failure);
        closeButton.focus();
      });
      content.replaceChildren(image);
    }, anchor.closest("dialog"));
  }

  function enhanceLightboxes(root) {
    root.querySelectorAll("a.lightbox").forEach((anchor) => {
      if (anchor.hasAttribute("data-betterld-lightbox")) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      anchor.setAttribute("data-betterld-lightbox", "1");
      anchor.addEventListener("click", (event) => {
        // 修饰键与非左键保持浏览器原生行为（新标签页、下载、菜单）。
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openReplyLightbox(anchor);
      });
    });
  }

  // ---- 引用折叠 ----
  // cooked 阶段元素游离于 DOMParser 文档（offsetHeight 恒为 0），只能在挂载后量高度，
  // 所以这里登记待测 aside，由定时器在挂载后补测（不改挂载点代码，侵入最小）。
  const replyQuotePending = new Set();
  const replyQuoteMeasureWindowMs = 5000;
  const replyQuoteMeasureIntervalMs = 200;
  let replyQuoteMeasureTimer = 0;
  let replyQuoteMeasureDeadline = 0;

  function replyQuoteBlockquote(aside) {
    return [...aside.children].find((child) => child.tagName === "BLOCKQUOTE") || null;
  }

  function replyQuoteToggle(aside, block) {
    const doc = aside.ownerDocument;
    if (!block.id) block.id = `betterld-quote-${crypto.randomUUID()}`;
    const host = aside.querySelector(".title") || aside;
    host.setAttribute("data-can-toggle-quote", "true");
    host.setAttribute("data-has-quote-controls", "true");
    let controls = host.querySelector(".quote-controls");
    if (!controls) {
      controls = doc.createElement("div");
      controls.className = "quote-controls";
      host.append(controls);
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "btn no-text btn-flat quote-toggle";
    button.setAttribute("aria-controls", block.id);
    button.append(replyIconElement(doc, "chevron-down", "fa d-icon d-icon-chevron-down svg-icon fa-width-auto svg-string"));
    aside.setAttribute("role", "none");
    // 按钮属性沿用原站 quote-toggle 的写法（展开态 aria-expanded=false + 标签「展开」），
    // 真实的收放状态同时用 aside 上的 data-expanded 显式表达。
    const setCollapsed = (collapsed) => {
      if (collapsed) aside.setAttribute("data-betterld-quote-collapsed", "true");
      else aside.removeAttribute("data-betterld-quote-collapsed");
      aside.setAttribute("data-expanded", String(!collapsed));
      button.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? config.replyTreeQuoteToggleLabels.expand : config.replyTreeQuoteToggleLabels.collapse;
      button.setAttribute("aria-label", label);
      button.title = label;
    };
    button.addEventListener("click", (event) => {
      // 原站主世界对 .quote-toggle 也有委托处理，这里拦住，避免它去动原站 DOM。
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(!aside.hasAttribute("data-betterld-quote-collapsed"));
    });
    setCollapsed(false);
    controls.append(button);
  }

  function measureReplyQuoteCollapse() {
    replyQuoteMeasureTimer = 0;
    replyQuotePending.forEach((aside) => {
      if (!aside.isConnected) return;
      const block = replyQuoteBlockquote(aside);
      replyQuotePending.delete(aside);
      if (!block) return;
      // 已带折叠态或已有原站按钮 → 跳过（幂等）。
      if (aside.hasAttribute("data-betterld-quote-collapsed") || aside.querySelector(".quote-toggle")) return;
      if (block.offsetHeight > config.replyTreeQuoteCollapseHeightPx) replyQuoteToggle(aside, block);
    });
    if (!replyQuotePending.size) {
      replyQuoteMeasureDeadline = 0;
      return;
    }
    scheduleReplyQuoteCollapseMeasure(replyQuoteMeasureIntervalMs);
  }

  function scheduleReplyQuoteCollapseMeasure(delay) {
    if (replyQuoteMeasureTimer) return;
    if (!replyQuoteMeasureDeadline) replyQuoteMeasureDeadline = Date.now() + replyQuoteMeasureWindowMs;
    if (Date.now() >= replyQuoteMeasureDeadline) {
      // 超过测量窗口（例如容器一直隐藏、高度恒为 0）就放弃，不挂按钮。
      replyQuotePending.clear();
      replyQuoteMeasureDeadline = 0;
      return;
    }
    replyQuoteMeasureTimer = window.setTimeout(measureReplyQuoteCollapse, delay);
  }

  function trackReplyQuoteCollapse(root) {
    root.querySelectorAll("aside.quote").forEach((aside) => {
      if (aside.hasAttribute("data-betterld-quote-collapsed") || aside.querySelector(".quote-toggle")) return;
      replyQuotePending.add(aside);
    });
    if (replyQuotePending.size) scheduleReplyQuoteCollapseMeasure(0);
  }

  // ---- 引用展开（复刻原站 quote-toggle 语义）----
  // 原站给每个引用都配「展开」按钮（shouldDisplayToggleButton 只看被引用帖能否定位，与引用长度无关），
  // 点开用被引用帖全文替换引用片段，再点恢复。所以这里不做任何高度阈值过滤。
  const replyQuoteExpandFailPrefix = "引用展开失败";

  function replyQuoteTreeStatus(aside) {
    return aside.closest(".betterld-reply-tree")?.querySelector(".betterld-reply-tree__status") || null;
  }

  function replyQuoteIconClass(expanded) {
    return `fa d-icon d-icon-chevron-${expanded ? "up" : "down"} svg-icon fa-width-auto svg-string`;
  }

  // 复用现有请求封装与冷却（CF 挑战 / 429 的停发逻辑都在里面），只在用户点击时才发。
  async function fetchReplyQuotedPost(topicId, postNumber, isNeeded) {
    if (!/^\d+$/.test(topicId) || !/^\d+$/.test(postNumber)) {
      throw new Error("引用的被引用帖地址不完整");
    }
    const endpoint = new URL(`/posts/by_number/${topicId}/${postNumber}.json`, location.origin);
    const data = await requestTopicResponse(endpoint.href, isNeeded);
    const cooked = data?.cooked;
    if (typeof cooked !== "string" || !cooked.trim()) throw new Error("被引用帖没有可显示的正文");
    return cooked;
  }

  function enhanceQuotes(root) {
    const doc = root.ownerDocument;
    root.querySelectorAll("aside.quote[data-topic][data-post]").forEach((aside) => {
      // 幂等：已挂过按钮（含旧的折叠按钮）就跳过，不重复挂。
      if (aside.querySelector(".quote-toggle")) return;
      const block = replyQuoteBlockquote(aside);
      const title = aside.querySelector(".title");
      if (!block || !title) return;
      if (!block.id) block.id = `betterld-quote-${crypto.randomUUID()}`;
      title.setAttribute("data-can-toggle-quote", "true");
      title.setAttribute("data-has-quote-controls", "true");
      let controls = title.querySelector(".quote-controls");
      if (!controls) {
        controls = doc.createElement("div");
        controls.className = "quote-controls";
        title.append(controls);
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "btn no-text btn-flat quote-toggle";
      button.setAttribute("aria-controls", block.id);
      button.append(replyIconElement(doc, "chevron-down", replyQuoteIconClass(false)));
      controls.append(button);

      let expanded = false;
      let busy = false;
      let snapshot = null;
      let statusText = "";

      const setState = (next) => {
        expanded = next;
        aside.setAttribute("data-expanded", String(next));
        button.setAttribute("aria-expanded", String(next));
        const label = next ? config.replyTreeQuoteExpandLabels.collapse : config.replyTreeQuoteExpandLabels.expand;
        button.setAttribute("aria-label", label);
        button.title = label;
        const svg = button.querySelector("svg");
        if (svg) svg.setAttribute("class", replyQuoteIconClass(next));
        const use = button.querySelector("use");
        if (use) use.setAttribute("href", `#${next ? "chevron-up" : "chevron-down"}`);
      };

      // 只在状态行还停在本功能写的那一句话时清理，避免盖掉树的加载提示。
      const setStatus = (text) => {
        const status = replyQuoteTreeStatus(aside);
        if (!status) return;
        if (!text && status.textContent !== statusText) return;
        status.textContent = text;
        statusText = text;
      };

      const toggle = async () => {
        if (busy) return;
        // 收起：还原展开前保存的原始内容（存的是节点本身，各增强器的事件监听一起留住）。
        if (expanded) {
          block.replaceChildren(...snapshot);
          setState(false);
          return;
        }
        busy = true;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.setAttribute("aria-label", config.replyTreeQuoteExpandLabels.busy);
        button.title = config.replyTreeQuoteExpandLabels.busy;
        const source = [...block.childNodes];
        try {
          const cooked = await fetchReplyQuotedPost(aside.dataset.topic, aside.dataset.post, () => aside.isConnected);
          if (!aside.isConnected) return;
          snapshot = source;
          // 走完整 cooked 增强链：被引用帖里的图片 / 代码块 / 嵌套引用照样可用。
          block.replaceChildren(...replyCooked(cooked).childNodes);
          setState(true);
          setStatus("");
        } catch (error) {
          // 不静默：按钮转成「重试」文案，状态行写清原因，内容保持原样、状态仍是收起。
          console.warn("[betterLD] 展开引用失败", error);
          if (!aside.isConnected) return;
          button.setAttribute("aria-label", config.replyTreeQuoteExpandLabels.failed);
          button.title = config.replyTreeQuoteExpandLabels.failed;
          setStatus(`${replyQuoteExpandFailPrefix}：${error.message}`);
        } finally {
          busy = false;
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      };
      const activate = () => {
        toggle().catch((error) => console.warn("[betterLD] 展开引用失败", error));
      };

      button.addEventListener("click", (event) => {
        // 原站主世界对 .quote-toggle 也有委托处理，这里拦住，避免它去动原站 DOM。
        event.preventDefault();
        event.stopPropagation();
        activate();
      });
      title.addEventListener("click", (event) => {
        // 对齐原站 onClickTitle：点链接或 .quote-controls 内部不切换。
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest("a") || target.closest(".quote-controls")) return;
        activate();
      });
      setState(false);
    });
  }

  function enhanceReplyContent(root) {
    if (!root) return root;
    enhanceCallouts(root);
    enhanceSpoilers(root);
    enhanceHashtags(root);
    enhanceCodeBlocks(root);
    enhanceLightboxes(root);
    // 展开按钮先挂（原站语义是每个引用都有）；旧的按高度折叠只补没有按钮的引用，自然让位给展开。
    enhanceQuotes(root);
    trackReplyQuoteCollapse(root);
    return root;
  }

  function showNativeReply(tree) {
    closeReplyReactionPicker(tree);
    state.replyTreeNativeTopicId = tree.topicId;
    tree.streamElement.removeAttribute("data-betterld-reply-source");
    tree.topicContainer.removeAttribute("data-betterld-reply-tree-active");
    tree.contentContainer.hidden = true;
    tree.toggle.hidden = false;
    tree.toggle.textContent = "返回树状回复";
  }

  // 树里只有「更多帖子操作」还会用原站触发器（Boost 已改为在树内直接写）。
  const replyActionSelectors = {
    more: ".post-action-menu__show-more"
  };

  function nativeReplyAction(postNumber, action) {
    // 选择器含多个候选项，必须先锁定该楼的操作区，否则逗号后的选择器会逃出作用域（例如命中树自己的按钮）。
    const menu = document.querySelector(`article#post_${postNumber} .post__menu-area`);
    return menu?.querySelector(replyActionSelectors[action]) || null;
  }

  function promptReplyTreeLogin(tree) {
    tree.status.textContent = "请登录后使用帖子操作。";
    document.querySelector(".d-header .login-button")?.click();
  }

  async function openReplyTreeComposer(tree, post) {
    tree.status.textContent = "";
    if (!document.querySelector(".current-user")) {
      promptReplyTreeLogin(tree);
      return;
    }
    try {
      await loadPageRefreshBridge();
      await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (error) => {
          clearTimeout(timer);
          document.removeEventListener("betterld:reply-composed", onResult);
          if (error) reject(error); else resolve();
        };
        const onResult = (event) => {
          const result = JSON.parse(event.detail);
          if (result.id !== id) return;
          finish(result.error ? new Error(result.error) : null);
        };
        const timer = window.setTimeout(() => finish(new Error("回复编辑器打开超时")), config.replyTreeActionTimeoutMs);
        document.addEventListener("betterld:reply-composed", onResult);
        document.dispatchEvent(new CustomEvent("betterld:reply-compose", {
          detail: JSON.stringify({ id, topicId: tree.topicId, postId: post.id })
        }));
      });
    } catch (error) {
      console.error("[betterLD] reply composer failed", error);
      if (state.replyTree === tree) tree.status.textContent = `回复编辑器打开失败：${error.message}`;
    }
  }

  // 原站 boost 弹层带 closeOnScroll：触发器滚动后弹层会被这次滚动立刻关掉，所以点击必须等滚动事件派发完。
  // 不用 rAF：它依赖渲染管线，标签页隐藏或渲染停摆时不会触发，点击会静默失效。
  function afterScrollSettles(callback) {
    let settled = false;
    let quietTimer;
    let limitTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(limitTimer);
      window.removeEventListener("scroll", onScroll);
      callback();
    };
    const onScroll = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, config.replyTreeScrollSettleMs);
    };
    limitTimer = setTimeout(finish, config.replyTreeScrollSettleTimeoutMs);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  function nativeMenuOpened() {
    const menu = document.querySelector(".fk-d-menu__inner-content");
    if (!menu) return false;
    const bounds = menu.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function openNativeReplyAction(tree, post, action) {
    tree.status.textContent = "";
    const postNumber = post.post_number;
    if (!document.querySelector(".current-user")) {
      promptReplyTreeLogin(tree);
      return;
    }
    showNativeReply(tree);
    let observer;
    let timer;
    let attempts = 0;
    let pending = false;
    let scrolled = false;
    const finish = () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
    const clickTrigger = () => {
      const button = nativeReplyAction(postNumber, action);
      if (!button) {
        pending = false;
        return;
      }
      attempts += 1;
      button.click();
      // 弹层可能被后续滚动事件关掉、也可能随楼层卸载而消失，校验一次再决定是否重试。
      setTimeout(() => {
        pending = false;
        if (state.replyTreeNativeTopicId !== tree.topicId || topicIdFromPath() !== tree.topicId) return;
        if (!nativeMenuOpened()) {
          if (attempts < config.replyTreeActionAttempts) activate();
          else tree.status.textContent = `原站 #${postNumber} 的菜单没能打开，请返回树状回复后重试。`;
        }
      }, config.replyTreeActionVerifyMs);
    };
    const activate = () => {
      if (topicIdFromPath() !== tree.topicId || state.replyTreeNativeTopicId !== tree.topicId) {
        finish();
        return;
      }
      const button = nativeReplyAction(postNumber, action);
      if (!button || pending) return;
      pending = true;
      finish();
      // 重试时不再滚动：滚动本身会派发新的滚动事件，把刚打开的弹层又关掉。
      if (scrolled) {
        clickTrigger();
        return;
      }
      scrolled = true;
      button.closest("article")?.scrollIntoView({ block: "center" });
      afterScrollSettles(() => {
        if (state.replyTreeNativeTopicId !== tree.topicId || topicIdFromPath() !== tree.topicId) return;
        clickTrigger();
      });
    };
    if (!nativeReplyAction(postNumber, action)) {
      // 楼层没在原站渲染时先切到原帖：导航会让 Discourse 载入并渲染该楼，触发器随后出现。
      const link = tree.content.querySelector(`[data-post-number="${postNumber}"] > .betterld-reply-tree__card .betterld-reply-tree__number`);
      link.click();
      timer = setTimeout(() => {
        finish();
        if (state.replyTreeNativeTopicId === tree.topicId && topicIdFromPath() === tree.topicId) {
          const currentTree = state.replyTree;
          if (currentTree?.topicId === tree.topicId) currentTree.status.textContent = `原站 #${postNumber} 的操作未载入，请重试。`;
        }
      }, config.replyTreeActionTimeoutMs);
    }
    observer = new MutationObserver(activate);
    observer.observe(document.querySelector("#main-outlet"), { childList: true, subtree: true });
    activate();
  }

  function replyTreeReactionSettings(tree) {
    if (tree.reactionSettings) return tree.reactionSettings;
    const source = document.querySelector("#data-preloaded")?.textContent;
    const settings = source && JSON.parse(JSON.parse(source).siteSettings || "{}");
    const names = settings?.discourse_reactions_enabled_reactions?.split("|").filter(Boolean);
    if (!names?.length || !settings.emoji_set) throw new Error("原站回应选项尚未载入");
    tree.reactionSettings = { names, emojiSet: settings.emoji_set };
    return tree.reactionSettings;
  }

  function replyTreeReactionIcon(tree, name) {
    const custom = config.replyTreeCustomEmojiUrls[name];
    if (custom) return custom;
    return `${config.replyTreeEmojiBaseUrl}${encodeURIComponent(replyTreeReactionSettings(tree).emojiSet)}/${encodeURIComponent(name)}.png`;
  }

  function replyTreeAvatarPath(template) {
    const path = String(template || "").replace("{size}", "48");
    return /^\/(user_avatar|letter_avatar)\//.test(path) ? path : "";
  }

  const replyTreeTimeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "always" });
  const replyTreeTimeUnits = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60]
  ];

  function replyTreeRelativeTime(timestamp, now = Date.now()) {
    const elapsed = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (elapsed < 60) return "刚刚";
    const [unit, seconds] = replyTreeTimeUnits.find(([, duration]) => elapsed >= duration);
    return replyTreeTimeFormatter.format(-Math.floor(elapsed / seconds), unit);
  }

  function refreshReplyTreeTimes(tree) {
    const now = Date.now();
    tree.content.querySelectorAll("time[datetime]").forEach((date) => {
      const text = `${date.title} · ${replyTreeRelativeTime(Date.parse(date.dateTime), now)}`;
      if (date.textContent !== text) date.textContent = text;
    });
  }

  function closeReplyReactionPicker(tree) {
    tree.reactionPicker?.remove();
    tree.reactionTrigger?.setAttribute("aria-expanded", "false");
    tree.reactionPickerCleanup?.();
    tree.reactionPicker = null;
    tree.reactionTrigger = null;
    tree.reactionPickerCleanup = null;
  }

  function positionReplyReactionPopover(popup, trigger) {
    const rect = trigger.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8))}px`;
    const top = rect.top > popup.offsetHeight + 8 ? rect.top - popup.offsetHeight - 8 : rect.bottom + 8;
    popup.style.top = `${Math.max(8, Math.min(top, innerHeight - popup.offsetHeight - 8))}px`;
  }

  function mountReplyReactionPopover(tree, popup, trigger) {
    tree.panel.append(popup);
    tree.reactionPicker = popup;
    tree.reactionTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    positionReplyReactionPopover(popup, trigger);
    const dismiss = (event) => {
      if (!popup.contains(event.target) && !trigger.contains(event.target)) closeReplyReactionPicker(tree);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        closeReplyReactionPicker(tree);
        trigger.focus();
      }
    };
    const reposition = () => positionReplyReactionPopover(popup, trigger);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    tree.reactionPickerCleanup = () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
    };
  }

  function openReplyReactionUsers(tree, post, trigger) {
    closeReplyReactionPicker(tree);
    const popup = createElement("div", "betterld-reply-tree__reaction-users");
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", `#${post.post_number} 回应人名单`);
    const head = createElement("div", "betterld-reply-tree__users-head");
    const heading = createElement("strong", "betterld-reply-tree__users-title", `#${post.post_number} · 回应人`);
    const close = createElement("button", "betterld-reply-tree__users-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭回应人名单");
    close.addEventListener("click", () => {
      closeReplyReactionPicker(tree);
      trigger.focus();
    });
    head.append(heading, close);
    const list = createElement("div", "betterld-reply-tree__users-list");
    const status = createElement("p", "betterld-reply-tree__users-status");
    status.setAttribute("role", "status");
    const more = createElement("button", "betterld-reply-tree__users-more", "加载更多回应人");
    more.type = "button";
    more.hidden = true;
    popup.append(head, list, status, more);
    mountReplyReactionPopover(tree, popup, trigger);
    close.focus();

    let page = 0;
    let loaded = 0;
    let busy = false;
    const active = () => tree.reactionPicker === popup && state.replyTree === tree && topicIdFromPath() === tree.topicId;
    const load = async () => {
      if (busy) return;
      busy = true;
      more.disabled = true;
      more.hidden = true;
      status.textContent = "正在读取回应人…";
      try {
        const params = new URLSearchParams({ page: String(page), limit: String(config.replyTreeReactionUsersPageSize) });
        const response = await fetch(`/discourse-reactions/posts/${post.id}/reactions-users-list.json?${params}`, {
          credentials: "same-origin",
          headers: discourseAjaxHeaders
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data?.users) || !Number.isInteger(data.total_rows)) throw new Error("回应人数据格式不正确");
        if (!active()) return;
        heading.textContent = `#${post.post_number} · ${data.total_rows} 个回应`;
        data.users.forEach((user) => {
          const username = cleanText(user.username);
          const nickname = cleanText(user.name);
          const href = userProfileHref(username);
          if (!href) return;
          const row = createElement("div", "betterld-reply-tree__users-item");
          const person = createElement("a", "betterld-reply-tree__users-person trigger-user-card");
          person.href = href;
          person.dataset.userCard = username;
          const avatar = createElement("img", "betterld-reply-tree__users-avatar");
          const avatarPath = replyTreeAvatarPath(user.avatar_template);
          if (avatarPath) avatar.src = avatarPath;
          avatar.alt = "";
          avatar.loading = "lazy";
          const identity = createElement("span", "betterld-reply-tree__users-identity");
          identity.append(createElement("span", "betterld-reply-tree__users-name", nickname || username));
          if (nickname && nickname !== username) {
            identity.append(createElement("span", "betterld-reply-tree__users-username", `@${username}`));
          }
          person.append(avatar, identity);
          const reaction = createElement("img", "betterld-reply-tree__users-reaction");
          reaction.src = replyTreeReactionIcon(tree, String(user.reaction || "heart"));
          reaction.alt = String(user.reaction || "heart");
          row.append(person, reaction);
          list.append(row);
        });
        loaded += data.users.length;
        page++;
        status.textContent = loaded ? "" : "暂无回应人";
        more.hidden = loaded >= data.total_rows;
        more.textContent = "加载更多回应人";
      } catch (error) {
        if (active()) {
          console.error("[betterLD] reply reaction users unavailable", error);
          status.textContent = `回应人名单读取失败：${error.message}`;
          more.textContent = "重试加载回应人";
          more.hidden = false;
        }
      } finally {
        busy = false;
        if (active()) {
          more.disabled = false;
          positionReplyReactionPopover(popup, trigger);
        }
      }
    };
    more.addEventListener("click", load);
    load();
  }

  function openReplyReactionPicker(tree, post, trigger, focusFirst = false) {
    if (tree.reactionPicker && tree.reactionTrigger === trigger) return;
    closeReplyReactionPicker(tree);
    let names;
    try {
      names = replyTreeReactionSettings(tree).names;
    } catch (error) {
      tree.status.textContent = `回应选项读取失败：${error.message}`;
      console.error("[betterLD] reply reactions unavailable", error);
      return;
    }
    const picker = createElement("div", "betterld-reply-tree__reaction-picker");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", `为 #${post.post_number} 选择回应`);
    const selected = post.current_user_reaction?.id || post.current_user_reaction;
    names.forEach((name) => {
      const choice = createElement("button", "betterld-reply-tree__reaction-choice");
      choice.type = "button";
      choice.title = name;
      choice.setAttribute("aria-label", `回应 ${name}`);
      choice.setAttribute("aria-pressed", String(selected === name));
      const image = createElement("img", "betterld-reply-tree__reaction-image");
      image.src = replyTreeReactionIcon(tree, name);
      image.alt = "";
      image.addEventListener("error", () => {
        console.error("[betterLD] reply reaction image unavailable", name, image.src);
        image.replaceWith(createElement("span", "betterld-reply-tree__reaction-name", name));
      }, { once: true });
      choice.append(image);
      choice.addEventListener("click", () => {
        closeReplyReactionPicker(tree);
        toggleReplyTreeReaction(tree, post, trigger, name);
      });
      picker.append(choice);
    });
    const count = trigger.parentElement.querySelector(".betterld-reply-tree__action-count")?.textContent;
    if (count) {
      const view = createElement("button", "betterld-reply-tree__reaction-view", `查看 ${count} 个回应`);
      view.type = "button";
      view.addEventListener("click", () => openReplyReactionUsers(tree, post, trigger));
      picker.append(view);
    }
    mountReplyReactionPopover(tree, picker, trigger);
    if (focusFirst) picker.querySelector("button")?.focus();
  }

  async function toggleReplyTreeReaction(tree, post, button, reaction) {
    if (!document.querySelector(".current-user")) {
      promptReplyTreeLogin(tree);
      return;
    }
    button.disabled = true;
    tree.status.textContent = "";
    try {
      const token = document.querySelector('meta[name="csrf-token"]')?.content;
      if (!token) throw new Error("无法读取 CSRF 令牌");
      const response = await fetch(`/discourse-reactions/posts/${post.id}/custom-reactions/${encodeURIComponent(reaction)}/toggle.json`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { ...discourseAjaxHeaders, "X-CSRF-Token": token }
      });
      if (!response.ok) throw new Error(`回应请求失败（HTTP ${response.status}）`);
      const updated = await response.json();
      if (updated?.id !== post.id || updated.post_number !== post.post_number) throw new Error("回应结果格式不正确");
      if (state.replyTree?.topicId === tree.topicId && topicIdFromPath() === tree.topicId) {
        state.replyTree.posts.set(post.id, updated);
        renderReplyTree(state.replyTree);
      }
    } catch (error) {
      console.error("[betterLD] reply reaction failed", error);
      if (state.replyTree?.topicId === tree.topicId) state.replyTree.status.textContent = `回应操作失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  function replyTreeIcon(name) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    icon.append(use);
    return icon;
  }

  function replyTreeActionButton(label, iconName, onClick, className = "") {
    const button = createElement("button", `betterld-reply-tree__action ${className}`);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(replyTreeIcon(iconName));
    button.addEventListener("click", onClick);
    return button;
  }

  // 原站把 boost 列表放在 .post__menu-area 内、帖子操作栏之后，并且没有任何 boost 时整块不渲染；
  // 树里沿用同一位置与同一套原站类名，样式直接由原站插件 CSS 与 betterLD 既有气泡材质覆盖提供。
  function closeReplyTreeBoostEditor(tree) {
    tree.boostEditor = null;
  }

  function focusReplyTreeBoostInput(tree) {
    const input = tree.content.querySelector(`[data-post-number="${tree.boostEditor?.postNumber}"] .betterld-reply-tree__boost-editor .discourse-boosts__input`);
    if (!input) return;
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 原站编辑器的头像是当前用户的 48px avatar_template（显示尺寸 24px），直接从预载用户数据取，不自造一份。
  function currentUserAvatarPath() {
    const source = document.querySelector("#data-preloaded")?.textContent;
    if (!source) return "";
    try {
      const current = JSON.parse(source).currentUser;
      return replyTreeAvatarPath(current ? JSON.parse(current).avatar_template : "");
    } catch (error) {
      console.error("[betterLD] 当前用户头像数据无效", error);
      return "";
    }
  }

  // 原站 Boost 编辑器是挂在触发器旁的 DMenu 浮层（当前用户头像 + 文本域 + 提交/取消按钮）：
  // 树里把同一套类名与结构内联到该楼的 Boost 行，直接就地写，不再切回原站视图。
  // 字数与 emoji 上限由原站服务端判定，这里只负责输入与提交，不复制一套计数规则。
  function replyTreeBoostEditor(tree, post) {
    const container = createElement("div", "discourse-boosts__input-container betterld-reply-tree__boost-editor");
    const avatarPath = currentUserAvatarPath();
    if (avatarPath) {
      const avatar = createElement("img", "avatar");
      avatar.src = avatarPath;
      avatar.alt = "";
      container.append(avatar);
    }
    const input = createElement("div", "discourse-boosts__input");
    input.contentEditable = "plaintext-only";
    input.tabIndex = 0;
    input.dataset.placeholder = `Boost ${cleanText(post.username)}...`;
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-label", `为 #${post.post_number} 写一条 Boost`);
    input.textContent = tree.boostEditor.value;
    const submit = createElement("button", "btn no-text btn-icon btn-default --success btn-icon-only discourse-boosts__submit");
    submit.type = "button";
    submit.setAttribute("aria-label", "提交 Boost");
    submit.title = "提交 Boost";
    submit.append(replyTreeIcon("check"));
    const cancel = createElement("button", "btn no-text btn-icon btn-default --danger btn-icon-only discourse-boosts__cancel");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "取消 Boost");
    cancel.title = "取消 Boost";
    cancel.append(replyTreeIcon("xmark"));
    const updateSubmit = () => {
      submit.disabled = input.textContent.trim().length === 0;
    };
    input.addEventListener("input", () => {
      tree.boostEditor.value = input.textContent;
      updateSubmit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!submit.disabled) submitReplyTreeBoost(tree, post, input, submit);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeReplyTreeBoostEditor(tree);
        renderReplyTree(tree);
      }
    });
    submit.addEventListener("click", () => submitReplyTreeBoost(tree, post, input, submit));
    cancel.addEventListener("click", () => {
      closeReplyTreeBoostEditor(tree);
      renderReplyTree(tree);
    });
    updateSubmit();
    // 整条输入栏都可点：点到头像或空白处也把光标放进文本域。
    container.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      if (event.target === input) return;
      focusReplyTreeBoostInput(tree);
    });
    container.append(input, submit, cancel);
    return container;
  }

  async function submitReplyTreeBoost(tree, post, input, submit) {
    const raw = input.textContent.trim();
    if (!raw) return;
    tree.status.textContent = "";
    submit.disabled = true;
    try {
      await loadPageRefreshBridge();
      const result = await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (error, payload) => {
          clearTimeout(timer);
          document.removeEventListener("betterld:reply-boosted", onResult);
          if (error) reject(error);
          else resolve(payload);
        };
        const onResult = (event) => {
          const payload = JSON.parse(event.detail);
          if (payload.id !== id) return;
          finish(payload.error ? new Error(payload.error) : null, payload);
        };
        const timer = window.setTimeout(() => finish(new Error("提交超时")), config.replyTreeActionTimeoutMs);
        document.addEventListener("betterld:reply-boosted", onResult);
        document.dispatchEvent(new CustomEvent("betterld:reply-boost", {
          detail: JSON.stringify({ id, topicId: tree.topicId, postId: post.id, raw })
        }));
      });
      if (state.replyTree !== tree) return;
      closeReplyTreeBoostEditor(tree);
      const current = tree.posts.get(post.id);
      if (current && result.boost) {
        tree.posts.set(post.id, {
          ...current,
          boosts: [...(current.boosts || []).filter((boost) => boost.id !== result.boost.id), result.boost],
          can_boost: false
        });
      }
      renderReplyTree(tree);
      tree.status.textContent = "已发送 Boost";
    } catch (error) {
      if (state.replyTree !== tree) return;
      submit.disabled = false;
      tree.status.textContent = `Boost 失败：${error.message}`;
    }
  }

  function openReplyTreeBoostEditor(tree, post) {
    closeReplyReactionPicker(tree);
    tree.status.textContent = "";
    const same = tree.boostEditor?.postNumber === post.post_number;
    tree.boostEditor = { postNumber: post.post_number, value: same ? tree.boostEditor.value : "" };
    renderReplyTree(tree);
    focusReplyTreeBoostInput(tree);
  }

  function replyTreeBoostSection(tree, post) {
    const boosts = Array.isArray(post.boosts) ? post.boosts.filter((boost) => boost?.cooked) : [];
    const editing = tree.boostEditor?.postNumber === post.post_number;
    if (!boosts.length && !editing) return null;
    const wrapper = createElement("div", "discourse-boosts__post-menu betterld-reply-tree__boosts");
    const list = createElement("div", "discourse-boosts__list");
    for (const boost of boosts) {
      const bubble = createElement("span", "discourse-boosts__bubble");
      const username = cleanText(boost.user?.username);
      const avatarPath = replyTreeAvatarPath(boost.user?.avatar_template);
      if (avatarPath) {
        const avatar = createElement("img", "avatar");
        avatar.src = avatarPath;
        avatar.alt = "";
        avatar.width = 24;
        avatar.height = 24;
        avatar.loading = "lazy";
        const href = userProfileHref(username);
        if (href) {
          const link = createElement("a", "trigger-user-card");
          link.href = href;
          link.dataset.userCard = username;
          link.setAttribute("aria-label", `查看 ${cleanText(boost.user?.name) || username} 的个人资料`);
          link.append(avatar);
          bubble.append(link);
        } else {
          bubble.append(avatar);
        }
      }
      const cooked = createElement("span", "discourse-boosts__cooked");
      cooked.append(...replyCooked(boost.cooked).childNodes);
      bubble.append(cooked);
      list.append(bubble);
    }
    if (post.can_boost === true && !editing) {
      // 原站这个按钮就是 Discourse 的图标按钮（.btn.btn-icon + .d-icon），沿用同一套类名以继承原站尺寸与配色。
      const add = createElement("button", "btn no-text btn-icon btn-flat discourse-boosts__add-btn");
      add.type = "button";
      add.setAttribute("aria-label", `为 #${post.post_number} 添加 Boost`);
      add.title = `为 #${post.post_number} 添加 Boost`;
      const icon = replyTreeIcon("rocket");
      icon.setAttribute("class", "fa d-icon d-icon-rocket svg-icon");
      icon.setAttribute("width", "1em");
      icon.setAttribute("height", "1em");
      add.append(icon);
      add.addEventListener("click", () => openReplyTreeBoostEditor(tree, post));
      list.append(add);
    }
    const group = createElement("div", "discourse-boosts");
    group.append(list);
    // 原站编辑器是浮在原位上的，树里改在 boost 行下方另占一行，尺寸与控件保持原站一致。
    if (editing) group.append(replyTreeBoostEditor(tree, post));
    wrapper.append(group);
    return wrapper;
  }

  function renderReplyTree(tree) {
    const anchor = [...tree.content.querySelectorAll('.betterld-reply-tree__item')].find((item) => {
      const bounds = item.querySelector('.betterld-reply-tree__card').getBoundingClientRect();
      return bounds.bottom > (document.querySelector('.d-header')?.offsetHeight || 0) && bounds.top < innerHeight;
    });
    const anchorTop = anchor?.getBoundingClientRect().top;
    const focusedBoostInput = Boolean(document.activeElement?.closest?.(".betterld-reply-tree__boost-editor"));
    closeReplyReactionPicker(tree);
    const posts = [...tree.posts.values()].sort((a, b) => a.post_number - b.post_number);
    const byNumber = new Map(posts.map((post) => [post.post_number, post]));
    const children = new Map(posts.map((post) => [post.post_number, []]));
    for (const post of posts) {
      if (post.post_number === 1) continue;
      const parent = Number(post.reply_to_post_number);
      const key = parent > 1 && parent < post.post_number && byNumber.has(parent) ? parent : 1;
      children.get(key)?.push(post);
    }

    const list = createElement("ol", "betterld-reply-tree__list");
    function renderPost(post) {
      const item = createElement("li", "betterld-reply-tree__item");
      item.dataset.postNumber = String(post.post_number);
      const card = createElement("article", "betterld-reply-tree__card");
      const avatar = createElement("img", "betterld-reply-tree__avatar");
      const avatarPath = replyTreeAvatarPath(post.avatar_template);
      if (avatarPath) avatar.src = avatarPath;
      avatar.alt = "";
      avatar.loading = "lazy";
      const username = cleanText(post.username);
      const nickname = cleanText(post.name);
      const avatarHref = userProfileHref(username);
      const avatarLink = avatarHref ? createElement("a", "betterld-reply-tree__avatar-link trigger-user-card") : null;
      if (avatarLink) {
        avatarLink.href = avatarHref;
        avatarLink.dataset.userCard = username;
        avatarLink.setAttribute("aria-label", `查看 ${nickname || username} 的个人资料`);
        avatarLink.append(avatar);
      }
      const body = createElement("div", "betterld-reply-tree__body");
      const head = createElement("div", "betterld-reply-tree__head");
      const author = createElement("span", "betterld-reply-tree__author");
      const nameMode = state.currentSettings.replyTreeNameMode;
      if (nameMode !== "username" && nickname) author.append(createElement("span", "betterld-reply-tree__nickname", nickname));
      if ((nameMode !== "nickname" || !nickname) && username && (nameMode !== "both" || nickname !== username)) {
        author.append(createElement("span", "betterld-reply-tree__username", username));
      }
      if (!author.textContent) author.textContent = username || `#${post.post_number}`;
      const number = createElement("a", "betterld-reply-tree__number", `#${post.post_number} · 去原帖回复`);
      number.href = topicReplyUrl(tree.topicId, post.post_number);
      number.addEventListener("click", (event) => {
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) showNativeReply(tree);
      });
      const date = createElement("time", "betterld-reply-tree__date");
      if (post.created_at) {
        const createdAt = new Date(post.created_at);
        if (!Number.isNaN(createdAt.getTime())) {
          date.dateTime = post.created_at;
          date.title = createdAt.toLocaleString();
          date.textContent = `${date.title} · ${replyTreeRelativeTime(createdAt.getTime())}`;
        }
      }
      head.append(author, number, date);
      if (Number(post.reply_to_post_number) > 1 && !byNumber.has(Number(post.reply_to_post_number))) {
        head.append(createElement("span", "betterld-reply-tree__date", `回复 #${post.reply_to_post_number}（父楼尚未载入）`));
      }
      const cooked = createElement("div", "betterld-reply-tree__cooked cooked");
      cooked.append(...replyCooked(post.cooked).childNodes);
      body.append(head, cooked);
      const actions = createElement("div", "betterld-reply-tree__actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", `#${post.post_number} 帖子操作`);
      const reactionCount = Number(post.reaction_users_count) || Number(post.actions_summary?.find((action) => action.id === 2)?.count) || 0;
      const selected = post.current_user_reaction?.id || post.current_user_reaction;
      const liked = selected === "heart";
      const label = !selected ? "点赞此帖子" : liked ? "取消点赞" : `取消回应 ${selected}`;
      let longPressed = false;
      if (reactionCount > 0) {
        const summary = createElement("button", "betterld-reply-tree__action betterld-reply-tree__reaction-summary");
        summary.type = "button";
        summary.setAttribute("aria-label", `${reactionCount} 个回应，查看回应人列表`);
        summary.setAttribute("aria-haspopup", "dialog");
        summary.setAttribute("aria-expanded", "false");
        const reactions = [...post.reactions || []].sort((a, b) => b.count - a.count).slice(0, config.replyTreeReactionSummaryLimit);
        for (const reaction of reactions) {
          const image = createElement("img", "betterld-reply-tree__reaction-image");
          image.src = replyTreeReactionIcon(tree, reaction.id);
          image.alt = "";
          image.title = `${reaction.id}：${reaction.count}`;
          summary.append(image);
        }
        summary.append(createElement("span", "betterld-reply-tree__action-count", String(reactionCount)));
        summary.addEventListener("click", () => openReplyReactionUsers(tree, post, summary));
        actions.append(summary);
      }
      const like = replyTreeActionButton(label, liked ? "heart" : "far-heart", () => {
        if (longPressed) {
          longPressed = false;
          return;
        }
        closeReplyReactionPicker(tree);
        // 原站主回应按钮是开关语义：点已选中的那个回应即取消，切换其他回应走悬停/长按选择器。
        toggleReplyTreeReaction(tree, post, like, selected || "heart");
      });
      like.setAttribute("aria-pressed", String(Boolean(selected)));
      like.setAttribute("aria-haspopup", "dialog");
      like.setAttribute("aria-expanded", "false");
      like.title = selected ? "点击取消当前回应，悬停或长按选择其他回应" : "点击点赞，悬停或长按选择其他回应";
      if (selected && !liked) {
        try {
          const icon = createElement("img", "betterld-reply-tree__reaction-image");
          icon.src = replyTreeReactionIcon(tree, selected);
          icon.alt = "";
          like.querySelector("svg").replaceWith(icon);
        } catch {
          like.append(createElement("span", "betterld-reply-tree__reaction-name", selected));
        }
      }
      let holdTimer;
      let hoverTimer;
      like.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") {
          hoverTimer = setTimeout(() => openReplyReactionPicker(tree, post, like), config.replyTreeReactionHoverMs);
        }
      });
      like.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        clearTimeout(hoverTimer);
        holdTimer = setTimeout(() => {
          longPressed = true;
          openReplyReactionPicker(tree, post, like);
        }, config.replyTreeReactionHoldMs);
      });
      like.addEventListener("pointerup", () => {
        clearTimeout(holdTimer);
        if (longPressed) setTimeout(() => { longPressed = false; }, 0);
      });
      like.addEventListener("pointercancel", () => {
        clearTimeout(holdTimer);
        longPressed = false;
      });
      like.addEventListener("pointerleave", () => {
        clearTimeout(holdTimer);
        clearTimeout(hoverTimer);
      });
      like.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        clearTimeout(holdTimer);
        openReplyReactionPicker(tree, post, like);
      });
      like.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          openReplyReactionPicker(tree, post, like, true);
        }
      });
      actions.append(like);
      const copy = replyTreeActionButton("复制此帖链接", "link", async () => {
        try {
          await copyText(new URL(post.post_url || topicReplyUrl(tree.topicId, post.post_number), location.origin).href);
          tree.status.textContent = "已复制此帖链接";
        } catch (error) {
          tree.status.textContent = `复制链接失败：${error.message}`;
        }
      });
      actions.append(copy);
      // 原站同一帖子只会有其中一个 rocket 触发器：没有 boost 时在帖子操作菜单里，已有 boost 时在列表末尾。
      if (post.can_boost !== false && !post.boosts?.length) {
        actions.append(replyTreeActionButton("Boost 此帖", "rocket", () => openReplyTreeBoostEditor(tree, post)));
      }
      actions.append(replyTreeActionButton("更多帖子操作", "ellipsis", () => openNativeReplyAction(tree, post, "more")));
      const reply = replyTreeActionButton(`回复 #${post.post_number}`, "reply", () => openReplyTreeComposer(tree, post), "betterld-reply-tree__action--reply");
      reply.append(createElement("span", "betterld-reply-tree__action-label", "回复"));
      actions.append(reply);
      body.append(actions);
      const boosts = replyTreeBoostSection(tree, post);
      if (boosts) body.append(boosts);
      card.append(avatarLink || avatar, body);
      item.append(card);
      const replies = children.get(post.post_number) || [];
      if (replies.length) {
        const button = createElement("button", "betterld-reply-tree__collapse", tree.collapsed.has(post.post_number) ? "+" : "−");
        button.type = "button";
        button.setAttribute("aria-label", `${tree.collapsed.has(post.post_number) ? "展开" : "收起"} #${post.post_number} 的 ${replies.length} 条回复`);
        button.setAttribute("aria-expanded", String(!tree.collapsed.has(post.post_number)));
        const branch = createElement("ol", "betterld-reply-tree__list betterld-reply-tree__children");
        branch.hidden = tree.collapsed.has(post.post_number);
        button.addEventListener("click", () => {
          branch.hidden = !branch.hidden;
          if (branch.hidden) tree.collapsed.add(post.post_number);
          else tree.collapsed.delete(post.post_number);
          button.textContent = branch.hidden ? "+" : "−";
          button.setAttribute("aria-expanded", String(!branch.hidden));
          button.setAttribute("aria-label", `${branch.hidden ? "展开" : "收起"} #${post.post_number} 的 ${replies.length} 条回复`);
        });
        item.append(button, branch);
        replies.forEach((reply) => branch.append(renderPost(reply)));
      }
      return item;
    }
    const rootPost = byNumber.get(1);
    if (rootPost) list.append(renderPost(rootPost));
    tree.content.replaceChildren(list);
    if (anchor && !tree.contentContainer.hidden) {
      const replacement = tree.content.querySelector(`[data-post-number="${anchor.dataset.postNumber}"]`);
      if (replacement) window.scrollBy(0, replacement.getBoundingClientRect().top - anchorTop);
    }
    tree.panel.hidden = false;
    // 重渲染会重建编辑器节点，输入焦点与光标位置要恢复，否则同步回流一次就把正在输入的光标顶掉。
    if (focusedBoostInput && tree.boostEditor) focusReplyTreeBoostInput(tree);
    if (state.replyTreeNativeTopicId !== tree.topicId) {
      tree.streamElement.dataset.betterldReplySource = "true";
      tree.topicContainer.dataset.betterldReplyTreeActive = "true";
    }
    tree.more.hidden = !tree.autoLoadPaused;
    if (!tree.targetLocated && byNumber.has(tree.targetPostNumber)) {
      tree.targetLocated = true;
      setTimeout(() => {
        if (state.replyTree === tree && state.replyTreeNativeTopicId !== tree.topicId) {
          tree.content.querySelector(`[data-post-number="${tree.targetPostNumber}"]`)?.scrollIntoView({ block: "center" });
        }
      }, config.replyTreeDeepLinkDelayMs);
    }
  }

  function preloadedReplyTopic(topicId) {
    const source = document.querySelector("#data-preloaded")?.textContent;
    if (!source) return null;
    try {
      const topic = JSON.parse(source)[`topic_${topicId}`];
      if (!topic) return null;
      return JSON.parse(topic);
    } catch (error) {
      console.error("[betterLD] preloaded reply data is invalid; requesting topic JSON", error);
      return null;
    }
  }

  async function loadReplyTree(tree, more = false) {
    if (tree.busy) return;
    tree.busy = true;
    tree.more.disabled = true;
    tree.status.textContent = "正在读取回复…";
    try {
      const active = () => state.replyTree === tree && topicIdFromPath() === tree.topicId;
      let data;
      let nearbyPosts = [];
      if (!more) {
        const preloaded = preloadedReplyTopic(tree.topicId);
        const startsAtFirstPost = preloaded?.post_stream?.posts?.some((post) => post.post_number === 1);
        data = startsAtFirstPost ? preloaded : await requestTopicResponse(`/t/${tree.topicId}.json`, active);
        if (!active()) return;
        if (!startsAtFirstPost && Array.isArray(preloaded?.post_stream?.posts)) nearbyPosts = preloaded.post_stream.posts;
        const stream = data?.post_stream?.stream;
        if (!Array.isArray(stream) || !Array.isArray(data?.post_stream?.posts) || !data.post_stream.posts.some((post) => post.post_number === 1)) {
          throw new Error("主题回复数据格式不正确");
        }
        tree.stream = stream;
      } else {
        const ids = tree.stream.filter((id) => !tree.loaded.has(id)).slice(0, config.replyTreePageSize);
        const params = new URLSearchParams();
        ids.forEach((id) => params.append("post_ids[]", id));
        data = await requestTopicResponse(`/t/${tree.topicId}/posts.json?${params}`, active);
        if (!active()) return;
        if (!Array.isArray(data?.post_stream?.posts)) throw new Error("回复分页数据格式不正确");
        ids.forEach((id) => tree.loaded.add(id));
      }
      const streamIds = new Set(tree.stream);
      [...data.post_stream.posts, ...nearbyPosts].forEach((post) => {
        if (Number.isInteger(post.id) && Number.isInteger(post.post_number) && streamIds.has(post.id)) {
          tree.posts.set(post.id, post);
          tree.loaded.add(post.id);
        }
      });
      if (!tree.posts.size) throw new Error("主题没有可读取的帖子");
      renderReplyTree(tree);
      tree.status.textContent = "";
    } catch (error) {
      if (state.replyTree === tree) {
        console.error("[betterLD] reply tree load failed", error);
        tree.panel.hidden = false;
        tree.autoLoadPaused = true;
        tree.status.textContent = `树状回复读取失败：${error.message}。${tree.posts.size ? "可通过楼层链接进入原站回复。" : "原站回复保持可用。"}`;
        tree.more.hidden = false;
        tree.more.textContent = "重试加载回复";
      }
    } finally {
      tree.busy = false;
      tree.more.disabled = false;
      requestAnimationFrame(() => maybeLoadMoreReplyTree(tree));
    }
  }

  function maybeLoadMoreReplyTree(tree) {
    if (state.replyTree !== tree || tree.busy || tree.autoLoadPaused || tree.contentContainer.hidden) return;
    if (!tree.stream.some((id) => !tree.loaded.has(id))) return;
    const boundary = tree.sentinel.getBoundingClientRect();
    if (boundary.top <= innerHeight + config.replyTreeLoadAheadPx && boundary.bottom >= 0) loadReplyTree(tree, true);
  }

  function replyTreeCurrentPost(tree) {
    if (tree.positionedPost && tree.positionedPost.scrollY === pageScrollTop()) return tree.positionedPost;
    tree.positionedPost = null;
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    const cards = [...tree.content.querySelectorAll('.betterld-reply-tree__card')];
    const visible = cards.find((card) => card.getBoundingClientRect().bottom > headerHeight && card.getClientRects().length);
    const postNumber = Number(visible?.parentElement.dataset.postNumber) || 1;
    const postId = [...tree.posts.values()].find((post) => post.post_number === postNumber)?.id;
    return { postNumber, postId };
  }

  async function syncReplyTreeData(tree) {
    if (tree.busy || !tree.pendingData) return;
    const data = tree.pendingData;
    tree.pendingData = null;
    if (data.error) {
      tree.status.textContent = `回复实时同步失败：${data.error}`;
      return;
    }
    if (!data.stream.length) return;
    const added = data.stream.filter((id) => !tree.stream.includes(id));
    tree.stream = data.stream;
    const streamIds = new Set(tree.stream);
    let changed = false;
    for (const [id] of tree.posts) {
      if (!streamIds.has(id)) {
        tree.posts.delete(id);
        tree.loaded.delete(id);
        changed = true;
      }
    }
    for (const post of data.posts) {
      if (!streamIds.has(post.id) || !post.cooked) continue;
      const previous = tree.posts.get(post.id);
      if (previous && Object.keys(post).every((key) => JSON.stringify(previous[key]) === JSON.stringify(post[key]))) continue;
      tree.posts.set(post.id, { ...previous, ...post });
      tree.loaded.add(post.id);
      changed = true;
    }
    added.forEach((id) => { if (!tree.loaded.has(id)) tree.liveIds.add(id); });
    if (changed && tree.posts.has(tree.stream[0])) renderReplyTree(tree);
    if (!tree.liveIds.size || tree.autoLoadPaused) return;
    tree.liveIds = new Set([...tree.liveIds].filter((id) => tree.stream.includes(id) && !tree.loaded.has(id)));
    if (!tree.liveIds.size) return;
    tree.busy = true;
    const ids = [...tree.liveIds].slice(0, config.replyTreePageSize);
    try {
      const params = new URLSearchParams();
      ids.forEach((id) => params.append('post_ids[]', id));
      const result = await requestTopicResponse(`/t/${tree.topicId}/posts.json?${params}`, () => state.replyTree === tree);
      if (state.replyTree !== tree) return;
      if (!Array.isArray(result?.post_stream?.posts)) throw new Error('新回复数据格式不正确');
      for (const post of result.post_stream.posts) {
        if (!tree.stream.includes(post.id)) continue;
        tree.posts.set(post.id, post);
        tree.loaded.add(post.id);
      }
      ids.forEach((id) => tree.liveIds.delete(id));
      renderReplyTree(tree);
      tree.status.textContent = '';
    } catch (error) {
      if (state.replyTree === tree) {
        console.error('[betterLD] live replies failed', error);
        tree.autoLoadPaused = true;
        tree.status.textContent = `新回复同步失败：${error.message}`;
        tree.more.hidden = false;
      }
    } finally {
      tree.busy = false;
    }
  }

  async function jumpReplyTree(tree, postNumber, postId, requestId) {
    if (tree.busy) {
      tree.pendingJump = { postNumber, postId, requestId };
      return;
    }
    tree.busy = true;
    let errorMessage = "";
    try {
      let post = postId ? tree.posts.get(postId) : [...tree.posts.values()].find((entry) => entry.post_number === postNumber);
      if (!post) {
        const endpoint = postId ? `/t/${tree.topicId}/posts.json?post_ids[]=${postId}` : `/t/${tree.topicId}/${postNumber}.json`;
        const data = await requestTopicResponse(endpoint, () => state.replyTree === tree);
        if (state.replyTree !== tree) return;
        if (!Array.isArray(data?.post_stream?.posts)) throw new Error('跳转楼层数据格式不正确');
        for (const entry of data.post_stream.posts) {
          if (!tree.stream.includes(entry.id)) continue;
          tree.posts.set(entry.id, entry);
          tree.loaded.add(entry.id);
        }
        post = postId ? tree.posts.get(postId) : [...tree.posts.values()].find((entry) => entry.post_number === postNumber);
      }
      if (!post) throw new Error(`目标楼层不存在或不可访问`);
      postNumber = post.post_number;
      let parent = Number(post.reply_to_post_number);
      while (parent > 1) {
        tree.collapsed.delete(parent);
        const parentPost = [...tree.posts.values()].find((entry) => entry.post_number === parent);
        parent = Number(parentPost?.reply_to_post_number);
      }
      tree.collapsed.delete(1);
      tree.targetLocated = true;
      renderReplyTree(tree);
      const card = tree.content.querySelector(`[data-post-number="${postNumber}"] > .betterld-reply-tree__card`);
      const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
      window.scrollTo({ top: pageScrollTop() + card.getBoundingClientRect().top - headerHeight, behavior: 'instant' });
      // 末楼可能无法贴到视口顶部；在用户实际滚动前保持刚命中的楼号。
      tree.positionedPost = { postNumber, postId: post.id, scrollY: pageScrollTop() };
      tree.status.textContent = '';
    } catch (error) {
      errorMessage = `楼层跳转失败：${error.message}`;
      if (state.replyTree === tree) tree.status.textContent = errorMessage;
    } finally {
      tree.busy = false;
      if (state.replyTree === tree && requestId) {
        document.dispatchEvent(new CustomEvent('betterld:reply-jumped', {
          detail: JSON.stringify({ topicId: tree.topicId, requestId, postNumber, error: errorMessage })
        }));
      }
    }
  }

  document.addEventListener('betterld:reply-data', (event) => {
    const data = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (!tree || data.topicId !== tree.topicId) return;
    tree.pendingData = data;
    syncReplyTreeData(tree);
  });
  document.addEventListener('betterld:reply-jump', (event) => {
    const data = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId === data.topicId && !tree.contentContainer.hidden) jumpReplyTree(tree, data.postNumber, data.postId, data.requestId);
  });

  function syncReplyTree() {
    const topicId = topicIdFromPath();
    document.body.dataset.betterldTopicDetail = String(Boolean(topicId));
    const stream = topicId && document.querySelector(".container.posts .post-stream");
    if (state.replyTree && (state.replyTree.topicId !== topicId || !stream || state.replyTree.panel.parentElement !== stream.parentElement)) {
      if (state.replyTree.topicId === topicId && state.replyTree.posts.size) {
        state.replyTreeSnapshot = state.replyTree;
      } else {
        state.replyTreeSnapshot = null;
      }
      state.replyTree.observer.disconnect();
      clearInterval(state.replyTree.relativeTimeTimer);
      closeReplyReactionPicker(state.replyTree);
      state.replyTree.streamElement.removeAttribute("data-betterld-reply-source");
      state.replyTree.topicContainer.removeAttribute("data-betterld-reply-tree-active");
      state.replyTree.panel.remove();
      document.dispatchEvent(new CustomEvent('betterld:timeline-reset'));
      state.replyTree = null;
    }
    if (!topicId) {
      state.replyTreeNativeTopicId = "";
      state.replyTreeSnapshot = null;
    }
    if (!topicId || !stream) return;
    if (state.replyTree) {
      const tree = state.replyTree;
      if (tree.pendingJump && !tree.busy) {
        const { postNumber, postId, requestId } = tree.pendingJump;
        tree.pendingJump = null;
        jumpReplyTree(tree, postNumber, postId, requestId);
      }
      if (tree.liveIds.size && !tree.pendingData) tree.pendingData = { stream: tree.stream, posts: [] };
      syncReplyTreeData(tree);
      // 续载由路由轮询驱动：交叉观察器只在可见性变化时回调一次，标签页隐藏、窗口遮挡或回调落在忙碌期间都会让续载链停住，
      // 而新回复同步是定时驱动的，会继续追加末尾楼层，于是树里只剩首屏窗口加上最新楼层、中间楼层一直读不出来。
      maybeLoadMoreReplyTree(tree);
      if (state.pageRefreshBridge && tree.bridgeReady) {
        document.dispatchEvent(new CustomEvent('betterld:reply-sync', {
          detail: JSON.stringify({ topicId, ...replyTreeCurrentPost(tree), active: !tree.contentContainer.hidden, timeoutMs: config.pageRefreshTimeoutMs })
        }));
      }
      return;
    }
    if (state.replyTreeNativeTopicId && state.replyTreeNativeTopicId !== topicId) state.replyTreeNativeTopicId = "";
    const previous = state.replyTreeSnapshot?.topicId === topicId ? state.replyTreeSnapshot : null;
    state.replyTreeSnapshot = null;
    const panel = createElement("section", "betterld-reply-tree");
    panel.setAttribute("aria-label", "树状回复");
    const toggle = createElement("button", "betterld-reply-tree__toggle", "返回树状回复");
    toggle.type = "button";
    toggle.hidden = state.replyTreeNativeTopicId !== topicId;
    const content = createElement("div", "betterld-reply-tree__content");
    content.hidden = state.replyTreeNativeTopicId === topicId;
    const replies = createElement("div");
    const status = createElement("p", "betterld-reply-tree__status", previous?.autoLoadPaused ? previous.status.textContent : "");
    status.setAttribute("role", "status");
    const sentinel = createElement("div", "betterld-reply-tree__sentinel");
    sentinel.setAttribute("aria-hidden", "true");
    const moreButton = createElement("button", "betterld-reply-tree__more", "重试加载回复");
    moreButton.type = "button";
    moreButton.hidden = !previous?.autoLoadPaused;
    content.append(replies, status, sentinel, moreButton);
    panel.append(toggle, content);
    stream.before(panel);
    const targetPostNumber = Number(location.pathname.match(/^\/t\/(?:\d+|[^/]+\/\d+)\/(\d+)\/?$/)?.[1]) || 0;
    const tree = { topicId, panel, toggle, contentContainer: content, streamElement: stream, topicContainer: stream.closest(".container.posts"), content: replies, status, sentinel, more: moreButton, posts: previous?.posts || new Map(), loaded: previous?.loaded || new Set(), stream: previous?.stream || [], collapsed: previous?.collapsed || new Set(), autoLoadPaused: previous?.autoLoadPaused || false, targetPostNumber, targetLocated: false, busy: false, boostEditor: null };
    tree.observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) maybeLoadMoreReplyTree(tree);
    }, { rootMargin: `0px 0px ${config.replyTreeLoadAheadPx}px 0px` });
    tree.observer.observe(sentinel);
    tree.liveIds = previous?.liveIds || new Set();
    state.replyTree = tree;
    loadPageRefreshBridge().then(() => {
      if (state.replyTree === tree) tree.bridgeReady = true;
    }).catch((error) => {
      console.error('[betterLD] reply bridge failed', error);
      if (state.replyTree === tree) tree.status.textContent = `回复实时同步与楼层跳转不可用：${error.message}`;
    });
    tree.relativeTimeTimer = setInterval(() => refreshReplyTreeTimes(tree), config.replyTreeTimeRefreshMs);
    toggle.addEventListener("click", () => {
      state.replyTreeNativeTopicId = "";
      toggle.hidden = true;
      content.hidden = false;
      if (tree.posts.size) {
        renderReplyTree(tree);
        requestAnimationFrame(() => maybeLoadMoreReplyTree(tree));
      } else loadReplyTree(tree);
    });
    moreButton.addEventListener("click", () => {
      tree.autoLoadPaused = false;
      moreButton.hidden = true;
      if (tree.liveIds.size) {
        tree.pendingData = { stream: tree.stream, posts: [] };
        syncReplyTreeData(tree);
      } else loadReplyTree(tree, tree.posts.size > 0);
    });
    if (content.hidden) panel.hidden = false;
    else if (tree.posts.size) {
      renderReplyTree(tree);
      requestAnimationFrame(() => maybeLoadMoreReplyTree(tree));
    } else loadReplyTree(tree);
  }

  function checkDailyWallpaper() {
    if (state.currentSettings.wallpaperMode !== config.wallpaperModes.random) {
      return;
    }
    if (state.currentSettings.wallpaperRandomDate !== localDateKey()) {
      applyVisualSettings(state.currentSettings);
    }
  }

  // 必须在 href 变化判断之前：设置窗口关闭后 URL 没变，但排序要立刻落下去
  function checkRoute() {
    checkDailyWallpaper();
    recordVisitedTopic();
    syncReplyTree();
    applyTopicSort();
    enforceRefreshScrollTop();
    // 站点结果异步渲染，触点与结果列表出现得比注入晚，因此每次轮询重试一次状态同步
    syncSearchLoadMore(state.currentSettings, isSearchPage());
    if (location.href === state.currentHref) {
      return;
    }
    state.currentHref = location.href;
    updateRouteState();
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".betterld-topic-card__menu")) {
      closeCardMenus();
    }
    // 站点的「查看 N 个新的或更新过的话题」就是列表刷新，记下意图，重建后回到页首
    if (event.target.closest?.(".show-more.has-topics")) {
      state.listRefreshAt = Date.now();
    }
    // 用 composedPath 而不是 closest：面板里的按钮点完就会被重渲染换掉，
    // 换掉之后节点已经脱离文档，closest 找不到面板，会把刚重绘的面板误关掉
    const insideSearchHistory = event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-betterld-search-history"));
    if (!insideSearchHistory && !searchInputs().includes(event.target)) {
      closeSearchHistoryPanel();
    }
  });
  document.addEventListener("keydown", (event) => {
    handleShortcut(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "Escape" && state.openMenu) {
      closeCardMenu(state.openMenu, true);
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target.matches?.("[role=menuitem]")) {
      const menuItems = [...event.target.closest("[role=menu]")?.querySelectorAll("[role=menuitem]") || []];
      const current = menuItems.indexOf(event.target);
      if (current >= 0 && menuItems.length) {
        event.preventDefault();
        const next = event.key === "ArrowDown"
          ? (current + 1) % menuItems.length
          : (current - 1 + menuItems.length) % menuItems.length;
        menuItems[next].focus();
      }
    }
  });
  document.addEventListener("focusin", (event) => {
    if (event.target.closest?.(".d-header")) {
      document.documentElement.dataset.betterldHeaderState = "visible";
    }
  });

  ensureSettingsTrigger();

  state.excerptObserver = "IntersectionObserver" in globalThis
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          state.excerptVisible.add(entry.target);
          scheduleExcerpt(entry.target);
        } else {
          state.excerptVisible.delete(entry.target);
          cancelExcerpt(entry.target);
        }
      });
    }, { rootMargin: config.excerptRootMargin })
    : null;

  applyVisualSettings(config.settingsDefaults);
  seedPreloadedTopicList();
  storageGet()
    .then(async (stored) => {
      state.localWallpaper = isStoredLocalWallpaper(stored[config.wallpaperLocalStorageKey])
        ? stored[config.wallpaperLocalStorageKey]
        : null;
      state.remoteWallpaperCache = stored[config.wallpaperRemoteCacheKey]
        && typeof stored[config.wallpaperRemoteCacheKey] === "object"
        ? stored[config.wallpaperRemoteCacheKey]
        : null;
      state.visitedTopics = new Set(Array.isArray(stored[config.visitedTopicStorageKey]) ? stored[config.visitedTopicStorageKey] : []);
      // 站点限速按 IP 计，上一个页面撞上冷却时新页面要接着等，不能重新起一轮突发请求
      const storedCooldown = Number(stored[config.topicRequestCooldownStorageKey]);
      if (Number.isFinite(storedCooldown) && storedCooldown > Date.now()) {
        state.metadataCooldownUntil = storedCooldown;
        // 这一页从加载起就处在冷却里：照样排定到期重排，否则整页卡片会一直停在限速文案上。
        scheduleExcerptThrottleRetry();
      }
      const activeSettings = await getActiveSettings(stored[config.storageKey]);
      applyVisualSettings(activeSettings);
      state.settingsResolved = true;
      scheduleSync();
    })
    .catch((error) => {
      state.activeStorageArea = "local";
      state.localWallpaper = null;
      console.error("[betterLD] settings load failed; using defaults", error);
      applyVisualSettings(config.settingsDefaults, { forceFallback: true });
      state.settingsResolved = true;
    });

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes[config.storageKey] && state.currentSettings.syncEnabled) {
      state.activeStorageArea = "sync";
      const merged = normalizeSettings({ ...state.currentSettings, ...changes[config.storageKey].newValue });
      storageSet({ [config.storageKey]: merged }).catch((error) => {
        console.error("[betterLD] synced settings local projection failed", error);
      });
      applyVisualSettings(merged);
      scheduleSync();
      return;
    }
    if (areaName !== "local") {
      return;
    }
    if (changes[config.wallpaperLocalStorageKey]) {
      state.localWallpaper = isStoredLocalWallpaper(changes[config.wallpaperLocalStorageKey].newValue)
        ? changes[config.wallpaperLocalStorageKey].newValue
        : null;
      if (state.currentSettings.wallpaperMode === config.wallpaperModes.local) {
        applyVisualSettings(state.currentSettings);
      }
    }
    if (changes[config.visitedTopicStorageKey]) {
      state.visitedTopics = new Set(Array.isArray(changes[config.visitedTopicStorageKey].newValue) ? changes[config.visitedTopicStorageKey].newValue : []);
      scheduleSync();
    }
    if (changes[config.storageKey]) {
      const localSettings = normalizeSettings(changes[config.storageKey].newValue);
      if (!localSettings.syncEnabled || state.activeStorageArea === "local" || !state.currentSettings.syncEnabled) {
        getActiveSettings(localSettings)
          .then((activeSettings) => {
            applyVisualSettings(activeSettings);
            scheduleSync();
          })
          .catch((error) => {
            console.error("[betterLD] active settings read failed", error);
          });
      }
    }
  });

  const domObserver = new MutationObserver((records) => {
    // 只镜像原站变化；卡片内部的作者、预览与筛选结果不能再次驱动源列表同步。
    if (records.some(({ target }) => {
      const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      return !element?.closest('[data-betterld-grid="true"]');
    })) {
      scheduleSync();
    }
  });
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "href", "src", "srcset", "data-topic-id", "data-user-card", "title", "hidden"]
  });

  const modeObserver = new MutationObserver(applyColorMode);
  modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-color-scheme", "data-theme", "data-theme-name"] });
  if (document.body) {
    modeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-color-scheme", "data-theme", "data-theme-name"] });
  }
  const colorSchemeMedia = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  colorSchemeMedia?.addEventListener?.("change", applyColorMode);
  const coarsePointerMedia = globalThis.matchMedia?.("(pointer: coarse)");
  coarsePointerMedia?.addEventListener?.("change", applyChromeSettings);

  window.addEventListener("scroll", () => {
    updateListControlsScrollState();
    deferExcerptLoads();
    state.excerptLastScrollAt = Date.now();
    scheduleExcerptPrefetch();
  }, { passive: true });
  window.addEventListener("resize", resizeTopicDrawer);
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  state.currentHref = location.href;
  updateRouteState();
  window.setInterval(checkRoute, config.routePollMs);
})();
