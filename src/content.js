(() => {
  "use strict";

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
    cards: "Material 3 卡片",
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
    localWallpaper: null,
    remoteWallpaperCache: null,
    topicSortRedirect: "",
    excerptCache: new Map(),
    excerptObserver: null,
    cardObserver: null,
    topicRequestQueue: [],
    topicRequestActive: 0,
    topicRequestLastStart: 0,
    topicRequestPausedUntil: 0,
    topicRequestPump: 0,
    topicRequestRecoveryTimer: 0,
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
    toastTimer: 0
  };

  function storageGet(keys) {
    const storageKeys = keys || [config.storageKey, config.wallpaperLocalStorageKey, config.wallpaperRemoteCacheKey, config.visitedTopicStorageKey];
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

    state.currentSettings = settings;
    if (!options.provisional) {
      state.settingsResolved = true;
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
    root.style.setProperty("--betterld-card-min-size", `${settings.cardMinSize}px`);
    root.style.setProperty("--betterld-card-side-gutter", `${settings.cardSideGutter}px`);
    root.style.setProperty("--betterld-grid-gap", `${settings.gridGap}px`);
    root.style.setProperty("--betterld-surface-blur", settings.frostedGlassEnabled ? `${settings.surfaceBlurPx}px` : "0px");
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

    const wallpaperUrl = resolveWallpaper(settings);
    if (!wallpaperUrl) {
      const hasWallpaperCandidate = settings.wallpaperMode !== config.wallpaperModes.none;
      setWallpaperState(root, options.forceFallback || hasWallpaperCandidate ? "fallback" : "default");
      return;
    }

    if (remoteWallpaperCacheIsFresh(settings, wallpaperUrl)) {
      root.style.setProperty("--betterld-wallpaper-image", `url(${JSON.stringify(wallpaperUrl)})`);
      setWallpaperState(root, "ready");
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
      console.warn("[betterLD] wallpaper could not be decoded; using the safe gradient", wallpaperUrl);
    };
    const ready = () => {
      if (wallpaperRequest !== state.wallpaperRequest) {
        return;
      }
      root.style.setProperty("--betterld-wallpaper-image", `url(${JSON.stringify(wallpaperUrl)})`);
      recordRemoteWallpaperCache(settings, wallpaperUrl, true);
      setWallpaperState(root, "ready");
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
    const luminance = rgb.map((part) => part / 255).map((part) => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
    const relative = 0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2];
    return relative > 0.42 ? "#1c1b1f" : "#ffffff";
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
    const primary = settings.themeColor;
    const background = settings.darkModeBaseColor;
    const primaryRgb = hexToRgb(primary);
    const backgroundRgb = hexToRgb(background);
    if (primaryRgb) {
      root.style.setProperty("--betterld-primary", primary);
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

  function isTopicListPage() {
    const path = currentPath();
    return isHomepage()
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
    return location.pathname.match(/^\/t\/[^/]+\/(\d+)(?:\/|$)/)?.[1] || "";
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
      location.reload();
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
        refreshWithUndoSnapshot();
      } else if (key === "undoRefresh") {
        if (restoreUndoRefreshSnapshot()) {
          state.undoRefreshSnapshot = null;
          syncFloatingActions();
          showActionStatus("已恢复刷新前的列表");
        }
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
        refreshWithUndoSnapshot();
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

  function refreshWithUndoSnapshot() {
    captureUndoRefreshSnapshot();
    markRefreshScrollTop();
    location.reload();
  }

  function markRefreshScrollTop() {
    try {
      sessionStorage.setItem(config.refreshScrollTopStorageKey, String(Date.now()));
    } catch (error) {
      console.warn("[betterLD] refresh scroll intent write failed", error);
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
    }    const holder = document.createElement("template");
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
    const creator = item.querySelector(".topic-creator-data, .topic-poster, .posters, .creator");
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

    const isReadingCard = state.currentSettings.topicListLayoutMode === "reading";
    const author = topic.id ? authorName(item) : config.authorPlaceholder;
    const category = categoryInfo(item);
    const card = createElement("article", isReadingCard ? "betterld-topic-card betterld-topic-card--reading" : "betterld-topic-card");
    const link = isReadingCard ? null : createElement("a", "betterld-topic-card__link");
    const preview = isReadingCard ? null : createElement("span", "betterld-topic-card__preview");
    const badges = createElement("span", "betterld-topic-card__badges");
    const title = createElement(isReadingCard ? "a" : "span", isReadingCard ? "betterld-topic-card__link betterld-topic-card__title betterld-topic-card__reading-title" : "betterld-topic-card__title", topic.title);
    const excerpt = createElement(isReadingCard ? "div" : "span", "betterld-topic-card__excerpt", topic.id ? config.excerptLoadingLabel : config.excerptPlaceholder);
    const identity = createElement("span", "betterld-topic-card__identity");
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

    if (isReadingCard) {
      title.href = topic.href;
      title.setAttribute("aria-label", topic.title);
      title.addEventListener("click", (event) => handleTopicCardClick(event, card, topic.href));
    } else {
      link.href = topic.href;
      link.setAttribute("aria-label", topic.title);
      link.addEventListener("click", (event) => handleTopicCardClick(event, card, topic.href));
    }
    card.dataset.topicHref = topic.href;
    card.dataset.topicId = topic.id;
    card.dataset.betterldCardStyle = isReadingCard ? "reading" : "cards";
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
    if (isReadingCard) {
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
      return card;
    }

    const footer = createElement("span", "betterld-topic-card__footer");
    preview.append(badges, title, excerpt);
    identity.append(authorElement, chip);
    footer.append(avatarElement(item), identity, meta);
    link.append(preview, footer);
    card.append(link, menu);
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
    authorElement.textContent = name;
    if (href) {
      authorElement.href = href;
    } else {
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
      openDrawer: "打开摘要抽屉",
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
    const userId = globalThis.Discourse?.User?.current()?.id;
    if (!token || !userId) {
      throw new Error("无法读取登录状态或 CSRF 令牌");
    }
    const params = new URLSearchParams();
    params.set("notification_level", "ignore");
    params.set("expiring_at", config.discourseIgnoreExpiringAt);
    params.set("acting_user_id", String(userId));
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
  }

  async function executeCardAction(action, card, menu) {
    closeCardMenu(menu);
    if (action === "ignoreAuthor") {
      const author = card.dataset.filterAuthor;
      if (!author) {
        showActionStatus("作者尚未加载完成，暂时无法屏蔽");
        return;
      }
      if (!globalThis.confirm(`确定在服务端屏蔽 @${author}？该操作会写入你的 LinuxDo 账号。`)) {
        return;
      }
      try {
        await ignoreAuthorOnServer(author);
        showActionStatus(`已在服务端屏蔽 @${author}`, "success");
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
    const details = createElement("div", "betterld-topic-drawer__details");
    const category = createElement("span", "betterld-topic-drawer__category");
    const author = createElement("span", "betterld-topic-drawer__author");
    const meta = createElement("span", "betterld-topic-drawer__meta");
    details.append(category, author, meta);
    const excerpt = createElement("p", "betterld-topic-drawer__excerpt");
    const status = createElement("p", "betterld-topic-drawer__status");
    status.setAttribute("role", "status");
    const openLink = createElement("a", "betterld-topic-drawer__open", "在当前页打开完整主题");
    openLink.target = "_self";
    dialog.append(header, details, excerpt, status, openLink);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && state.currentSettings.drawerCloseOnOverlay) {
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
      const trigger = state.drawerTrigger;
      state.drawerTrigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
    document.body.append(dialog);
    state.topicDrawer = { dialog, title, category, author, meta, excerpt, status, openLink, close };
    return state.topicDrawer;
  }

  function closeTopicDrawer() {
    const drawer = state.topicDrawer;
    if (!drawer) {
      return;
    }
    state.drawerRequest += 1;
    if (drawer.dialog.open && typeof drawer.dialog.close === "function") {
      drawer.dialog.close();
    } else {
      drawer.dialog.removeAttribute("open");
      const trigger = state.drawerTrigger;
      state.drawerTrigger = null;
      trigger?.focus();
    }
  }

  function openTopicDrawer(card) {
    const drawer = ensureTopicDrawer();
    if (!drawer) {
      showActionStatus("摘要抽屉不可用");
      return;
    }
    closeCardMenus();
    const drawerRequest = ++state.drawerRequest;
    state.drawerTrigger = card.querySelector(".betterld-topic-card__link");
    drawer.title.textContent = card.querySelector(".betterld-topic-card__title")?.textContent || "主题预览";
    drawer.category.textContent = card.querySelector(".betterld-topic-card__chip")?.textContent || "未分类";
    drawer.author.textContent = card.querySelector(".betterld-topic-card__author")?.textContent || config.authorPlaceholder;
    drawer.meta.textContent = card.querySelector(".betterld-topic-card__meta")?.textContent || "";
    drawer.openLink.href = safeTopicUrl(card.dataset.topicHref) || "#";
    drawer.excerpt.textContent = card.querySelector(".betterld-topic-card__excerpt")?.textContent || config.excerptPlaceholder;
    drawer.status.textContent = "";
    const showExcerpt = card.dataset.excerptState === "ready";
    if (!showExcerpt && card.dataset.topicId) {
      drawer.status.textContent = config.excerptLoadingLabel;
      requestExcerpt(card.dataset.topicId)
        .then((metadata) => {
          if (drawerRequest !== state.drawerRequest) {
            return;
          }
          drawer.excerpt.textContent = metadata.text;
          drawer.status.textContent = "";
          setExcerpt(card, metadata.text, metadata.contentState, metadata.markdown);
          setReadingStats(card, metadata.stats);
          setReadingParticipants(card, metadata.participants);
        })
        .catch((error) => {
          if (drawerRequest !== state.drawerRequest) {
            return;
          }
          drawer.status.textContent = error instanceof Error ? error.message : config.excerptPlaceholder;
          drawer.excerpt.textContent = config.excerptPlaceholder;
        });
    }
    if (typeof drawer.dialog.showModal === "function") {
      if (!drawer.dialog.open) {
        drawer.dialog.showModal();
      }
    } else {
      drawer.dialog.setAttribute("open", "");
    }
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

  // 单次请求：重试交给卡片层（带延迟）、限速退避交给全局队列，不再在这里自旋
  async function fetchTopicMetadata(topicId) {
    const endpoint = new URL(`/t/${topicId}.json`, location.origin);
    endpoint.searchParams.set("include_raw", "1");
    const response = await fetch(endpoint.href, {
      credentials: "same-origin",
      cache: "no-store",
      headers: discourseAjaxHeaders
    });

    if (isRateLimitResponse(response)) {
      const error = rateLimitedError(response);
      pauseTopicRequests(error.retryAfterMs);
      throw error;
    }
    if (!response.ok) {
      throw new Error(`topic request failed with ${response.status}`);
    }

    const data = await response.json();
    const post = data?.post_stream?.posts?.[0];
    const raw = String(post?.raw || "").trim().slice(0, config.excerptMaxCharacters);
    const cooked = String(post?.cooked || "").trim();
    const text = plainText(cooked || raw);
    const markdown = raw || text;
    const contentState = markdown ? "ready" : "empty";
    return {
      text: contentState === "ready" ? text || markdown : config.excerptEmptyLabel,
      markdown,
      contentState,
      author: cleanText(data?.details?.created_by?.username),
      activityAt: cleanText(data?.last_posted_at || data?.bumped_at || data?.created_at),
      stats: topicStats(data),
      participants: topicParticipants(data)
    };
  }

  function rateLimitedError(response) {    const error = new Error(`topic request rate limited with ${response.status}`);
    error.rateLimited = true;
    error.retryAfterMs = retryAfterMs(response);
    return error;
  }

  function retryAfterMs(response) {
    const header = Number(response.headers.get("Retry-After"));
    return Number.isFinite(header) && header > 0 ? header * 1000 : config.topicRequestPauseMs;
  }

  // 429/503 是站点限速；403 带 cf-mitigated: challenge 是 Cloudflare 质询，两者都按暂停处理
  function isRateLimitResponse(response) {
    return response.status === 429
      || response.status === 503
      || (response.status === 403 && response.headers.get("cf-mitigated") === "challenge");
  }

  function pauseTopicRequests(waitMs) {
    const until = Date.now() + waitMs;
    if (until <= state.topicRequestPausedUntil) {
      return;
    }
    state.topicRequestPausedUntil = until;
    console.warn(`[betterLD] topic requests paused for ${waitMs}ms after a rate limit response`);
    window.clearTimeout(state.topicRequestPump);
    state.topicRequestPump = 0;
    // 暂停期间不再把已排队的请求发出去，只保留一次补扫，避免限速后成倍放大请求
    state.topicRequestQueue.splice(0).forEach((entry) => entry.reject(entry.error));
    scheduleRateLimitRecovery(waitMs);
  }

  function scheduleRateLimitRecovery(waitMs) {
    window.clearTimeout(state.topicRequestRecoveryTimer);
    state.topicRequestRecoveryTimer = window.setTimeout(() => {
      state.topicRequestRecoveryTimer = 0;
      reloadFailedCards();
    }, waitMs + config.topicRequestRetryDelayMs);
  }

  function reloadFailedCards() {
    document.querySelectorAll(".betterld-topic-card").forEach((card) => {
      const topicId = card.dataset.topicId;
      if (!topicId || !card.isConnected) {
        return;
      }
      if (card.dataset.authorState === "failed") {
        card.dataset.authorRetryCount = "0";
        card.dataset.authorState = "loading";
        setAuthor(card, config.authorLoadingLabel, "loading");
      }
      if (card.dataset.excerptState === "failed") {
        card.dataset.excerptRetryCount = "0";
        card.dataset.excerptState = "loading";
        card.setAttribute("aria-busy", "true");
        setExcerpt(card, config.excerptLoadingLabel, "loading");
      }
      state.excerptCache.delete(topicId);
      observeCard(card);
    });
  }

  function pumpTopicRequests() {
    if (state.topicRequestPump) {
      return;
    }
    while (state.topicRequestActive < config.topicRequestConcurrency && state.topicRequestQueue.length) {
      const now = Date.now();
      const wait = Math.max(state.topicRequestLastStart + config.topicRequestMinGapMs - now, state.topicRequestPausedUntil - now);
      if (wait > 0) {
        state.topicRequestPump = window.setTimeout(() => {
          state.topicRequestPump = 0;
          pumpTopicRequests();
        }, wait);
        return;
      }
      const entry = state.topicRequestQueue.shift();
      state.topicRequestLastStart = now;
      state.topicRequestActive += 1;
      entry.run()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          state.topicRequestActive -= 1;
          pumpTopicRequests();
        });
    }
  }

  function enqueueTopicRequest(run, placeholder) {
    return new Promise((resolve, reject) => {
      state.topicRequestQueue.push({ run, resolve, reject, error: placeholder });
      pumpTopicRequests();
    });
  }

  function pruneTopicMetadataCache() {
    const prefix = config.topicMetadataCachePrefix;
    const keys = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    while (keys.length > config.topicMetadataCacheMaxEntries) {
      sessionStorage.removeItem(keys.shift());
    }
  }

  function readTopicMetadataCache(topicId) {
    try {
      const stored = sessionStorage.getItem(config.topicMetadataCachePrefix + topicId);
      if (!stored) {
        return null;
      }
      const entry = JSON.parse(stored);
      if (!entry || Date.now() - Number(entry.at || 0) > config.topicMetadataCacheTtlMs) {
        sessionStorage.removeItem(config.topicMetadataCachePrefix + topicId);
        return null;
      }
      return entry.metadata || null;
    } catch (error) {
      console.warn("[betterLD] topic metadata cache read failed", error);
      return null;
    }
  }

  function writeTopicMetadataCache(topicId, metadata) {
    try {
      sessionStorage.setItem(config.topicMetadataCachePrefix + topicId, JSON.stringify({ at: Date.now(), metadata }));
      pruneTopicMetadataCache();
    } catch (error) {
      console.warn("[betterLD] topic metadata cache write failed", error);
    }
  }

  function requestTopicMetadata(topicId) {
    const cached = state.excerptCache.get(topicId);
    if (cached?.state === "ready") {
      return Promise.resolve(cached);
    }
    if (cached?.state === "pending") {
      return cached.promise;
    }
    if (cached) {
      state.excerptCache.delete(topicId);
    }

    const restored = readTopicMetadataCache(topicId);
    if (restored) {
      state.excerptCache.set(topicId, { state: "ready", ...restored });
      return Promise.resolve(state.excerptCache.get(topicId));
    }

    const rateLimited = new Error(`topic request skipped for ${topicId} after a rate limit response`);
    rateLimited.rateLimited = true;
    const promise = enqueueTopicRequest(() => fetchTopicMetadata(topicId), rateLimited)
      .then((metadata) => {
        writeTopicMetadataCache(topicId, metadata);
        state.excerptCache.set(topicId, { state: "ready", ...metadata });
        return metadata;
      })
      .catch((error) => {
        state.excerptCache.set(topicId, { state: error.rateLimited ? "rate-limited" : "failed", error });
        throw error;
      });

    state.excerptCache.set(topicId, { state: "pending", promise });
    return promise;
  }

  function requestExcerpt(topicId) {
    return requestTopicMetadata(topicId);
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
    card.setAttribute("aria-busy", String(card.dataset.authorState === "loading" || card.dataset.excerptState === "loading"));
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
    if (stateName === "ready" && card.dataset.betterldCardStyle === "reading") {
      markdownApi.render(excerpt, markdown || text);
    } else {
      excerpt.textContent = text;
    }
    excerpt.dataset.state = stateName;
    card.dataset.excerptState = stateName;
    card.setAttribute("aria-busy", String(card.dataset.authorState === "loading" || stateName === "loading"));
  }

  function scheduleTopicMetadataRecovery(card) {
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
        card.dataset.authorRetryCount = "0";
        setAuthor(card, config.authorLoadingLabel, "loading");
      }
      if (excerptFailed) {
        card.dataset.excerptRetryCount = "0";
        setExcerpt(card, config.excerptLoadingLabel, "loading");
      }
      if (authorFailed) {
        loadAuthor(card);
      }
      if (excerptFailed) {
        loadExcerpt(card);
      }
    }, config.topicRequestRecoveryDelayMs);
  }

  function loadAuthor(card) {
    if (card.dataset.authorState !== "loading" || !card.dataset.topicId) {
      return;
    }

    const topicId = card.dataset.topicId;
    requestTopicMetadata(topicId)
      .then((metadata) => {
        if (!metadata.author) {
          throw new Error("topic creator username unavailable");
        }
        setAuthor(card, metadata.author, "ready");
        setTopicActivity(card, metadata.activityAt);
      })
      .catch((error) => {
        console.warn(`[betterLD] topic creator unavailable for topic ${topicId}`, error);
        setAuthor(card, config.authorPlaceholder, "failed");
        if (error.rateLimited) {
          return;
        }
        const retryCount = Number(card.dataset.authorRetryCount || 0);
        if (!card.isConnected) {
          return;
        }
        if (retryCount >= config.topicRequestRetryCount) {
          scheduleTopicMetadataRecovery(card);
          return;
        }
        card.dataset.authorRetryCount = String(retryCount + 1);
        window.setTimeout(() => {
          if (!card.isConnected || card.dataset.authorState === "ready") {
            return;
          }
          card.dataset.authorState = "loading";
          setAuthor(card, config.authorLoadingLabel, "loading");
          loadAuthor(card);
        }, config.topicRequestRetryDelayMs * (retryCount + 1));
      });
  }

  function loadExcerpt(card) {
    if (card.dataset.excerptState !== "loading" || !card.dataset.topicId) {
      return;
    }

    const topicId = card.dataset.topicId;
    requestExcerpt(topicId)
      .then((metadata) => {
        setExcerpt(card, metadata.text, metadata.contentState, metadata.markdown);
        setReadingStats(card, metadata.stats);
        setReadingParticipants(card, metadata.participants);
      })
      .catch((error) => {
        console.warn(`[betterLD] topic excerpt unavailable for topic ${topicId}`, error);
        setExcerpt(card, config.excerptPlaceholder, "failed");
        if (error.rateLimited) {
          return;
        }
        const retryCount = Number(card.dataset.excerptRetryCount || 0);
        if (!card.isConnected) {
          return;
        }
        if (retryCount >= config.topicRequestRetryCount) {
          scheduleTopicMetadataRecovery(card);
          return;
        }
        card.dataset.excerptRetryCount = String(retryCount + 1);
        window.setTimeout(() => {
          if (!card.isConnected || card.dataset.excerptState === "ready") {
            return;
          }
          card.dataset.excerptState = "loading";
          card.setAttribute("aria-busy", "true");
          loadExcerpt(card);
        }, config.topicRequestRetryDelayMs * (retryCount + 1));
      });
  }

  function observeExcerpt(card) {
    const needsReadingMetadata = card.dataset.betterldCardStyle === "reading" && state.currentSettings.showTopicMeta;
    if ((!state.currentSettings.showTopicExcerpt && !needsReadingMetadata)
      || card.hidden
      || card.dataset.filterState === "hidden"
      || card.dataset.filterState === "pending") {
      return;
    }
    if (state.excerptObserver) {
      state.excerptObserver.observe(card);
      return;
    }
    loadExcerpt(card);
  }

  function needsAllTopicActivity() {
    return state.currentSettings.topicFilterEnabled && Number(state.currentSettings.topicFilterMaxAgeDays) > 0;
  }

  function loadCardMetadata(card) {
    loadAuthor(card);
    observeExcerpt(card);
  }

  function ensureAuthorMetadata(card) {
    if (needsAllTopicActivity() || !state.cardObserver) {
      loadAuthor(card);
      return;
    }
    state.cardObserver.observe(card);
  }

  function observeCard(card) {
    applyCardFilter(card);
    if (!card.dataset.topicId) {
      return;
    }
    // 只有「按活动天数过滤」才需要整列表的活动时间；其余情况按视口加载，
    // 避免一屏之外的几十个主题在页面加载时同时请求 /t/{id}.json。
    if (needsAllTopicActivity() || !state.cardObserver) {
      loadCardMetadata(card);
      return;
    }
    state.cardObserver.observe(card);
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

  function syncManagedCardContent() {
    document.querySelectorAll('[data-betterld-grid="true"] .betterld-topic-card').forEach((card) => {
      applyCardFilter(card);
      if (card.dataset.authorState === "loading") {
        ensureAuthorMetadata(card);
      }
      observeExcerpt(card);
      card.setAttribute("aria-busy", String(card.dataset.authorState === "loading" || card.dataset.excerptState === "loading"));
    });
    document.querySelectorAll('[data-betterld-grid="true"]').forEach(syncFilterEmptyState);
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

  function itemSignature(item) {
    const topic = topicInfo(item);
    // 站点重渲染过程中会出现没有主题链接的行（也没有任何主题信息）；不能让它把整份签名算崩，
    // 否则 syncHomepage 每次抛错，列表再也不重建（表现为刷新后看不到新帖，直到重载页面）
    if (!topic) {
      return "";
    }
    const avatar = item.querySelector(".topic-avatar img, .posters img.avatar, .avatar img, img.avatar");
    return JSON.stringify({
      topic,
      author: authorName(item),
      category: categoryInfo(item),
      meta: compactMetaParts(item).map((part) => `${part.kind}:${part.text}`).join(" · "),
      // 已看标记参与签名：浏览记录是异步读出来的，集合变化后必须重建卡片才会出现标记
      watched: state.visitedTopics.has(topic.id),
      avatar: avatar?.currentSrc || avatar?.src || "",
      className: item.className
    });
  }

  function signature(items) {
    return items.map(itemSignature).join("\n");
  }

  function unobserveGrid(grid) {
    const observers = [state.excerptObserver, state.cardObserver].filter(Boolean);
    if (!observers.length) {
      return;
    }
    grid.querySelectorAll(".betterld-topic-card").forEach((card) => {
      observers.forEach((observer) => observer.unobserve(card));
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
    delete container.dataset.betterldSignature;
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

  function rebuildContainer(container, items) {
    const currentSignature = signature(items);
    const currentGrid = managedGrid(container);
    if (container.dataset.betterldSignature === currentSignature
      && currentGrid?.isConnected
      && currentGrid.dataset.betterldCardStyle === state.currentSettings.topicListLayoutMode) {
      return;
    }

    // 站点把新帖插到列表最前面时，浏览器滚动锚定会把人钉在旧内容上（阅读卡很高，感觉就是被推到最下面），
    // 所以顶部主题发生变化时把视图带回页首；列表尾部追加（滚动加载更多）不会改变顶部，不受影响
    const previousTopId = currentGrid?.querySelector(".betterld-topic-card")?.dataset.topicId || "";
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
    grid.dataset.betterldCardStyle = state.currentSettings.topicListLayoutMode;
    grid.setAttribute("aria-label", "LinuxDo 主题");

    for (const item of items) {
      if (!itemPassesDomFilter(item)) {
        continue;
      }
      const card = createCard(item);
      if (!card) {
        continue;
      }
      grid.append(card);
      observeCard(card);
    }

    if (!grid.childElementCount && state.currentSettings.topicFilterEnabled && items.length) {
      grid.dataset.betterldFilterEmpty = "true";
      syncFilterEmptyState(grid);
    }
    if (!grid.childElementCount) {
      return;
    }

    container.dataset.betterldSource = "true";
    container.dataset.betterldWasHidden = String(originallyHidden);
    container.dataset.betterldSignature = currentSignature;
    container.hidden = sourceBody ? originallyHidden : true;
    if (sourceBody) {
      sourceBody.dataset.betterldSourceBody = "true";
      sourceBody.dataset.betterldWasHidden = String(sourceBodyWasHidden);
      sourceBody.hidden = true;
    }
    container.after(grid);
    state.managedSources.set(container, grid);
    const refreshPending = state.listRefreshAt && Date.now() - state.listRefreshAt <= config.listRefreshScrollTopWindowMs;
    if (refreshPending) {
      state.listRefreshAt = 0;
    }
    const nextTopId = grid.querySelector(".betterld-topic-card")?.dataset.topicId || "";
    if (refreshPending || (previousTopId && nextTopId && previousTopId !== nextTopId)) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function syncHomepage() {
    if (!isTopicListPage() || !["cards", "reading"].includes(state.currentSettings.topicListLayoutMode)) {
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
        rebuildContainer(container, items);
      }
    } finally {
      state.mutating = false;
    }
    applyListControlsScrollState();
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
    if (topicListPage) {
      scheduleSync();
    } else {
      restoreAll();
    }
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
          loadExcerpt(entry.target);
          state.excerptObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: config.excerptRootMargin })
    : null;

  state.cardObserver = "IntersectionObserver" in globalThis
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          state.cardObserver.unobserve(entry.target);
          loadCardMetadata(entry.target);
        }
      });
    }, { rootMargin: config.excerptRootMargin })
    : null;

  applyVisualSettings(config.settingsDefaults, { provisional: true });
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
      const activeSettings = await getActiveSettings(stored[config.storageKey]);
      applyVisualSettings(activeSettings);
      scheduleSync();
    })
    .catch((error) => {
      state.activeStorageArea = "local";
      state.localWallpaper = null;
      console.error("[betterLD] settings load failed; using defaults", error);
      applyVisualSettings(config.settingsDefaults, { forceFallback: true });
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

  const domObserver = new MutationObserver(() => {
    if (!state.mutating) {
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

  window.addEventListener("scroll", updateListControlsScrollState, { passive: true });
  window.addEventListener("scroll", closeSearchHistoryPanel, { passive: true });
  window.addEventListener("resize", closeSearchHistoryPanel);
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  state.currentHref = location.href;
  updateRouteState();
  window.setInterval(checkRoute, config.routePollMs);
})();
