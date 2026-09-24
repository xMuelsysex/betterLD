(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);
  const normalizeSettings = settingsApi?.normalizeSettings;
  const markdownApi = globalThis.BETTERLD_MARKDOWN;

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
    activeStorageArea: "local",
    syncTimer: 0,
    mutating: false,
    wallpaperRequest: 0,
    wallpaperState: "default",
    localWallpaper: null,
    remoteWallpaperCache: null,
    excerptCache: new Map(),
    metadataQueue: [],
    metadataRunning: false,
    excerptStorageChain: Promise.resolve(),
    metadataNextAt: 0,
    metadataCooldownUntil: 0,
    topicListMetadata: new Map(),
    topicListUnavailable: new Set(),
    topicListNextPage: new Map(),
    preloadedTopicListSeeded: false,
    topicListSync: null,
    topicListSyncAgain: false,
    excerptObserver: null,
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
    toastTimer: 0
  };

  function storageGet(keys = [config.storageKey, config.wallpaperLocalStorageKey, config.wallpaperRemoteCacheKey]) {
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

  function isUnmanagedShellPage() {
    const path = currentPath();
    return Boolean(state.currentSettings.applyToUnmanagedPages)
      && !isTopicListPage()
      && !isCategoriesPage()
      && !isTagsPage()
      && !isSearchPage()
      && !/^\/(?:admin|session|u|messages|t(?:\/|$)|new(?:\/|$))/.test(path);
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
    root.dataset.betterldShowTopicMeta = String(settings.showTopicMeta);
    root.dataset.betterldShowTopicUnreadState = String(settings.showTopicUnreadState);
    root.dataset.betterldShowTopicPinnedState = String(settings.showTopicPinnedState);
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
    document.body?.classList.toggle("betterld-unmanaged-page", isUnmanagedShellPage());

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

  function isTagsPage() {
    return currentPath() === "/tags";
  }

  const listControlsSelector = "body:is(.betterld-topic-page, .betterld-categories-page) #main-outlet-wrapper #main-outlet > .list-controls.list-controls";

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
    if (scrollTop <= 16) {
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
    root.dataset.betterldNavigationSticky = String(settings.topicNavigationSticky);
    root.dataset.betterldNavigationScroll = String(settings.enableHorizontalNavigationScroll);
    root.dataset.betterldTouchMode = String(touchMode);
    syncChromeScrollState();
    syncTouchHomeButton();
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
    state.currentSettings = normalizeSettings({ ...state.currentSettings, searchHistory: history });
    storageSet({ [config.storageKey]: state.currentSettings }).catch((error) => {
      console.error("[betterLD] search history save failed", error);
    });
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
    if (!searchPage) {
      delete root.dataset.betterldSearchFocused;
      return;
    }
    const inputs = [...document.querySelectorAll('form[action*="/search"] input[name="q"], input.search-query, input[name="q"]')]
      .filter((input) => input instanceof HTMLInputElement);
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

  function createActionButton(key) {
    const labels = { settings: "设置", theme: "主题", top: "返回顶部", refresh: "刷新" };
    const icons = { settings: "⚙", theme: "☼", top: "↑", refresh: "↻" };
    const button = createElement("button", "betterld-action-rail__button");
    button.type = "button";
    button.dataset.betterldAction = key;
    button.setAttribute("aria-label", labels[key] || key);
    button.title = labels[key] || key;
    button.append(createElement("span", "betterld-action-rail__icon", icons[key] || "•"));
    button.addEventListener("click", () => {
      if (key === "settings") {
        openSettingsPage();
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
      }
    });
    return button;
  }

  function syncFloatingActions() {
    if (!document.body) {
      return;
    }
    const settings = state.currentSettings;
    const needsRail = settings.actionRailEnabled || settings.showBackToTopButton || settings.showRefreshButton;
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
    configured.forEach((entry) => {
      if (!entry.visible || (entry.key === "settings" && !settings.showSettingsTrigger) || (entry.key === "theme" && !settings.showThemeToggle) || (entry.key === "top" && !settings.showBackToTopButton) || (entry.key === "refresh" && !settings.showRefreshButton)) {
        return;
      }
      const button = createActionButton(entry.key);
      button.style.order = String(entry.order);
      rail.append(button);
    });
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

  function compactMeta(item) {
    const selectors = [
      ".topic-list-data.num.posts",
      ".topic-list-data.posts",
      ".topic-list-data.activity",
      ".num.posts",
      ".posts",
      ".activity",
      ".last-posted-at",
      ".relative-date"
    ];
    const values = [];

    for (const selector of selectors) {
      const value = cleanText(item.querySelector(selector)?.textContent);
      if (value && !values.includes(value)) {
        values.push(value);
      }
      if (values.length === 2) {
        break;
      }
    }

    return values.join(" · ") || " ";
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
    const meta = createElement("span", "betterld-topic-card__meta", compactMeta(item));

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

  async function openTopicBackground(url) {
    const safeUrl = safeTopicUrl(url);
    if (!safeUrl) {
      throw new Error("后台打开目标不是有效的 LinuxDo 主题链接");
    }
    const response = await sendRuntimeMessage({ type: "open-topic", url: safeUrl, active: false });
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
        await openTopicBackground(topicUrl);
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
      openTopicBackground(topicUrl)
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
          if (metadata.stats) setReadingStats(card, metadata.stats);
          if (metadata.participants) setReadingParticipants(card, metadata.participants);
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

  // 等上一请求完成再放行，确保挑战/限流响应先更新冷却时间，并给原站分页留出请求余量。
  function scheduleMetadataRequest(task, isNeeded, isPriority) {
    return new Promise((resolve, reject) => {
      state.metadataQueue.push({ task, isNeeded, isPriority, resolve, reject });
      drainMetadataQueue();
    });
  }

  async function drainMetadataQueue() {
    if (state.metadataRunning) {
      return;
    }
    state.metadataRunning = true;
    try {
      while (state.metadataQueue.length) {
        let wait;
        while ((wait = Math.max(state.metadataNextAt, state.metadataCooldownUntil) - Date.now()) > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, wait));
        }
        // 到真正发请求时再按当前关注位置排序，悬停不会绕过限速或冷却。
        const priorityIndex = state.metadataQueue.findIndex((entry) => entry.isPriority());
        const [entry] = state.metadataQueue.splice(priorityIndex < 0 ? 0 : priorityIndex, 1);
        if (!entry.isNeeded()) {
          entry.reject(new DOMException("Topic request is no longer needed", "AbortError"));
          continue;
        }
        state.metadataNextAt = Date.now() + config.topicRequestMinIntervalMs;
        try {
          entry.resolve(await entry.task());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      state.metadataRunning = false;
    }
  }

  // 站点前面的 Cloudflare 会对不像站点自身 ajax 的 JSON 请求直接返回挑战页，
  // 一旦被打上挑战状态，站点自己的分页请求也会一起被挡、底部加载 spinner 永不结束。
  // 所以这里带上 Discourse ajax 同款的 X-Requested-With，并在被挑战时长时间停发。
  function requestTopicResponse(url, isNeeded = () => true, isPriority = () => false) {
    return scheduleMetadataRequest(async () => {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      if (response.headers.get("cf-mitigated") === "challenge") {
        state.metadataCooldownUntil = Date.now() + config.topicChallengeCooldownMs;
        throw new Error("topic request blocked by the site challenge; cooling down");
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        state.metadataCooldownUntil = Date.now()
          + (retryAfter > 0 ? retryAfter * 1000 : config.topicRequestCooldownMs);
        throw new Error("topic request rate limited; cooling down");
      }
      if (!response.ok) {
        throw new Error(`topic request failed with ${response.status}`);
      }
      return response.json();
    }, isNeeded, isPriority);
  }

  async function fetchTopicMetadata(topicId) {
    const endpoint = new URL(`/t/${topicId}.json`, location.origin);
    endpoint.searchParams.set("include_raw", "1");
    const data = await requestTopicResponse(endpoint.href, () => managedCards().some((card) => {
      if (card.dataset.topicId !== topicId) {
        return false;
      }
      const rect = card.getBoundingClientRect();
      return card.dataset.authorState === "loading"
        || (state.topicDrawer?.dialog.open && state.drawerTrigger?.closest(".betterld-topic-card") === card)
        || (!card.hidden && rect.bottom > 0 && rect.top < window.innerHeight);
    }), () => managedCards().some((card) => card.dataset.topicId === topicId
      && (card.matches(":hover, :focus-within")
        || (state.topicDrawer?.dialog.open && state.drawerTrigger?.closest(".betterld-topic-card") === card))));
    const post = data?.post_stream?.posts?.find((entry) => entry.post_number === 1);
    if (!post) {
      throw new Error("topic opening post unavailable");
    }
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

  function requestTopicMetadata(topicId) {
    const cached = state.excerptCache.get(topicId);
    if (cached?.state === "ready") {
      return Promise.resolve(cached);
    }
    if (cached?.state === "failed") {
      return Promise.reject(cached.error);
    }
    if (cached?.state === "pending") {
      return cached.promise;
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
      if (stored && Date.now() - stored.savedAt < config.excerptCacheTtlMs
        && typeof stored.markdown === "string" && typeof stored.text === "string"
        && ["ready", "empty"].includes(stored.contentState)) {
        return stored;
      }
    } catch (error) {
      console.error("[betterLD] excerpt cache read failed", error);
    }
    const metadata = await requestTopicMetadata(topicId);
    // 只持久化正文，缓存命中不能替代作者、活动时间或互动元数据。
    const { text, markdown, contentState } = metadata;
    state.excerptStorageChain = state.excerptStorageChain.then(async () => {
      await storageSet({ [key]: { text, markdown, contentState, savedAt: Date.now() } });
      const stored = await storageGet(null);
      const entries = Object.entries(stored)
        .filter(([name]) => name.startsWith(config.excerptStoragePrefix))
        .sort((a, b) => b[1].savedAt - a[1].savedAt);
      const expired = entries.filter(([, value], index) => index >= config.excerptCacheMaxEntries
        || Date.now() - value.savedAt >= config.excerptCacheTtlMs).map(([name]) => name);
      if (expired.length) {
        await storageRemove(expired);
      }
    }).catch((error) => console.error("[betterLD] excerpt cache write failed", error));
    return metadata;
  }

  // 逐主题请求 /t/{id}.json 一屏就是几十个请求，会触发站点防护并连带把站点自己的分页请求挡成 429，
  // 所以作者与活动时间统一取列表接口（或首屏服务端预载）里的同一份主题数据，
  // /t/{id}.json 只留给视口内卡片的正文预览。
  function topicListRouteKey() {
    return `${currentPath()}${location.search}`;
  }

  function topicListMetadataPath() {
    const username = userTopicsUsername();
    if (username) {
      return `/topics/created-by/${username}`;
    }
    if (!isHomepage()) {
      return currentPath();
    }
    const active = document.querySelector("#navigation-bar a.active[href]");
    if (!active) {
      return "";
    }
    try {
      return new URL(active.href, location.href).pathname.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  // Discourse 的列表主题把创建者排在 posters[0]（TopicPostersSummary 只把最新发帖人挪到末尾），
  // users 数组给出该 user_id 的 username，与 /t/{id}.json 的 details.created_by.username 同源。
  function topicListEntries(payload) {
    const usernames = new Map(
      (Array.isArray(payload?.users) ? payload.users : []).map((user) => [user.id, cleanText(user.username)])
    );
    return (Array.isArray(payload?.topic_list?.topics) ? payload.topic_list.topics : []).map((topic) => ({
      id: String(topic.id),
      author: usernames.get(topic.posters?.[0]?.user_id) || "",
      activityAt: cleanText(topic.last_posted_at || topic.bumped_at || topic.created_at)
    }));
  }

  async function requestTopicListPage(page, routeKey, path, search) {
    if (!path) {
      return [];
    }
    const url = new URL(`${path}.json`, location.origin);
    url.search = search;
    url.searchParams.set("page", String(page));
    return topicListEntries(await requestTopicResponse(url.href, () => topicListRouteKey() === routeKey));
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
    // 服务端渲染进页面的就是该路由列表的第 1 页
    state.topicListNextPage.set(topicListRouteKey(), { firstId: entries[0].id, page: 0 });
  }

  function managedCards() {
    return [...document.querySelectorAll('[data-betterld-grid="true"] > .betterld-topic-card')];
  }

  function applyTopicListMetadata(card) {
    const metadata = state.topicListMetadata.get(card.dataset.topicId);
    if (!metadata?.author) {
      return false;
    }
    setAuthor(card, metadata.author, "ready");
    setTopicActivity(card, metadata.activityAt);
    return true;
  }

  function applyTopicListMetadataToAll() {
    managedCards().forEach(applyTopicListMetadata);
  }

  function uncoveredTopicCards() {
    return managedCards().filter((card) => card.dataset.topicId && card.dataset.authorState === "loading");
  }

  function syncTopicListMetadata() {
    if (state.topicListSync) {
      state.topicListSyncAgain = true;
      return;
    }
    state.topicListSync = Promise.resolve()
      .then(async () => {
        if (!isTopicListPage() || !["cards", "reading"].includes(state.currentSettings.topicListLayoutMode)) {
          return;
        }
        // 预载元素在文档末尾，注入过早时第一次读不到，这里补一次
        seedPreloadedTopicList();
        applyTopicListMetadataToAll();
        const routeKey = topicListRouteKey();
        const path = topicListMetadataPath();
        const search = location.search;
        if (!state.topicListUnavailable.has(routeKey)) {
          // 列表首题未变说明还是同一次分页，接着上次的页码往下翻；首题变了（客户端路由回来）就从第 1 页重查
          const firstId = managedCards()[0]?.dataset.topicId || "";
          const tracked = state.topicListNextPage.get(routeKey);
          let page = tracked && tracked.firstId === firstId ? tracked.page + 1 : 0;
          while (topicListRouteKey() === routeKey && uncoveredTopicCards().length) {
            let entries;
            try {
              entries = await requestTopicListPage(page, routeKey, path, search);
            } catch (error) {
              if (error.name === "AbortError") {
                return;
              }
              state.topicListUnavailable.add(routeKey);
              console.warn("[betterLD] 主题列表元数据请求失败", error);
              break;
            }
            if (topicListRouteKey() !== routeKey) {
              return;
            }
            const cardIds = new Set(managedCards().map((card) => card.dataset.topicId));
            const matched = entries.filter((entry) => cardIds.has(entry.id));
            if (!matched.length) {
              state.topicListUnavailable.add(routeKey);
              break;
            }
            matched.forEach((entry) => state.topicListMetadata.set(entry.id, entry));
            state.topicListNextPage.set(routeKey, { firstId, page });
            applyTopicListMetadataToAll();
            page += 1;
          }
        }
        // 列表接口覆盖不到的主题（非标准列表路由、创建者缺失等）退回逐主题请求
        if (topicListRouteKey() === routeKey) {
          uncoveredTopicCards().forEach(loadAuthor);
        }
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
    const icons = { comment: "▢", heart: "♡", views: "◉" };
    container.replaceChildren(...(Array.isArray(stats) ? stats : []).map((stat) => {
      const item = createElement("span", "betterld-topic-card__reading-stat");
      const icon = createElement("span", "betterld-topic-card__reading-stat-icon", icons[stat.icon] || "•");
      const value = createElement("span", "betterld-topic-card__reading-stat-value", String(stat.value));
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
        if (error.name === "AbortError") {
          return;
        }
        console.warn(`[betterLD] topic creator unavailable for topic ${topicId}`, error);
        setAuthor(card, config.authorPlaceholder, "failed");
        scheduleTopicMetadataRecovery(card);
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
        if (metadata.stats) setReadingStats(card, metadata.stats);
        if (metadata.participants) setReadingParticipants(card, metadata.participants);
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          if (card.isConnected) {
            observeExcerpt(card);
          }
          return;
        }
        console.warn(`[betterLD] topic excerpt unavailable for topic ${topicId}`, error);
        setExcerpt(card, config.excerptPlaceholder, "failed");
        scheduleTopicMetadataRecovery(card);
      });
  }

  // 快速滚动时卡片只是一闪而过，给它们请求正文预览既拖慢真正在看的那几张，
  // 又会把一屏几十个请求打给站点（站点防护会连带把站点自己的分页请求挡成 429），
  // 所以等卡片在视口里停住一小会儿再请求。
  function scheduleExcerpt(card) {
    if (card.dataset.betterldExcerptTimer || card.dataset.excerptState !== "loading") {
      return;
    }
    card.dataset.betterldExcerptTimer = String(window.setTimeout(() => {
      delete card.dataset.betterldExcerptTimer;
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

  function observeCard(card) {
    applyCardFilter(card);
    if (!card.dataset.topicId) {
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

  function syncManagedCardContent() {
    document.querySelectorAll('[data-betterld-grid="true"] .betterld-topic-card').forEach((card) => {
      applyCardFilter(card);
      applyTopicListMetadata(card);
      observeExcerpt(card);
      card.setAttribute("aria-busy", String(card.dataset.authorState === "loading" || card.dataset.excerptState === "loading"));
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

  function handleNavigationClick(event) {
    if ((event.button !== undefined && event.button !== 0) || state.currentSettings.navigationOpenMode === "currentTab" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const opened = globalThis.open(event.currentTarget.href, "_blank", "noopener,noreferrer");
    if (!opened) {
      showActionStatus("导航链接打开被浏览器阻止");
    }
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
    const link = event.currentTarget;
    const mode = link.dataset.betterldLinkOpenMode;
    if (mode !== "newTab" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = safeSiteUrl(link.href);
    if (!target) {
      return;
    }
    event.preventDefault();
    const opened = globalThis.open(target, "_blank", "noopener,noreferrer");
    if (!opened) {
      showActionStatus("新标签页打开被浏览器阻止");
    }
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

  function refreshTopicsList() {
    state.topicListUnavailable.delete(topicListRouteKey());
    state.topicListNextPage.delete(topicListRouteKey());
    let retrying = false;
    managedCards().forEach((card) => {
      const authorFailed = card.dataset.authorState === "failed";
      const excerptFailed = card.dataset.excerptState === "failed";
      if (!authorFailed && !excerptFailed) {
        return;
      }
      retrying = true;
      state.excerptCache.delete(card.dataset.topicId);
      card.dataset.topicRecoveryCount = "0";
      if (authorFailed) {
        setAuthor(card, config.authorLoadingLabel, "loading");
      }
      if (excerptFailed) {
        setExcerpt(card, config.excerptLoadingLabel, "loading");
        observeExcerpt(card);
      }
    });
    syncTopicListMetadata();
    const notice = document.querySelector(".show-more.has-topics > a.alert.clickable");
    if (!notice) {
      showActionStatus(retrying ? "正在重新读取预览与作者信息" : "已是最新主题", "success");
      return;
    }
    if (notice.classList.contains("loading")) {
      return;
    }
    notice.click();
  }

  function cardSyncKey(item) {
    const topic = topicInfo(item);
    if (!topic) {
      return "";
    }
    return topic.id ? `topic:${topic.id}` : `href:${topic.href}`;
  }

  function syncCards(grid, items) {
    const known = new Map([...grid.children].map((child) => [child.dataset.betterldCardKey, child]));
    let anchor = null;
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
      const reference = anchor ? anchor.nextElementSibling : grid.firstElementChild;
      if (card !== reference) {
        grid.insertBefore(card, reference);
      }
      anchor = card;
    }
  }

  function syncContainer(container, items) {
    const grid = managedGrid(container);
    if (grid?.isConnected && grid.dataset.betterldCardStyle === state.currentSettings.topicListLayoutMode) {
      syncCards(grid, items);
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
    grid.dataset.betterldCardStyle = state.currentSettings.topicListLayoutMode;
    grid.setAttribute("aria-label", "LinuxDo 主题");

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
        syncContainer(container, items);
      }
    } finally {
      state.mutating = false;
    }
    applyListControlsScrollState();
    syncTopicListMetadata();
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
    document.body?.classList.toggle("betterld-unmanaged-page", isUnmanagedShellPage());
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

  function checkRoute() {
    checkDailyWallpaper();
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
          scheduleExcerpt(entry.target);
        } else {
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
      const activeSettings = await getActiveSettings(stored[config.storageKey]);
      applyVisualSettings(activeSettings);
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

  window.addEventListener("scroll", updateListControlsScrollState, { passive: true });
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  state.currentHref = location.href;
  updateRouteState();
  window.setInterval(checkRoute, config.routePollMs);
})();
