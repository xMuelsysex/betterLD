(() => {
  "use strict";

  // 仅插件主动打开的同站主题预览复用完整样式与回复树，帖子里的嵌入不接管。
  if (window !== window.top && !window.frameElement?.matches("iframe[data-betterld-topic-preview]")) {
    return;
  }

  const config = globalThis.BETTERLD_CONFIG;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const appearance = globalThis.BETTERLD_APPEARANCE;
  const startup = globalThis.BETTERLD_STARTUP;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);
  const normalizeSettings = settingsApi?.normalizeSettings;
  const userMarksApi = globalThis.BETTERLD_USER_MARKS;
  const mediaApi = globalThis.BETTERLD_MEDIA;

  // 站点自己的前端请求带这两个指纹头；只带 Accept 时 Cloudflare 会对 *.json 返回 403 质询
  const discourseAjaxHeaders = Object.freeze({
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Discourse-Present": "true"
  });

  if (!config || !settingsApi || !appearance || !startup || typeof normalizeSettings !== "function" || !userMarksApi?.normalize || typeof mediaApi?.sync !== "function" || !api?.storage?.local) {
    console.error("[betterLD] content script could not initialize: extension API is unavailable");
    return;
  }

  if (globalThis.__betterldContentScriptActive) {
    return;
  }
  globalThis.__betterldContentScriptActive = true;
  if (window !== window.top) document.documentElement.dataset.betterldTopicPreview = "true";

  const state = {
    currentHref: "",
    currentSettings: config.settingsDefaults,
    settingsResolved: false,
    activeStorageArea: "local",
    syncTimer: 0,
    syncLists: false,
    routeTimer: 0,
    dataTimer: 0,
    positionTimer: 0,
    pageSuspended: false,
    metadataRoute: `${location.pathname}${location.search}`,
    metadataGeneration: 0,
    wallpaperRequest: 0,
    wallpaperState: "default",
    wallpaperColorUrl: "",
    wallpaperColor: null,
    localWallpaper: null,
    remoteWallpaperCache: null,
    topicSortRedirect: "",
    metadataQueue: [],
    metadataRunning: false,
    metadataStarts: [],
    metadataWakeTimer: 0,
    metadataWakeAt: 0,
    responseRequests: new Map(),
    preloadedReplyFilterKey: topicFilterStateKey(topicStreamFiltersFromUrl()),
    pageRefreshBridge: null,
    refreshPromise: null,
    refreshNextAt: 0,
    metadataNextAt: 0,
    replyParentNextAt: 0,
    metadataCooldownUntil: 0,
    metadataRateLimitFailures: 0,
    topicListMetadata: new Map(),
    preloadedTopicListSeeded: false,
    topicTimeFormatter: null,
    topicTimeFormatterKey: "",
    topicLinks: new WeakSet(),
    topicListSync: null,
    topicListSyncAgain: false,

    searchLoadMoreBusy: false,
    externalSearchBusy: false,
    externalSearchKey: "",
    externalSearchPanel: null,
    refreshScrollTopSince: 0,
    listControlsCollapsed: false,
    lastScrollY: 0,
    scrollDirection: 0,
    scrollDistance: 0,
    openMenu: null,
    drawerTrigger: null,

    topicDrawer: null,
    settingsDialog: null,
    settingsDialogTrigger: null,
    filterBin: new Set(),
    filterBinFrame: 0,
    filterBinHost: null,
    filterBinOpen: false,
    filterSignature: "",
    searchHistoryPanel: null,
    listRefreshAt: 0,
    toastTimer: 0,
    replyTree: null,
    replyTreeNativeTopicId: "",
    replyTreeSnapshot: null,
    userMarks: { version: 1, marks: {} },
    userMarksError: "",
    mediaAutoplay: false,
    mediaAvatars: false,
    mediaSynced: false,
    searchAuthorIds: new Map(),
    searchAuthorsHref: "",
    userCardObserver: null,
    userCardMounting: false,
    userCardRequestSeq: 0,
    userCardMountedKey: ""
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

  async function getActiveSettings(localSettings = state.currentSettings) {
    const active = await startup.readActiveSettings(localSettings);
    state.activeStorageArea = active.area;
    return active.settings;
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
    const previousUserMarksEnabled = state.currentSettings.userMarksEnabled;
    state.currentSettings = settings;
    syncMediaSettings(settings);
    if (state.replyTree?.posts.size && previousReplyTreeNameMode !== settings.replyTreeNameMode) {
      renderReplyTree(state.replyTree);
    }
    if (previousUserMarksEnabled !== settings.userMarksEnabled) {
      refreshUserMarks();
    }
    const wallpaperUrl = resolveWallpaper(settings);
    if (wallpaperUrl !== state.wallpaperColorUrl) {
      state.wallpaperColorUrl = wallpaperUrl;
      state.wallpaperColor = null;
    }
    appearance.apply(settings, state.wallpaperColor);
    root.style.removeProperty("--betterld-wallpaper-image");
    if (!Number(settings.wallpaperRemoteCacheDays) && state.remoteWallpaperCache) {
      state.remoteWallpaperCache = null;
      storageRemove(config.wallpaperRemoteCacheKey).catch((error) => {
        console.error("[betterLD] remote wallpaper cache removal failed", error);
      });
    }
    applyCustomCss(settings);
    resetFilterOverrides(settings);
    syncHomepage();
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

  function applyThemeTokens(settings) {
    appearance.applyThemeTokens(settings, state.wallpaperColor);
  }

  function applyColorMode() {
    appearance.applyColorMode(state.currentSettings, state.wallpaperColor);
  }

  function currentPath() {
    return location.pathname.replace(/\/+$/, "") || "/";
  }

  function isHomepage() {
    return currentPath() === config.homepagePath;
  }

  function topicListEnhancementEnabled() {
    const userAppearance = appearance.userPageAppearance(state.currentSettings);
    if (userAppearance) return isUserSpaceTopicListPage() && userAppearance === "material";
    return state.currentSettings.topicListAppearance === "material";
  }

  function isUserSpaceTopicListPage() {
    return /^\/u\/[^/]+\/activity\/(?:topics|read|votes)$/.test(currentPath());
  }

  function isTopicListPage() {
    const path = currentPath();
    return isHomepage()
      || isUserSpaceTopicListPage()
      || /^\/(?:latest|new|unread|unseen|hot|top|read|posted|bookmarks)(?:\/|$)/.test(path)
      || /^\/my\/[^/]+(?:\/|$)/.test(path)
      || /^\/l\/(?:latest|new|unread|unseen|hot|top|read)(?:\/|$)/.test(path)
      || /^\/c\/(?:[^/]+\/)+\d+(?:\/l\/(?:latest|new|unread|unseen|hot|top|read))?$/.test(path)
      || /^\/tag\/[^/]+(?:\/\d+)?(?:\/l\/(?:latest|new|unread|unseen|hot|top|read))?$/.test(path);
  }

  function isCategoriesPage() {
    return currentPath() === "/categories";
  }

  // 热门、最高及用户投票列表保留各自的排序语义。
  function hasOwnTopicRanking() {
    const path = currentPath();
    return /^\/(?:hot|top)(?:\/|$)/.test(path) || /^\/l\/(?:hot|top)(?:\/|$)/.test(path)
      || /^\/u\/[^/]+\/activity\/votes$/.test(path);
  }

  function isSortableTopicListPage() {
    return isTopicListPage() && !hasOwnTopicRanking();
  }

  function topicIdFromPath(pathname = location.pathname) {
    const match = pathname.match(/^\/t\/(?:(\d+)|[^/]+\/(\d+))(?:\/|$)/);
    return match?.[1] || match?.[2] || "";
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
    if (button.disabled !== exhausted) button.disabled = exhausted;
    const text = exhausted ? "没有更多结果" : "加载更多结果";
    if (button.textContent !== text) button.textContent = text;
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
      const before = entries?.querySelectorAll(".fps-result").length || 0;
      button.disabled = true;
      state.searchLoadMoreBusy = true;
      showSearchSentinel(sentinel);
      sentinel.scrollIntoView({ block: "end", behavior: "auto" });
      // 站点的加载器挂在 scroll 上，补发一次让它在已经在底部时也能触发
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
      const observer = new MutationObserver(() => {
        if ((entries?.querySelectorAll(".fps-result").length || 0) > before) {
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

  async function readNativeSearchState() {
    await loadPageRefreshBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener("betterld:search-state", onResult);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      };
      const timer = setTimeout(() => {
        document.removeEventListener("betterld:search-state", onResult);
        reject(new Error("原站搜索状态读取超时"));
      }, config.externalSearch.nativeStateTimeoutMs);
      document.addEventListener("betterld:search-state", onResult);
      document.dispatchEvent(new CustomEvent("betterld:search-state-request", { detail: JSON.stringify({ id }) }));
    });
  }

  function clearExternalSearch() {
    state.externalSearchPanel?.remove();
    state.externalSearchPanel = null;
    state.externalSearchKey = "";
  }

  function createExternalSearchPanel(engine, message) {
    const results = document.querySelector(".search-container > .search-advanced");
    if (!results) return null;
    state.externalSearchPanel?.remove();
    const panel = createElement("section", "betterld-external-search");
    const heading = createElement("h2", "", `${config.externalSearch.engines[engine].label} · LinuxDo 补充结果`);
    const status = createElement("p", "betterld-external-search__status", message);
    status.setAttribute("role", "status");
    const retry = createElement("button", "betterld-search-more", "重试补充搜索");
    retry.type = "button";
    retry.hidden = true;
    retry.addEventListener("click", () => { state.externalSearchKey = ""; syncExternalSearch(); });
    panel.append(heading, status, retry);
    // 空搜索仍可能展示长列 AI 推荐，补充结果放在其前方而非整个搜索页末尾。
    results.before(panel);
    state.externalSearchPanel = panel;
    return { panel, status, retry };
  }

  function createExternalSearchResult(result, engine) {
    const card = createElement("article", "betterld-external-search__card");
    card.setAttribute("role", "listitem");
    const main = createElement("div", "fps-topic");
    const topic = createElement("div", "topic");
    topic.setAttribute("role", "heading");
    topic.setAttribute("aria-level", "3");
    const title = createElement("a", "search-link betterld-topic-card__title", result.title);
    title.href = result.href;
    const excerpt = createElement("div", "blurb", result.excerpt);
    const source = createElement("div", "betterld-topic-row__info", `外部索引 · ${config.externalSearch.engines[engine].label} · ${new URL(result.href).hostname}`);
    topic.append(title);
    main.append(topic, excerpt, source);
    card.append(main);
    return card;
  }

  function nativeRelatedResultsDisabled() {
    return document.querySelector('.semantic-search__results-toggle[role="switch"]')?.getAttribute("aria-checked") === "false";
  }

  async function syncExternalSearch() {
    const engine = state.currentSettings.externalSearchEngine;
    if (!isSearchPage() || engine === "off" || !nativeRelatedResultsDisabled()) { clearExternalSearch(); return; }
    const href = location.href;
    const failedStateKey = `${engine}:state:${href}`;
    if (state.externalSearchBusy || (state.externalSearchKey === failedStateKey && state.externalSearchPanel?.isConnected)) return;
    state.externalSearchBusy = true;
    try {
      const native = await readNativeSearchState();
      if (location.href !== href || engine !== state.currentSettings.externalSearchEngine) { clearExternalSearch(); return; }
      if (!native.ready || !native.empty || !nativeRelatedResultsDisabled()) { clearExternalSearch(); return; }
      const key = `${engine}:${native.query}`;
      if (key === state.externalSearchKey && state.externalSearchPanel?.isConnected) return;
      const view = createExternalSearchPanel(engine, `站内无结果，正在搜索 ${native.query} site:linux.do…`);
      if (!view) return;
      const { panel, status, retry } = view;
      state.externalSearchKey = key;
      try {
        const response = await sendRuntimeMessage({ type: "external-search", engine, query: native.query });
        if (!response?.ok) throw new Error(response?.error || "外部搜索没有返回结果");
        const current = await readNativeSearchState();
        if (location.href !== href || engine !== state.currentSettings.externalSearchEngine || !nativeRelatedResultsDisabled() || !current.ready || !current.empty || current.query !== native.query) {
          clearExternalSearch();
          return;
        }
        const parsed = globalThis.BETTERLD_EXTERNAL_SEARCH.parseResults(engine, response.html);
        const grid = createElement("div", "betterld-external-search__results");
        grid.setAttribute("role", "list");
        for (const result of parsed.results) {
          grid.append(createExternalSearchResult(result, engine));
        }
        panel.insertBefore(grid, retry);
        status.textContent = parsed.results.length
          ? `补充 ${parsed.results.length} 个 LinuxDo 主题，过滤 ${parsed.filteredCount} 条站外、非主题、重复或无效链接。外部索引可能过期，点击标题打开原帖。`
          : `${config.externalSearch.engines[engine].label} 未返回可展示的 LinuxDo 主题，已过滤 ${parsed.filteredCount} 条站外、非主题、重复或无效链接。可查看搜索引擎原始结果核对。`;
        const original = createElement("a", "", "查看搜索引擎原始结果");
        original.href = response.searchUrl;
        original.target = "_blank";
        original.rel = "noopener noreferrer";
        panel.append(original);
      } catch (error) {
        if (location.href !== href || engine !== state.currentSettings.externalSearchEngine || !nativeRelatedResultsDisabled()) { clearExternalSearch(); return; }
        status.textContent = `补充搜索失败：${error.message}`;
        retry.hidden = false;
        console.error("[betterLD] external search failed", error);
      }
    } catch (error) {
      if (location.href !== href || engine !== state.currentSettings.externalSearchEngine || !nativeRelatedResultsDisabled()) { clearExternalSearch(); return; }
      const view = createExternalSearchPanel(engine, `补充搜索暂不可用：无法确认站内搜索状态。${error.message}`);
      if (view) { state.externalSearchKey = failedStateKey; view.retry.hidden = false; }
      console.error("[betterLD] native search state read failed", error);
    } finally {
      state.externalSearchBusy = false;
    }
  }

  function applySearchSettings() {
    const root = document.documentElement;
    const settings = state.currentSettings;
    const searchPage = isSearchPage();
    root.dataset.betterldSearchPage = String(searchPage);
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
    element.dataset.betterldOwned = "true";
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

  function createActionIcon(name, className) {
    const paths = {
      settings: "M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1c-.52-.4-1.07-.73-1.68-.98L14.5 2.42A.488.488 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.68.98l-2.49-1c-.23-.08-.48 0-.6.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.05.32-.09.66-.09.98s.03.66.08.98L2.07 14.63c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.07.73 1.68.98l.38 2.65c.04.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.68-.98l2.49 1c.23.08.48 0 .6-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.08-1.65zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z",
      home: "M12 3 2 12h3v8h5v-6h4v6h5v-8h3L12 3z",
      theme: "M6.76 4.84 4.96 3.05 3.55 4.46l1.79 1.79 1.42-1.41zM1 10h3v2H1v-2zm10-9h2v3h-2V1zm8.45 3.46-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zM20 10h3v2h-3v-2zM12 6a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm5.24 3.16 1.79 1.79 1.41-1.41-1.79-1.79-1.41 1.41zM11 18h2v3h-2v-3zm-7.45-.46 1.41 1.41 1.79-1.79-1.41-1.41-1.79 1.79z",
      top: "M4 4h16v2H4V4zm8 4-6 6 1.41 1.41L11 11.83V20h2v-8.17l3.59 3.58L18 14l-6-6z",
      refresh: "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.93 9h-2.02A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
    };
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("class", className);
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", paths[name]);
    icon.append(path);
    return icon;
  }

  function createSettingsTrigger() {
    const trigger = createElement("button", "betterld-settings-trigger");
    trigger.type = "button";
    trigger.dataset.betterldSettingsTrigger = "true";
    trigger.setAttribute("aria-label", "打开 betterLD 设置");
    trigger.title = "打开 betterLD 设置";
    trigger.addEventListener("click", openSettingsPage);
    const icon = createActionIcon("settings", "betterld-settings-trigger__icon");
    trigger.append(icon, createElement("span", "betterld-settings-trigger__label", "设置"));
    return trigger;
  }

  function ensureSettingsTrigger() {
    if (window !== window.top || !document.body || !state.currentSettings.showSettingsTrigger) {
      document.querySelector("[data-betterld-settings-trigger]")?.remove();
      return;
    }
    if (!document.querySelector("[data-betterld-settings-trigger]")) {
      document.body.append(createSettingsTrigger());
    }
  }

  function createTouchHomeButton() {
    const link = createElement("a", "betterld-touch-home");
    link.append(createActionIcon("home", "betterld-touch-home__icon"));
    link.href = config.homepagePath;
    link.setAttribute("aria-label", "返回首页");
    link.title = "返回首页";
    return link;
  }

  function syncTouchHomeButton() {
    const shouldShow = window === window.top && state.currentSettings.showHomeButtonInTouchMode
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
    const labels = {
      settings: "设置",
      theme: "主题",
      top: "返回顶部",
      refresh: "刷新"
    };
    const button = createElement("button", "betterld-action-rail__button");
    button.type = "button";
    button.dataset.betterldAction = key;
    button.setAttribute("aria-label", labels[key] || key);
    button.title = labels[key] || key;
    button.append(createActionIcon(key, "betterld-action-rail__icon"));
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

  // 合并后的「返回顶部或刷新」：两项各自是否可用决定图标与点击行为，未到顶部显示向上箭头，已在顶部显示刷新图标
  function createMergedNavigationButton(showTop, showRefresh) {
    const button = createElement("button", "betterld-action-rail__button");
    button.type = "button";
    button.dataset.betterldAction = "topOrRefresh";
    button.setAttribute("aria-label", "返回顶部或刷新");
    button.title = "返回顶部或刷新";
    if (showTop) {
      button.append(createActionIcon("top", "betterld-action-rail__icon"));
    }
    if (showRefresh) {
      button.append(createActionIcon("refresh", "betterld-action-rail__icon"));
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

  function syncFloatingActions() {
    if (window !== window.top || !document.body) {
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
    const titleContent = link.cloneNode(true);
    titleContent.querySelectorAll(".sr-only").forEach((node) => node.remove());
    const title = cleanText(titleContent.textContent) || "未命名主题";
    return { href: url.href, id: idMatch?.[1] || "", title };
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
    const categoryNames = [...item.querySelectorAll(".badge-category__name")].map((node) => cleanText(node.textContent)).join(" ");
    const suffix = /,\s*Lv([1-4])(?:$|\s)/.exec(categoryNames);
    return suffix ? Number(suffix[1]) : 0;
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
    const link = item.querySelector(".badge-category__wrapper[href], .badge-category__wrapper a[href], .badge-category a[href], .category-name a[href]");
    return safeSiteUrl(link?.href);
  }

  function topicAuthorHref(item) {
    const link = item.querySelector(".topic-creator-data a[href], .topic-poster a[href], .creator a[href], .author a[data-user-card][href]");
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
    const card = menu.closest(".betterld-search-result, .betterld-topic-row");
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
    const card = menu.closest(".betterld-search-result, .betterld-topic-row");
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
    managedCards().forEach((card) => {
      const menu = card.querySelector(".betterld-topic-card__menu");
      if (menu) {
        renderCardMenuActions(menu, card);
      }
    });
  }

  function handleTopicCardClick(event, card, topicUrl) {
    if (!topicListEnhancementEnabled()) return;
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
    const frame = document.createElement("iframe");
    frame.className = "betterld-topic-drawer__frame";
    frame.title = "LinuxDo 树状回复预览";
    frame.dataset.betterldTopicPreview = "true";
    const openLink = createElement("a", "betterld-topic-drawer__open", "在当前页打开完整主题");
    openLink.target = "_self";
    dialog.append(header, frame, openLink);
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

      if (dialog.open) {
        return;
      }

      clearTopicDrawerContent(state.topicDrawer);
      const trigger = state.drawerTrigger;
      state.drawerTrigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
    document.body.append(dialog);
    state.topicDrawer = { dialog, title, frame, openLink, close };
    return state.topicDrawer;
  }

  function clearTopicDrawerContent(drawer) {
    if (!drawer) {
      return;
    }
    drawer.frame.removeAttribute("src");
  }

  function closeTopicDrawer() {
    const drawer = state.topicDrawer;
    if (!drawer) {
      return;
    }

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

  function syncTopicPreviewHeader() {
    if (window === window.top) return;
    const drawer = window.frameElement.closest("[data-betterld-topic-drawer]");
    const topicUrl = safeTopicUrl(location.href);
    if (!drawer || !topicUrl) return;
    drawer.querySelector(".betterld-topic-drawer__open").href = topicUrl;
    const title = document.querySelector(`#topic-title h1[data-topic-id="${topicIdFromPath()}"] .fancy-title`);
    if (title) drawer.querySelector(".betterld-topic-drawer__title").textContent = cleanText(title.textContent);
  }

  function openTopicDrawer(card) {
    const topicUrl = safeTopicUrl(card.dataset.topicHref);
    if (!topicUrl) {
      showActionStatus("原帖链接无效");
      return;
    }
    // 预览内的推荐帖和菜单共用当前 frame，不再创建下一层抽屉。
    if (window !== window.top) {
      location.assign(topicUrl);
      return;
    }
    const drawer = ensureTopicDrawer();
    if (!drawer) {
      showActionStatus("原帖预览不可用");
      return;
    }
    closeCardMenus();
    state.drawerTrigger = card.querySelector(".betterld-topic-card__link, a.title, a.raw-link");
    drawer.title.textContent = card.dataset.filterTitle || "原帖预览";
    drawer.openLink.href = topicUrl;
    drawer.frame.src = topicUrl;
    if (typeof drawer.dialog.showModal === "function") {
      if (!drawer.dialog.open) {
        drawer.dialog.showModal();
      }
    } else {
      drawer.dialog.setAttribute("open", "");
    }
    resizeTopicDrawer();
    window.setTimeout(() => drawer.close.focus(), 0);
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
    // reply_count 只计显式回复；原站列表显示的是总楼数减首帖。
    const replies = posts === null ? numericTopicValue(data?.reply_count) : Math.max(posts - 1, 0);
    return [
      { key: "replies", label: "回复", icon: "comment", value: replies },
      { key: "likes", label: "点赞", icon: "heart", value: numericTopicValue(data?.like_count) },
      { key: "views", label: "浏览", icon: "views", value: numericTopicValue(data?.views) }
    ].filter((stat) => stat.value !== null);
  }

  // 树状回复请求串行并保留站点冷却；首页列表不进入此队列。
  // priority 是可变引用：共享同一 URL 的消费者可以把自己的优先级提升进队列。
  function scheduleMetadataRequest(task, isNeeded, priority = () => config.topicRequestPriority.body, canStart = () => true, readyAt = () => 0) {
    return new Promise((resolve, reject) => {
      state.metadataQueue.push({ task, isNeeded, priority, canStart, readyAt, resolve, reject });
      drainMetadataQueue();
    });
  }

  // 滑动窗口的唯一规则：窗口内启动次数与最早一次启动的截止时间。
  function metadataWindowState(now) {
    const recent = state.metadataStarts.filter((at) => now - at < config.topicRequestWindowMs);
    return {
      recent,
      until: recent.length >= config.topicRequestMaxPerWindow ? recent[0] + config.topicRequestWindowMs : 0
    };
  }

  function trimMetadataWindow(now) {
    const { recent } = metadataWindowState(now);
    state.metadataStarts.length = 0;
    state.metadataStarts.push(...recent);
  }

  // 队列下一次可以发请求的截止时间；只读，供树内状态行显示剩余等待。
  function metadataQueueWaitUntil(now = Date.now()) {
    return Math.max(state.metadataNextAt, state.metadataCooldownUntil, metadataWindowState(now).until);
  }

  // 已取消的条目先于等待出队，不让失效请求拖着队列空转。
  function dropStaleMetadataRequests() {
    for (let i = state.metadataQueue.length - 1; i >= 0; i -= 1) {
      const entry = state.metadataQueue[i];
      if (entry.isNeeded()) continue;
      state.metadataQueue.splice(i, 1);
      entry.reject(new DOMException("Topic request is no longer needed", "AbortError"));
    }
  }

  async function drainMetadataQueue() {
    if (state.metadataRunning) {
      return;
    }
    state.metadataRunning = true;
    try {
      while (state.metadataQueue.length) {
        dropStaleMetadataRequests();
        if (!state.metadataQueue.length) break;
        const now = Date.now();
        const wait = metadataQueueWaitUntil(now) - now;
        trimMetadataWindow(now);
        if (wait > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, wait));
          continue;
        }
        // readyAt/canStart 只是可启动条件：未满足的条目留在队列里等下一次唤醒，
        // 既不取消也不阻塞其他可启动条目，所以后来的跳楼能抢在未启动的父楼/正文前面。
        let index = -1;
        let earliestReadyAt = 0;
        for (let i = 0; i < state.metadataQueue.length; i += 1) {
          const candidate = state.metadataQueue[i];
          const readyAt = candidate.readyAt();
          if (readyAt > now || !candidate.canStart()) {
            if (readyAt > now && (!earliestReadyAt || readyAt < earliestReadyAt)) earliestReadyAt = readyAt;
            continue;
          }
          if (index < 0 || candidate.priority() < state.metadataQueue[index].priority()) index = i;
        }
        if (index < 0) {
          // 只按明确的就绪时间唤醒，不用定时轮询扫队列。
          if (earliestReadyAt) scheduleMetadataWake(earliestReadyAt);
          return;
        }
        const [entry] = state.metadataQueue.splice(index, 1);
        const startedAt = Date.now();
        state.metadataStarts.push(startedAt);
        state.metadataNextAt = startedAt + config.topicRequestMinIntervalMs;
        try {
          // 条目的 task 包含取数与投影：队列在这一条目完全结束前不会启动下一个。
          entry.resolve(await entry.task());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      state.metadataRunning = false;
    }
  }

  // 队列里只剩“还不能启动”的条目时，到最早的就绪时间再试一次，不靠轮询。
  function scheduleMetadataWake(at) {
    if (state.metadataWakeTimer && state.metadataWakeAt <= at) return;
    clearTimeout(state.metadataWakeTimer);
    state.metadataWakeAt = at;
    state.metadataWakeTimer = window.setTimeout(() => {
      state.metadataWakeTimer = 0;
      state.metadataWakeAt = 0;
      drainMetadataQueue();
    }, Math.max(0, at - Date.now()));
  }

  function persistMetadataCooldown() {
    storageSet({ [config.topicRequestCooldownStorageKey]: {
      until: state.metadataCooldownUntil,
      failures: state.metadataRateLimitFailures
    } }).catch((error) => console.warn("[betterLD] 请求冷却状态写入失败", error));
  }

  function resetMetadataRateLimit() {
    if (!state.metadataRateLimitFailures) return;
    state.metadataRateLimitFailures = 0;
    persistMetadataCooldown();
  }

  function applyRateLimit(retryAfter) {
    const now = Date.now();
    const seconds = Number(retryAfter);
    const delay = seconds > 0 ? seconds * 1000 : Date.parse(retryAfter) - now;
    state.metadataRateLimitFailures += 1;
    const backoff = config.topicRequestCooldownMs * state.metadataRateLimitFailures;
    // 递增的是插件退避；站点明确要求的Retry-After始终作为下限。
    state.metadataCooldownUntil = Math.max(state.metadataCooldownUntil,
      now + Math.max(backoff, Number.isFinite(delay) ? delay : 0));
    persistMetadataCooldown();
  }

  // 冷却错误带明确截止时间，调用方可以区分限流与普通失败，不靠猜冷却状态。
  function topicRequestError(message, options) {
    const error = new Error(message);
    Object.assign(error, options);
    return error;
  }

  // 主题 JSON 的唯一出网实现：超时、冷却与错误分类都在这里，冷却错误带明确截止时间。
  async function fetchTopicJson(url) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new DOMException("主题请求超时，请重试", "TimeoutError")), config.topicRequestTimeoutMs);
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: discourseAjaxHeaders,
        signal: controller.signal
      });
      if (response.headers.get("cf-mitigated") === "challenge") {
        applyRateLimit(response.headers.get("Retry-After"));
        throw topicRequestError("主题请求被站点质询拦截，已进入冷却", { rateLimited: true, cooldownUntil: state.metadataCooldownUntil });
      }
      if (response.status === 429) {
        applyRateLimit(response.headers.get("Retry-After"));
        throw topicRequestError("主题请求被站点限流，已进入冷却", { rateLimited: true, cooldownUntil: state.metadataCooldownUntil });
      }
      if (!response.ok) {
        throw new Error(`topic request failed with ${response.status}`);
      }
      const data = await response.json();
      resetMetadataRateLimit();
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // 树任务已在共享队列中启动；它也可满足同 URL 尚在排队的导出等消费者。
  function shareTopicFetch(url, onStart = () => {}) {
    let request = state.responseRequests.get(url);
    if (request?.fetchPromise) {
      onStart(request.startedAt);
      return request.fetchPromise;
    }
    if (!request) {
      request = { consumers: [], settled: false };
      state.responseRequests.set(url, request);
    }
    request.startedAt = Date.now();
    request.fetchPromise = (async () => {
      onStart(request.startedAt);
      for (const consumer of request.consumers) {
        if (consumer.isNeeded()) consumer.onStart(request.startedAt);
      }
      return await fetchTopicJson(url);
    })().then((data) => {
      request.settled = true;
      request.resolve?.(data);
      return data;
    }, (error) => {
      request.settled = true;
      request.reject?.(error);
      throw error;
    }).finally(() => {
      if (state.responseRequests.get(url) === request) state.responseRequests.delete(url);
    });
    return request.fetchPromise;
  }

  function requestTopicResponse(url, isNeeded = () => true, onStart = () => {}, priority = config.topicRequestPriority.body) {
    const consumer = { isNeeded, onStart, priority };
    const existing = state.responseRequests.get(url);
    if (existing) {
      existing.consumers.push(consumer);
      if (existing.startedAt && isNeeded()) onStart(existing.startedAt);
      return existing.promise || existing.fetchPromise;
    }
    const request = { consumers: [consumer], settled: false, fetchPromise: null };
    request.promise = new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
    state.responseRequests.set(url, request);
    scheduleMetadataRequest(
      () => shareTopicFetch(url),
      () => !request.settled && request.consumers.some((entry) => entry.isNeeded()),
      () => Math.min(...request.consumers.filter((entry) => entry.isNeeded()).map((entry) => entry.priority))
    ).catch((error) => {
      if (request.settled) return;
      request.settled = true;
      request.reject(error);
      if (state.responseRequests.get(url) === request) state.responseRequests.delete(url);
    });
    return request.promise;
  }

  // 服务端预载的列表载荷与桥接投影形状不同，这里专门适配预载；缺字段留空，不发逐主题请求。
  function topicListEntries(payload) {
    const users = new Map(
      (Array.isArray(payload?.users) ? payload.users : []).map((user) => [user.id, user])
    );
    return (Array.isArray(payload?.topic_list?.topics) ? payload.topic_list.topics : []).map((topic) => {
      const posters = Array.isArray(topic.posters) ? topic.posters : [];
      const seen = new Set();
      return {
        id: String(topic.id),
        watched: topic.visited === true || Number(topic.last_read_post_number) > 0,
        authorId: Number(topic.creator_id) || Number(posters[0]?.user_id) || 0,
        authorAvatar: String(topic.creator_avatar_template || users.get(posters[0]?.user_id)?.avatar_template || ""),
        author: (typeof topic.creator === "string" ? cleanText(topic.creator) : "")
          || cleanText(users.get(posters[0]?.user_id)?.username),
        activityAt: cleanText(topic.last_posted_at || topic.bumped_at),
        createdAt: cleanText(topic.created_at),
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
          .slice(0, 4)
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
      if (isSearchPage() && preloaded.search) {
        const search = JSON.parse(preloaded.search);
        entries = topicListEntries({ users: search.users, topic_list: { topics: search.topics } });
      } else if (topicIdFromPath() && preloaded[`topic_${topicIdFromPath()}`]) {
        const topic = JSON.parse(preloaded[`topic_${topicIdFromPath()}`]);
        const topics = [...(topic.suggested_topics || []), ...(topic.related_topics || [])];
        const users = topics.flatMap((item) => (item.posters || []).map((poster) => poster.user).filter(Boolean));
        entries = topicListEntries({ users, topic_list: { topics: topics.map((item) => ({
          ...item, posters: (item.posters || []).map((poster) => ({ ...poster, user_id: poster.user?.id ?? poster.user_id }))
        })) } });
      } else if (preloaded.topic_list) {
        entries = topicListEntries(JSON.parse(preloaded.topic_list));
      } else return;
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
    return [...document.querySelectorAll(".betterld-topic-row, .betterld-search-result")];
  }

  // 原站头像模板是路径，实际资产域名由页面自身的 Discourse CDN 配置决定。
  function topicAvatarUrl(template, size) {
    if (!template) return "";
    try {
      const cdn = document.getElementById("data-discourse-setup")?.dataset.cdn;
      const base = new URL(cdn || location.origin);
      const url = new URL(String(template).replace("{size}", String(size)), base);
      return url.protocol === "https:" && [location.origin, base.origin].includes(url.origin)
        && /^\/(user_avatar|letter_avatar)\//.test(url.pathname) ? url.href : "";
    } catch (error) {
      console.warn("[betterLD] 头像路径无效", error);
      return "";
    }
  }

  function applyTopicListMetadata(card) {
    const metadata = state.topicListMetadata.get(card.dataset.topicId);
    if (!metadata) {
      return false;
    }
    let applied = false;
    if (metadata.author) {
      if (card.dataset.filterAuthor !== metadata.author) setAuthor(card, metadata.author, "ready");
      const authorHref = userProfileHref(metadata.author);
      if (card.dataset.authorHref !== authorHref) {
        card.dataset.authorHref = authorHref;
        const menu = card.querySelector(".betterld-topic-card__menu");
        if (menu) renderCardMenuActions(menu, card);
      }
      const avatar = card.querySelector(".betterld-topic-row__avatar");
      const avatarUrl = topicAvatarUrl(metadata.authorAvatar, 48);
      if (avatar && avatar.dataset.source !== avatarUrl) {
        avatar.dataset.source = avatarUrl;
        avatar.replaceChildren();
        if (avatarUrl) {
          const image = document.createElement("img");
          image.src = avatarUrl;
          image.alt = "";
          image.loading = "lazy";
          avatar.append(image);
        }
      }
      if (avatar) {
        avatar.href = card.dataset.authorHref;
        avatar.dataset.userCard = metadata.author;
      }
      applied = true;
    }
    // 活动时间与作者是否可用无关：缺作者但有 activityAt 时也要写入过滤用的数据集。
    if (metadata.activityAt) {
      if (card.dataset.filterActivity !== String(Date.parse(metadata.activityAt))) setTopicActivity(card, metadata.activityAt);
      applied = true;
    }
    setTopicTimes(card, metadata);
    if (metadata.stats?.length) {
      setTopicStats(card, metadata.stats);
      applied = true;
    }
    if (metadata.participants?.length) {
      setTopicParticipants(card, metadata.participants);
      applied = true;
    }
    return applied;
  }

  function applyTopicListMetadataToAll() {
    document.querySelectorAll(".betterld-topic-row").forEach((row) => {
      applyTopicListMetadata(row);
      const badge = row.querySelector('[data-betterld-badge="watched"]');
      if (badge) badge.hidden = !state.topicListMetadata.get(row.dataset.topicId)?.watched;
    });
    document.querySelectorAll(".betterld-search-result").forEach((row) => {
      const metadata = state.topicListMetadata.get(row.dataset.topicId);
      if (metadata) {
        setTopicStats(row, metadata.stats);
        setTopicTimes(row, metadata);
      }
      const badge = row.querySelector('[data-betterld-badge="watched"]');
      if (badge) badge.hidden = !metadata?.watched;
    });
  }

  function uncoveredTopicCards() {
    return [...document.querySelectorAll(".betterld-topic-row")].filter((card) => card.dataset.topicId && card.dataset.authorState === "loading");
  }

  // 站点自己已经为当前列表路由下载过主题数据（无限滚动 / 客户端路由切换），原站模型里就有，
  // 直接从那里读；读不到的字段保持缺失，不额外请求。
  async function syncTopicListMetadataFromSite() {
    const route = `${location.pathname}${location.search}`;
    const generation = state.metadataGeneration;
    const payload = await requestSiteTopicListPayload();
    if (!pageActive() || !payload) {
      return;
    }
    if (`${location.pathname}${location.search}` !== route) return;
    if (payload.current_topic?.id === topicIdFromPath()) {
      const metadata = payload.current_topic;
      const authorAvatar = topicAvatarUrl(metadata.author_avatar_template, 48) || undefined;
      globalThis.BETTERLD_LIBRARY.updateMetadata([{ ...metadata, authorAvatar }]);
    }
    if (!topicListEnhancementEnabled()) return new Set();
    // 桥已完成身份投影；预载与模型计数共用同一统计展示规则。
    const entries = payload.entries.map(({ counts, ...entry }) => ({ ...entry, stats: topicStats(counts) }));
    if (!entries.length || `${location.pathname}${location.search}` !== route || state.metadataRoute !== route || state.metadataGeneration !== generation) {
      return;
    }
    const activeIds = new Set([...managedCards().map((card) => card.dataset.topicId), ...entries.map((entry) => entry.id)]);
    for (const id of state.topicListMetadata.keys()) {
      if (!activeIds.has(id)) state.topicListMetadata.delete(id);
    }
    entries.forEach((entry) => state.topicListMetadata.set(entry.id, entry));
    applyTopicListMetadataToAll();
    return new Set(entries.map((entry) => entry.id));
  }

  function syncTopicListMetadata() {
    if (!pageActive() || (!topicListEnhancementEnabled() && !topicIdFromPath())) return;
    if (state.topicListSync) {
      state.topicListSyncAgain = true;
      return state.topicListSync;
    }
    state.topicListSync = Promise.resolve()
      .then(async () => {
        // 同轮入口合并为一次读取；在途晚到的变化交回已有调度器补齐。
        state.topicListSyncAgain = false;
        if (!pageActive() || (!isTopicListPage() && !isSearchPage() && !topicIdFromPath())) return;
        const generation = state.metadataGeneration;
        const route = `${location.pathname}${location.search}`;
        // 预载元素在文档末尾，注入过早时第一次读不到，这里补一次。
        seedPreloadedTopicList();
        applyTopicListMetadataToAll();
        const coveredCards = uncoveredTopicCards();
        const applied = await syncTopicListMetadataFromSite();
        if (applied && pageActive() && state.metadataGeneration === generation
          && `${location.pathname}${location.search}` === route) {
          // 只结束本轮已读取的行；晚到的新行继续等待自己的模型同步。
          coveredCards.filter((card) => card.isConnected && applied.has(card.dataset.topicId)
            && card.dataset.authorState === "loading")
            .forEach((card) => setAuthor(card, "", "unavailable"));
          return managedCards().every((card) => applied.has(card.dataset.topicId));
        }
        return false;
      })
      .catch((error) => {
        console.warn("[betterLD] 主题列表元数据同步失败", error);
        return false;
      })
      .finally(() => {
        state.topicListSync = null;
        if (state.topicListSyncAgain) {
          state.topicListSyncAgain = false;
          scheduleSync({ lists: false });
        }
      });
    return state.topicListSync;
  }

  function setTopicActivity(card, activityAt) {
    const timestamp = activityAt ? Date.parse(activityAt) : Number.NaN;
    card.dataset.filterActivity = Number.isFinite(timestamp) ? String(timestamp) : "";
    applyCardFilter(card);
  }

  function formatTopicTime(timestamp) {
    const { topicTimeZone, topicTimeHourCycle } = state.currentSettings;
    const key = `${topicTimeZone}/${topicTimeHourCycle}`;
    if (state.topicTimeFormatterKey !== key) {
      state.topicTimeFormatter = new Intl.DateTimeFormat(config.topicTimeFormat.locale, {
        calendar: config.topicTimeFormat.calendar,
        numberingSystem: config.topicTimeFormat.numberingSystem,
        timeZone: topicTimeZone,
        hourCycle: topicTimeHourCycle,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      state.topicTimeFormatterKey = key;
    }
    const parts = Object.fromEntries(state.topicTimeFormatter.formatToParts(timestamp).map(({ type, value }) => [type, value]));
    return `${parts.year}/${parts.month}/${parts.day} ${parts.dayPeriod ? `${parts.dayPeriod} ` : ""}${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function setTopicTimes(card, metadata) {
    const times = card.querySelector(".betterld-topic-row__times");
    if (!times) return;
    for (const [part, value, label] of [["activity", metadata.activityAt, "活跃于"], ["created", metadata.createdAt, "发布于"]]) {
      const time = times.querySelector(`[data-betterld-meta-part="${part}"]`);
      const timestamp = value ? Date.parse(value) : Number.NaN;
      time.hidden = !Number.isFinite(timestamp);
      if (time.hidden) {
        time.removeAttribute("datetime");
        time.removeAttribute("title");
        time.textContent = "";
        continue;
      }
      const text = `${label} ${formatTopicTime(timestamp)}`;
      const title = `${text}（${state.currentSettings.topicTimeZone}）`;
      if (time.dateTime !== value) time.dateTime = value;
      if (time.title !== title) time.title = title;
      if (time.textContent !== text) time.textContent = text;
    }
    times.hidden = !times.querySelector("time:not([hidden])");
  }

  function setAuthor(card, author, stateName) {
    const authorElement = card.querySelector(".betterld-topic-card__author");
    if (!authorElement) {
      return;
    }
    applyAuthorIdentity(authorElement, author);
    authorElement.hidden = !author;
    card.dataset.authorState = stateName;
    card.dataset.filterAuthor = stateName === "ready" ? author : "";
    applyCardFilter(card);
    card.setAttribute("aria-busy", "false");
  }

  function setTopicStats(card, stats) {
    const container = card.querySelector("[data-betterld-topic-stats]");
    if (!container) {
      return;
    }
    const signature = JSON.stringify(stats);
    if (container.dataset.betterldContent === signature) return;
    container.dataset.betterldContent = signature;
    container.replaceChildren(...(Array.isArray(stats) ? stats : []).map((stat) => {
      const item = createElement("span", "betterld-topic-card__stat");
      const icon = createElement("span", "betterld-topic-card__stat-icon");
      const value = createElement("span", "betterld-topic-card__stat-value", String(stat.value));
      item.dataset.betterldStat = stat.key;
      icon.dataset.betterldStatIcon = stat.icon;
      icon.setAttribute("aria-hidden", "true");
      item.setAttribute("aria-label", `${stat.label} ${stat.value}`);
      item.append(icon, value);
      return item;
    }));
    container.hidden = !container.childElementCount;
  }

  function setTopicParticipants(card, participants) {
    const container = card.querySelector("[data-betterld-topic-participants]");
    if (!container) {
      return;
    }
    const entries = (Array.isArray(participants) ? participants : [])
      .map((entry) => ({
        username: cleanText(entry?.username),
        url: topicAvatarUrl(entry?.avatarTemplate, 48)
      }))
      .filter((entry) => entry.url);
    const signature = JSON.stringify(entries);
    if (container.dataset.betterldContent === signature) return;
    container.dataset.betterldContent = signature;
    container.replaceChildren(...entries.map((entry) => {
      const avatar = createElement("a", "betterld-topic-card__avatar betterld-topic-card__participant trigger-user-card");
      avatar.href = userProfileHref(entry.username);
      avatar.dataset.userCard = entry.username;
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
    document.querySelectorAll(".betterld-search-result[data-filter-override], .betterld-topic-row[data-filter-override]").forEach((card) => {
      delete card.dataset.filterOverride;
    });
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
    return { match: domMatch || authorMatch || levelMatch || ageMatch, whitelisted };
  }

  function applyChipHighlights(card, settings) {
    card.querySelectorAll(".discourse-tag").forEach((tag) => {
      const name = cleanText(tag.textContent).replace(/^#/, "");
      const hit = Boolean(settings) && filterRuleMatches(name, settings.tagRules, settings.matchMode);
      tag.dataset.filterHit = hit ? "true" : "false";
    });
    const chip = card.querySelector(".badge-category__name");
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
    if (hidden || state.filterBinHost) scheduleFilterBinRender();
  }

  function scheduleFilterBinRender() {
    if (!pageActive() || state.filterBinFrame) {
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
    const countNode = host.querySelector(".betterld-filter-bin__count");
    if (countNode.textContent !== count) countNode.textContent = count;
    host.querySelector(".betterld-filter-bin__trigger").setAttribute("aria-expanded", String(state.filterBinOpen));
    const title = host.querySelector(".betterld-filter-bin__title");
    const text = `本页已过滤 ${count} 个主题`;
    if (title.textContent !== text) title.textContent = text;
    const list = host.querySelector(".betterld-filter-bin__list");
    const cards = [...state.filterBin];
    const previous = list.betterldCards;
    if (previous?.length === cards.length && cards.every((card, index) =>
      previous[index].card === card && previous[index].title === card.dataset.filterTitle)) return;
    list.betterldCards = cards.map((card) => ({ card, title: card.dataset.filterTitle }));
    list.replaceChildren(...cards.map((card) => {
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
      if (card.hidden) card.hidden = false;
      card.dataset.filterState = "visible";
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
      filterState = verdict.match ? "dimmed" : "visible";
    } else if (settings.mode === "highlight") {
      visible = true;
      filterState = verdict.match ? "highlight" : "visible";
    } else {
      visible = !verdict.match;
      filterState = visible ? "visible" : "hidden";
    }
    if (card.hidden === visible) card.hidden = !visible;
    card.dataset.filterState = filterState;
    applyChipHighlights(card, filterState === "highlight" ? settings : null);
    updateFilterBin(card, !visible, settings);
    const grid = card.closest(".fps-result-entries");
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
    const cards = [...grid.querySelectorAll(".betterld-search-result")];
    const visible = cards.some((card) => !card.hidden);
    let empty = grid.querySelector(":scope > .betterld-topic-empty");
    if (!settings.enabled || visible || !cards.length) {
      empty?.remove();
      delete grid.dataset.betterldFilterEmpty;
      return;
    }
    if (!empty) {
      empty = createElement("section", "betterld-topic-empty");
      empty.setAttribute("role", "status");
      const title = createElement("strong", "betterld-topic-empty__title", "没有符合过滤条件的主题");
      const button = createElement("button", "betterld-topic-empty__button", "关闭主题过滤");
      button.type = "button";
      button.addEventListener("click", disableTopicFilter);
      empty.append(title, button);
      grid.append(empty);
    }
    grid.dataset.betterldFilterEmpty = "true";
  }

  function topicContainers() {
    const root = topicIdFromPath() ? document.querySelector(".more-topics__lists") : mainRoot();
    if (!root) {
      return [];
    }

    const groups = new Map();
    const items = root.querySelectorAll(".topic-list-item, .latest-topic-list-item");
    for (const item of items) {
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
        else if (!result.error) resetMetadataRateLimit();
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
    showActionStatus("正在局部刷新…", "success");
    state.refreshNextAt = Date.now() + config.pageRefreshMinIntervalMs;
    state.refreshPromise = scheduleMetadataRequest(() => refreshSitePage(href), () => location.href === href, () => config.topicRequestPriority.refresh)
      .then(async () => {
        if (location.href !== href) return;
        // 刷新前已启动的读取只负责自己的批次，完成后再读取刷新后的模型。
        if (state.topicListSync) await state.topicListSync;
        if (location.href !== href) return;
        const metadataSync = syncHomepage();
        // 结构增强后立即恢复，避免下一帧继承原站 smooth 再把画面拉回。
        window.scrollTo({ top: scrollY, behavior: "instant" });
        const metadataApplied = await metadataSync;
        if (location.href !== href) return;
        syncFloatingActions();
        if (topicListEnhancementEnabled() && managedCards().length && metadataApplied !== true) {
          showActionStatus("页面已刷新，主题信息尚未同步完成");
        } else {
          showActionStatus("已更新当前页面", "success");
        }
      })
      .catch((error) => {
        console.warn("[betterLD] local refresh failed", error);
        if (location.href === href) showActionStatus(`刷新失败：${error.message}`);
      })
      .finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  function bindTopicLink(title, row) {
    if (!title) return;
    title.classList.add("betterld-topic-card__link", "betterld-topic-card__title");
    if (state.topicLinks.has(title)) return;
    state.topicLinks.add(title);
    title.addEventListener("click", (event) => handleTopicCardClick(event, row, event.currentTarget.href));
  }

  // 首页、搜索与帖底推荐共用信息栏骨架；搜索只在分类和信息栏之间多保留原站摘要。
  function ensureTopicInfo(row, main, topic) {
    const existing = main.querySelector(".betterld-topic-row__info");
    if (existing) return existing;
    const info = createElement("div", "betterld-topic-row__info");
    const avatar = createElement("a", "betterld-topic-row__avatar trigger-user-card");
    avatar.setAttribute("aria-label", "查看作者");
    const author = createElement("a", "betterld-topic-card__author trigger-user-card");
    author.hidden = true;
    const times = createElement("span", "betterld-topic-row__times");
    times.hidden = true;
    for (const part of ["activity", "created"]) {
      const time = createElement("time", "betterld-topic-row__time");
      time.dataset.betterldMetaPart = part;
      time.hidden = true;
      times.append(time);
    }
    const participants = createElement("span", "betterld-topic-card__participants");
    participants.dataset.betterldTopicParticipants = "true";
    const posters = row.querySelector(".posters");
    if (posters) participants.append(...[...posters.querySelectorAll("a")].map((link) => link.cloneNode(true)));
    const stats = createElement("span", "betterld-topic-row__stats");
    stats.dataset.betterldTopicStats = "true";
    const watched = createElement("span", "betterld-topic-card__badge", "已看");
    watched.dataset.betterldBadge = "watched";
    const status = createElement("span", "betterld-topic-row__status");
    status.hidden = true;
    const actions = createElement("span", "betterld-topic-row__actions");
    actions.append(stats, status, createCardMenu(row, row, topic));
    info.append(avatar, author, times, participants, actions);
    main.append(watched, info);
    return info;
  }

  // 保留 Discourse 管理的行与原始链接；只在 main-link 内增加独立信息栏。
  function enhanceTopicRow(row) {
    const topic = topicInfo(row);
    const main = row.querySelector(".main-link, .topic-list-data.main-link");
    if (!topic || !main) return;
    const category = categoryInfo(row);
    row.classList.add("betterld-topic-row");
    row.dataset.topicHref = topic.href;
    row.dataset.topicId = topic.id;
    row.dataset.filterTitle = topic.title;
    row.dataset.filterCategory = category.name;
    row.dataset.filterTags = topicTags(row, category.name).join(" ");
    row.dataset.filterLevel = String(topicLevel(row));
    bindTopicLink(main.querySelector("a.title"), row);
    if (!main.querySelector(".betterld-topic-row__info")) row.dataset.authorState = "loading";
    const info = ensureTopicInfo(row, main, topic);
    const status = info.querySelector(".betterld-topic-row__status");
    const statusText = cleanText(row.querySelector(".topic-status-data")?.textContent);
    if (status.textContent !== statusText) status.textContent = statusText;
    status.hidden = !statusText;
    const watched = main.querySelector('[data-betterld-badge="watched"]');
    const unwatched = !state.topicListMetadata.get(topic.id)?.watched;
    if (watched.hidden !== unwatched) watched.hidden = unwatched;
    applyTopicListMetadata(row);
    applyCardFilter(row);
    row.setAttribute("aria-busy", "false");
  }

  function restoreOriginalTopicLists() {
    closeCardMenus();
    for (const row of managedCards()) {
      row.querySelector(".betterld-topic-row__info")?.remove();
      row.querySelector('[data-betterld-badge="watched"]')?.remove();
      row.querySelectorAll(".betterld-topic-card__link").forEach((title) => title.classList.remove("betterld-topic-card__link", "betterld-topic-card__title"));
      row.querySelectorAll("[data-filter-hit]").forEach((node) => node.removeAttribute("data-filter-hit"));
      if (row.dataset.filterState) row.hidden = false;
      row.removeAttribute("aria-busy");
      row.classList.remove("betterld-topic-row", "betterld-search-result");
      for (const key of ["filterState", "filterOverride", "filterAuthor", "filterActivity", "filterTitle", "filterCategory", "filterTags", "filterLevel", "topicHref", "authorState", "authorHref", "categoryHref", "betterldSearchResult", "betterldMenuOpen"]) delete row.dataset[key];
    }
    document.querySelectorAll(".betterld-topic-list, .betterld-search-results").forEach((container) => {
      container.classList.remove("betterld-topic-list", "betterld-search-results");
      delete container.dataset.betterldFilterEmpty;
    });
    document.querySelectorAll(".betterld-topic-empty").forEach((node) => node.remove());
    state.filterBin.clear();
    state.filterBinHost?.remove();
    state.filterBinHost = null;
  }

  function syncNativeTopicLists() {
    for (const [container, items] of topicContainers()) {
      container.classList.add("betterld-topic-list");
      items.forEach(enhanceTopicRow);
    }
  }

  function syncHomepage({ lists = true } = {}) {
    if (!pageActive() || !state.settingsResolved) return;
    syncTopicPreviewHeader();
    syncTopicExport();
    syncExternalSearch();
    if (lists) {
      if (!topicListEnhancementEnabled()) restoreOriginalTopicLists();
      else if (isSearchPage()) syncNativeSearchResults();
      else if (isTopicListPage() || topicIdFromPath()) syncNativeTopicLists();
      globalThis.BETTERLD_LIBRARY.sync();
    }
    applyListControlsScrollState();
    scheduleFilterBinRender();
    return syncTopicListMetadata();
  }

  // 搜索标题、摘要和命中高亮继续由 Discourse 管理；只追加独立操作栏。
  function enhanceSearchResult(row) {
    const topic = topicInfo(row);
    const main = row.querySelector(".fps-topic");
    if (!topic || !main) return;
    const category = categoryInfo(row);
    row.classList.add("betterld-search-result");
    row.dataset.topicHref = topic.href;
    row.dataset.topicId = topic.id;
    row.dataset.filterTitle = topic.title;
    row.dataset.filterCategory = [...main.querySelectorAll(".badge-category__name")].map((node) => cleanText(node.textContent)).join(" ");
    row.dataset.filterTags = topicTags(row, category.name).join(" ");
    row.dataset.filterLevel = String(topicLevel(row));
    row.dataset.betterldSearchResult = "true";
    bindTopicLink(main.querySelector("a.search-link"), row);
    const info = ensureTopicInfo(row, main, topic);
    const author = cleanText(row.querySelector(".author [data-user-card]")?.dataset.userCard);
    const authorState = author ? "ready" : "unavailable";
    if (row.dataset.filterAuthor !== author || row.dataset.authorState !== authorState || info.querySelector(".betterld-topic-card__author").textContent !== author) {
      setAuthor(row, author, authorState);
    }
    info.querySelector(".betterld-topic-card__author").dataset.userCard = author;
    const avatar = info.querySelector(".betterld-topic-row__avatar");
    const source = row.querySelector(".author a[data-user-card]");
    const image = source?.querySelector("img");
    if (image && avatar.dataset.source !== image.src) {
      avatar.dataset.source = image.src;
      avatar.replaceChildren(image.cloneNode(true));
    }
    avatar.hidden = !image;
    avatar.href = userProfileHref(author);
    avatar.dataset.userCard = author;
    const authorHref = userProfileHref(author);
    const categoryHref = topicCategoryHref(row);
    if (row.dataset.authorHref !== authorHref || row.dataset.categoryHref !== categoryHref) {
      row.dataset.authorHref = authorHref;
      row.dataset.categoryHref = categoryHref;
      renderCardMenuActions(info.querySelector(".betterld-topic-card__menu"), row);
    }
    const date = main.querySelector(".blurb [data-time], .blurb time[datetime]");
    const timestamp = Number(date?.dataset.time);
    const activityAt = date?.getAttribute("datetime") || (Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "");
    const activity = Date.parse(activityAt);
    if (Number.isFinite(activity) && row.dataset.filterActivity !== String(activity)) setTopicActivity(row, activityAt);
    if (!Number.isFinite(activity)) {
      row.dataset.filterActivity = "";
    }
    const metadata = state.topicListMetadata.get(topic.id);
    if (metadata) setTopicStats(row, metadata.stats);
    setTopicTimes(row, metadata || {});
    const watched = main.querySelector('[data-betterld-badge="watched"]');
    const unwatched = !state.topicListMetadata.get(topic.id)?.watched;
    if (watched.hidden !== unwatched) watched.hidden = unwatched;
    applyCardFilter(row);
  }

  function syncNativeSearchResults() {
    document.querySelectorAll(".fps-result-entries").forEach((container) => {
      container.classList.add("betterld-search-results");
      container.querySelectorAll(".fps-result").forEach(enhanceSearchResult);
      syncFilterEmptyState(container);
    });
  }

  function pageActive() {
    return !document.hidden && !state.pageSuspended;
  }

  function scheduleSync({ lists = true } = {}) {
    if (!pageActive() || !state.settingsResolved) return;
    state.syncLists ||= lists;
    if (state.syncTimer) return;
    state.syncTimer = window.setTimeout(() => {
      state.syncTimer = 0;
      if (!pageActive()) return;
      checkRoute();
      const lists = state.syncLists;
      state.syncLists = false;
      syncHomepage({ lists });
      syncSearchLoadMore(state.currentSettings, isSearchPage());
      syncReplyTree();
    }, config.syncDebounceMs);
  }

  function updateRouteState() {
    const route = `${location.pathname}${location.search}`;
    if (state.metadataRoute !== route) {
      state.metadataRoute = route;
      state.metadataGeneration += 1;
      state.topicListMetadata.clear();
      state.topicListSyncAgain = Boolean(state.topicListSync);
    }
    state.lastScrollY = pageScrollTop();
    state.listControlsCollapsed = false;

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
    appearance.applyUserPageAppearance(state.currentSettings);
    applyColorMode();
    syncNavigationState();
    applyChromeSettings();
    syncFloatingActions();
  }

  function topicReplyUrl(topicId, postNumber) {
    return `/t/topic/${topicId}/${postNumber}`;
  }

  function showNativeReply(tree) {
    cancelReplyTreeAnchorRestore(tree);
    resetReplyTreePrefetch(tree);
    if (!tree.userFilters.length && !tree.filterBusy) sessionStorage.setItem(config.topicReadingViewStorageKey, JSON.stringify({ topicId: tree.topicId, native: true }));
    closeReplyReactionPicker(tree);
    // 隐藏树视图时尚未发请求的任务全部作废，不在后台偷偷续载。
    cancelReplyTreeTasks(tree);
    if (tree.wait.pendingJump) ackReplyTreeJump(tree, tree.wait.pendingJump, "视图已切换，楼层跳转请求已取消");
    state.replyTreeNativeTopicId = tree.topicId;
    tree.streamElement.removeAttribute("data-betterld-reply-source");
    tree.topicContainer.removeAttribute("data-betterld-reply-tree-active");
    tree.contentContainer.hidden = true;
    tree.toggle.hidden = false;
    tree.toggle.textContent = "树状回复";
    syncReplyTreeFilterBar(tree);
    syncReplyTreePosition();
  }

  function promptReplyTreeLogin(tree, message = "请登录后使用帖子操作。", status = tree.status) {
    status.textContent = message;
    status.hidden = false;
    document.querySelector(".d-header .login-button")?.click();
  }

  // 筛选错误写在面板内的筛选状态行：原帖模式与树模式都看得到，不用隐藏状态假装筛选可用。
  function showReplyTreeFilterError(tree, message) {
    tree.filterStatus.textContent = message;
    tree.filterStatus.hidden = false;
  }

  function clearReplyTreeFilterError(tree) {
    tree.filterStatus.textContent = "";
    tree.filterStatus.hidden = true;
  }

  async function openReplyTreeComposer(tree, post) {
    tree.status.textContent = "";
    if (!document.querySelector(".current-user")) {
      promptReplyTreeLogin(tree);
      return;
    }
    // 主题权限来自桥的原站投影：不允许回复时明确拒绝，不在客户端假装可以提交。
    if (tree.context?.canCreatePost === false) {
      tree.status.textContent = "当前主题不允许回复。";
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

  async function openReplyTreeMore(tree, post, button) {
    tree.status.textContent = "";
    const body = button.closest(".betterld-reply-tree__body");
    let menu = body.querySelector(":scope > .betterld-reply-tree__native-menu");
    if (menu) {
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
      return;
    }
    menu = createElement("div", "betterld-reply-tree__native-menu");
    menu.dataset.betterldMenuId = crypto.randomUUID();
    menu.id = `betterld-post-menu-${menu.dataset.betterldMenuId}`;
    button.setAttribute("aria-controls", menu.id);
    button.setAttribute("aria-expanded", "true");
    body.insertBefore(menu, body.querySelector(":scope > .betterld-reply-tree__boosts"));
    button.disabled = true;
    try {
      await loadPageRefreshBridge();
      // 首次打开菜单时帖子可能还没随本次渲染登记进原站模型，先登记现有完整帖再挂载。
      if (!tree.registeredPostIds.has(post.id)) {
        document.dispatchEvent(new CustomEvent("betterld:reply-register-posts", {
          detail: JSON.stringify({ topicId: tree.topicId, posts: [post] })
        }));
      }
      await new Promise((resolve, reject) => {
        const id = menu.dataset.betterldMenuId;
        const finish = (error) => {
          clearTimeout(timer);
          document.removeEventListener("betterld:reply-menu-mounted", onResult);
          if (error) reject(error); else resolve();
        };
        const onResult = (event) => {
          const result = JSON.parse(event.detail);
          if (result.id === id) finish(result.error ? new Error(result.error) : null);
        };
        const timer = setTimeout(() => finish(new Error("原站帖子操作加载超时")), config.replyTreeActionTimeoutMs);
        document.addEventListener("betterld:reply-menu-mounted", onResult);
        document.dispatchEvent(new CustomEvent("betterld:reply-menu-mount", {
          detail: JSON.stringify({ id, topicId: tree.topicId, postId: post.id })
        }));
      });
    } catch (error) {
      menu.remove();
      button.setAttribute("aria-expanded", "false");
      button.removeAttribute("aria-controls");
      console.error("[betterLD] native post menu failed", error);
      if (state.replyTree === tree) tree.status.textContent = `帖子操作加载失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
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
    if (!pageActive()) return;
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
    tree.reactionTarget = null;
  }

  function syncReplyReactionPopover(tree) {
    if (!tree.reactionPicker) return;
    const target = tree.reactionTarget;
    const trigger = tree.content.querySelector(`[data-post-number="${target.postNumber}"] > .betterld-reply-tree__card ${target.selector}`);
    if (!trigger || !trigger.getClientRects().length || trigger.disabled || tree.contentContainer.hidden) {
      closeReplyReactionPicker(tree);
      return;
    }
    tree.reactionTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    positionReplyReactionPopover(tree.reactionPicker, trigger);
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
    tree.reactionTarget = { postNumber: Number(trigger.closest('[data-post-number]').dataset.postNumber),
      selector: trigger.classList.contains('betterld-reply-tree__reaction-summary')
        ? '.betterld-reply-tree__reaction-summary' : '.betterld-reply-tree__action[aria-pressed]' };
    positionReplyReactionPopover(popup, trigger);
    const dismiss = (event) => {
      if (!popup.contains(event.target) && !tree.reactionTrigger.contains(event.target)) closeReplyReactionPicker(tree);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        const currentTrigger = tree.reactionTrigger;
        closeReplyReactionPicker(tree);
        currentTrigger.focus();
      }
    };
    const reposition = () => positionReplyReactionPopover(popup, tree.reactionTrigger);
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
      const currentTrigger = tree.reactionTrigger;
      closeReplyReactionPicker(tree);
      currentTrigger.focus();
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
          const avatarPath = topicAvatarUrl(user.avatar_template, 48);
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
          positionReplyReactionPopover(popup, tree.reactionTrigger);
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
        const currentTrigger = tree.reactionTrigger;
        closeReplyReactionPicker(tree);
        toggleReplyTreeReaction(tree, tree.posts.get(post.id), currentTrigger, name);
      });
      picker.append(choice);
    });
    const count = trigger.parentElement.querySelector(".betterld-reply-tree__action-count")?.textContent;
    if (count) {
      const view = createElement("button", "betterld-reply-tree__reaction-view", `查看 ${count} 个回应`);
      view.type = "button";
      view.addEventListener("click", () => openReplyReactionUsers(tree, tree.posts.get(post.id), tree.reactionTrigger));
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
      await requestReplyTreeAction(tree, post, 'like-check');
      if (state.replyTree !== tree || topicIdFromPath() !== tree.topicId) throw new Error('主题已切换');
      const response = await fetch(`/discourse-reactions/posts/${post.id}/custom-reactions/${encodeURIComponent(reaction)}/toggle.json`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { ...discourseAjaxHeaders, "X-CSRF-Token": token }
      });
      if (!response.ok) throw new Error(`回应请求失败（HTTP ${response.status}）`);
      const updated = await response.json();
      if (updated?.id !== post.id || updated.post_number !== post.post_number) throw new Error("回应结果格式不正确");
      const result = await requestReplyTreeAction(tree, post, 'reaction-update', { updated });
      if (state.replyTree?.topicId === tree.topicId && topicIdFromPath() === tree.topicId) {
        mergeReplyTreePost(state.replyTree, result.post);
        renderReplyTree(state.replyTree);
      }
    } catch (error) {
      console.error("[betterLD] reply reaction failed", error);
      if (state.replyTree?.topicId === tree.topicId) state.replyTree.status.textContent = `回应操作失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  // 隐藏楼的真实正文只在用户点击时按需读取一次：走既有请求队列，写回同一个原站模型，
  // 由常规同步把正文带回树里；失败按原样报错，不留旧缓存正文冒充结果。
  async function revealReplyTreeHiddenBody(tree, post, button) {
    button.disabled = true;
    tree.status.textContent = "正在读取被隐藏的正文…";
    try {
      await loadPageRefreshBridge();
      const data = await requestTopicResponse(`/posts/${post.id}/cooked.json`, () => state.replyTree === tree && topicIdFromPath() === tree.topicId);
      if (state.replyTree !== tree) return;
      if (typeof data?.cooked !== "string" || !data.cooked.trim()) throw new Error("站点没有返回该楼正文");
      const result = await requestReplyTreeAction(tree, post, 'reveal', { cooked: data.cooked });
      if (state.replyTree !== tree) return;
      mergeReplyTreePost(tree, result.post);
      tree.status.textContent = "";
      renderReplyTree(tree);
    } catch (error) {
      if (state.replyTree === tree) tree.status.textContent = `读取隐藏正文失败：${error.message}`;
      button.disabled = false;
    }
  }

  async function requestReplyTreeAction(tree, post, action, detail = {}) {
    await loadPageRefreshBridge();
    if (state.replyTree !== tree || topicIdFromPath() !== tree.topicId) throw new Error('主题已切换');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error, payload) => {
        clearTimeout(timer);
        document.removeEventListener('betterld:reply-action-wait', onWait);
        document.removeEventListener('betterld:reply-action-result', onResult);
        if (error) reject(error); else resolve(payload);
      };
      const onResult = (event) => {
        const payload = JSON.parse(event.detail);
        if (payload.id === id) finish(payload.error ? new Error(payload.error) : null, payload);
      };
      let timer;
      const armTimeout = () => {
        timer = setTimeout(() => finish(new Error('原站操作响应超时，结果尚未确认，请核对最新帖子状态后再操作')), config.replyTreeActionTimeoutMs);
      };
      const onWait = (event) => {
        const payload = JSON.parse(event.detail);
        if (payload.id !== id) return;
        clearTimeout(timer);
        if (!payload.waiting) armTimeout();
      };
      armTimeout();
      document.addEventListener('betterld:reply-action-wait', onWait);
      document.addEventListener('betterld:reply-action-result', onResult);
      document.dispatchEvent(new CustomEvent('betterld:reply-action', {
        detail: JSON.stringify({ id, topicId: tree.topicId, postId: post.id, action, ...detail })
      }));
    });
  }

  async function manageReplyTreeBoost(tree, post, boost, action, button) {
    button.disabled = true;
    tree.status.textContent = '';
    try {
      let permissions;
      if (boost.can_delete === undefined || boost.can_flag === undefined || (action === 'flag' && !Array.isArray(boost.available_flags))) {
        permissions = await requestTopicResponse(`/discourse-boosts/boosts/${boost.id}`, () => state.replyTree === tree && topicIdFromPath() === tree.topicId);
        if (!permissions || typeof permissions.can_delete !== 'boolean' || typeof permissions.can_flag !== 'boolean') throw new Error('Boost 权限响应不完整');
      }
      const result = await requestReplyTreeAction(tree, post, `boost-${action}`, { boostId: boost.id, permissions });
      if (state.replyTree !== tree) return;
      if (result.post) mergeReplyTreePost(tree, result.post);
      renderReplyTree(tree);
      tree.status.textContent = result.cancelled ? '已取消删除 Boost' : action === 'delete' ? '已删除 Boost' : action === 'flag' ? '已打开原站举报窗口' : '';
    } catch (error) {
      if (state.replyTree === tree) {
        if (action === 'inspect') {
          tree.boostExpanded.delete(boost.id);
          renderReplyTree(tree);
        }
        tree.status.textContent = `Boost 操作失败：${error.message}`;
      }
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

  function preloadedCurrentUser() {
    const source = document.querySelector("#data-preloaded")?.textContent;
    if (!source) return null;
    try {
      const current = JSON.parse(source).currentUser;
      return current ? JSON.parse(current) : null;
    } catch (error) {
      console.error("[betterLD] 当前用户预载数据无效", error);
      return null;
    }
  }

  // 原站编辑器的头像是当前用户的 48px avatar_template（显示尺寸 24px），直接从预载用户数据取，不自造一份。
  function currentUserAvatarPath() {
    return topicAvatarUrl(preloadedCurrentUser()?.avatar_template, 48);
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

  function syncReplyBoostControls(tree, bubble, post, boost) {
    const signature = JSON.stringify([tree.context?.currentUserId, tree.boostExpanded.has(boost.id), boost.can_delete, boost.can_flag, boost.available_flags]);
    if (bubble.dataset.betterldBoostControls === signature) return;
    bubble.dataset.betterldBoostControls = signature;
    bubble.querySelectorAll(':scope > .betterld-reply-tree__boost-control').forEach((control) => control.remove());
    const actionable = Boolean(tree.context?.currentUserId) &&
      (boost.can_delete === undefined || boost.can_flag === undefined || boost.can_delete || boost.can_flag);
    const expanded = actionable && tree.boostExpanded.has(boost.id);
    bubble.classList.toggle('--actionable', actionable);
    bubble.classList.toggle('--selected', expanded);
    const cooked = bubble.querySelector(':scope > .discourse-boosts__cooked');
    if (actionable) {
      cooked.setAttribute('role', 'button');
      cooked.tabIndex = 0;
      cooked.setAttribute('aria-expanded', String(expanded));
      cooked.setAttribute('aria-label', '展开或收起 Boost 操作');
    } else {
      cooked.removeAttribute('role');
      cooked.removeAttribute('tabindex');
      cooked.removeAttribute('aria-expanded');
      cooked.removeAttribute('aria-label');
      tree.boostExpanded.delete(boost.id);
    }
    if (!expanded) return;
    for (const [allowed, action, label, icon] of [[boost.can_flag, 'flag', '举报 Boost', 'flag'], [boost.can_delete, 'delete', '删除 Boost', 'trash-can']]) {
      if (!allowed) continue;
      const control = replyTreeActionButton(label, icon, () => {
        if (action === 'flag') {
          tree.boostExpanded.delete(boost.id);
          syncReplyBoostControls(tree, bubble, post, boost);
        }
        const current = tree.posts.get(post.id);
        manageReplyTreeBoost(tree, current, current.boosts.find((entry) => entry.id === boost.id), action, control);
      }, 'betterld-reply-tree__boost-control');
      bubble.append(control);
    }
  }

  async function toggleReplyBoostControls(tree, bubble, post, boost) {
    if (!bubble.classList.contains('--actionable')) return;
    if (tree.boostExpanded.has(boost.id)) {
      tree.boostExpanded.delete(boost.id);
      syncReplyBoostControls(tree, bubble, post, boost);
      return;
    }
    if (bubble.dataset.betterldBoostBusy) return;
    tree.boostExpanded.add(boost.id);
    syncReplyBoostControls(tree, bubble, post, boost);
    if (boost.can_delete === undefined || boost.can_flag === undefined) {
      bubble.dataset.betterldBoostBusy = 'true';
      bubble.setAttribute('aria-busy', 'true');
      try {
        await manageReplyTreeBoost(tree, post, boost, 'inspect', bubble.querySelector('.discourse-boosts__cooked'));
      } finally {
        delete bubble.dataset.betterldBoostBusy;
        bubble.removeAttribute('aria-busy');
      }
    }
  }

  function replyTreeBoostSection(tree, post) {
    const boosts = Array.isArray(post.boosts) ? post.boosts.filter((boost) => boost?.cooked) : [];
    const editing = tree.boostEditor?.postNumber === post.post_number;
    if (!boosts.length && !editing) return null;
    const wrapper = createElement("div", "discourse-boosts__post-menu betterld-reply-tree__boosts");
    const list = createElement("div", "discourse-boosts__list");
    for (const boost of boosts) {
      const bubble = createElement("span", "discourse-boosts__bubble");
      bubble.dataset.boostId = String(boost.id);
      const username = cleanText(boost.user?.username);
      const avatarPath = topicAvatarUrl(boost.user?.avatar_template, 48);
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
      cooked.dataset.betterldCookedId = crypto.randomUUID();
      cooked.betterldCookedPost = { ...post, cooked: boost.cooked, embeddedPost: true };
      bubble.append(cooked);
      const toggle = (event) => {
        if (event.target.closest('a, button, input, video, audio, iframe, summary')) return;
        if (event.type === 'keydown') {
          if (event.target !== cooked || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
        }
        toggleReplyBoostControls(tree, bubble, tree.posts.get(post.id),
          tree.posts.get(post.id).boosts.find((entry) => entry.id === boost.id));
      };
      cooked.addEventListener('click', toggle);
      cooked.addEventListener('keydown', toggle);
      syncReplyBoostControls(tree, bubble, post, boost);
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

  function syncReplyTreeChildren(parent, children) {
    children.forEach((child, index) => {
      if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
    });
    const kept = new Set(children);
    [...parent.children].forEach((child) => { if (!kept.has(child)) child.remove(); });
  }

  function replyTreePostGraph(tree) {
    if (!tree.stream.length) return { posts: [], streamNumbers: new Set(), contextNumbers: new Set(), byNumber: new Map() };
    const reading = replyTreeWindow(tree);
    const windowIds = reading && !reading.empty ? tree.stream.slice(reading.lo, reading.hi + 1) : [];
    // 缓存可有多个不相连的读段；只投影当前窗口，避免上翻掉回帖首缓存。
    const streamPosts = windowIds.map((id) => tree.posts.get(id)).filter(Boolean).sort((a, b) => a.post_number - b.post_number);
    const root = [...tree.posts.values()].find((post) => post.post_number === 1);
    if (root && !streamPosts.includes(root)) streamPosts.unshift(root);
    const streamNumbers = new Set(streamPosts.map((post) => post.post_number));
    const loadedByNumber = new Map([...tree.posts.values()].map((post) => [post.post_number, post]));
    const contextNumbers = new Set();
    for (const post of streamPosts) {
      let child = post;
      let parentNumber = Number(child.reply_to_post_number);
      while (parentNumber >= 1 && parentNumber < child.post_number && !streamNumbers.has(parentNumber) && !contextNumbers.has(parentNumber)) {
        const parent = loadedByNumber.get(parentNumber);
        if (!parent) break;
        contextNumbers.add(parentNumber);
        child = parent;
        parentNumber = Number(child.reply_to_post_number);
      }
    }
    const posts = [...streamPosts, ...[...contextNumbers].map((number) => loadedByNumber.get(number))].sort((a, b) => a.post_number - b.post_number);
    return { posts, streamNumbers, contextNumbers, byNumber: new Map(posts.map((post) => [post.post_number, post])) };
  }

  function replyBranchExpanded(tree, number) {
    return tree.branchStates.get(number) ?? number === 1;
  }

  function expandReplyBranchPath(tree, post, byNumber) {
    let child = post;
    while (child && child.post_number !== 1) {
      const parent = Number(child.reply_to_post_number);
      const number = parent > 1 && parent < child.post_number && byNumber.has(parent) ? parent : 1;
      tree.branchStates.set(number, true);
      const tails = tree.tailStates.get(number);
      if (tails) {
        for (const after of tails) {
          if (child.post_number > after) tails.delete(after);
        }
        if (!tails.size) tree.tailStates.delete(number);
      }
      child = byNumber.get(number);
    }
    tree.branchStates.set(1, true);
  }

  function setReplyBranchHighlight(tree, number) {
    if (tree.highlightedBranch === number && (!number || tree.content.querySelector(`[data-post-number="${number}"][data-branch-highlight]`))) return;
    tree.content.querySelector('[data-branch-highlight]')?.removeAttribute('data-branch-highlight');
    tree.highlightedBranch = number;
    if (number) tree.content.querySelector(`[data-post-number="${number}"]`)?.setAttribute('data-branch-highlight', 'true');
  }

  function bindReplyBranchInteraction(tree) {
    const owner = (target) => Number(target instanceof Element ? target.closest('[data-reply-branch-owner]')?.dataset.replyBranchOwner : 0) || 0;
    // 后续同级入口独立高亮；父分支的连线与组首按钮才共享整组状态。
    const highlightOwner = (target) => target instanceof Element && target.closest('[data-reply-tail-after]') ? 0 : owner(target);
    tree.content.addEventListener('pointerover', (event) => setReplyBranchHighlight(tree, highlightOwner(event.target)));
    tree.content.addEventListener('pointerout', (event) => setReplyBranchHighlight(tree, highlightOwner(event.relatedTarget)));
    tree.content.addEventListener('focusin', (event) => setReplyBranchHighlight(tree, highlightOwner(event.target)));
    tree.content.addEventListener('focusout', (event) => setReplyBranchHighlight(tree, highlightOwner(event.relatedTarget)));
    tree.content.addEventListener('click', (event) => {
      const number = owner(event.target);
      if (!number) return;
      event.preventDefault();
      const scrollTop = pageScrollTop();
      const tail = event.target.closest('[data-reply-tail-after]');
      if (tail) {
        const after = Number(tail.dataset.replyTailAfter);
        const tails = tree.tailStates.get(number) || new Set();
        if (tails.has(after)) tails.delete(after);
        else tails.add(after);
        if (tails.size) tree.tailStates.set(number, tails);
        else tree.tailStates.delete(number);
      } else {
        const item = tree.content.querySelector(`[data-post-number="${number}"]`);
        const hasReplies = Boolean(item.querySelector(':scope > .betterld-reply-tree__children'));
        tree.branchStates.set(number, hasReplies && !tree.branchStates.has(number)
          ? !replyBranchExpanded(tree, number) : tree.branchStates.get(number) === false);
      }
      // 主动收起的意图优先于当前阅读路径保留。
      tree.skipBranchAnchor = true;
      tree.skipAnchorRestore = true;
      tree.bodyLoadBlocked = true;
      resetReplyTreePrefetch(tree);
      cancelReplyTreeAnchorRestore(tree);
      tree.compensating = true;
      try {
        renderReplyTree(tree);
        // 收放只改变分支，不把视口跟随新出现的子楼或重测后的控件。
        if (pageScrollTop() !== scrollTop) window.scrollTo({ top: scrollTop, behavior: 'instant' });
        tree.bodyLoadScrollTop = pageScrollTop();
      } finally {
        window.setTimeout(() => {
          if (state.replyTree !== tree) return;
          tree.bodyLoadScrollTop = pageScrollTop();
          tree.compensating = false;
        }, 0);
      }
    });
  }

  function replyBranchAnchor(item) {
    const card = item.querySelector(':scope > .betterld-reply-tree__card');
    const avatar = card.querySelector('.betterld-reply-tree__avatar-wrap :is(img, .betterld-reply-tree__avatar)')
      || card.querySelector('.betterld-reply-tree__avatar-wrap').firstElementChild;
    const bounds = avatar.getBoundingClientRect();
    return { bottom: bounds.bottom, centerY: bounds.top + bounds.height / 2 };
  }

  function setReplyBranchCoordinate(item, property, y) {
    const value = `${y}px`;
    if (item.style.getPropertyValue(property) !== value) item.style.setProperty(property, value);
  }

  function replyBranchLayoutChanged(tree, item) {
    const card = item.querySelector(':scope > .betterld-reply-tree__card');
    const bounds = card.getBoundingClientRect();
    const anchor = replyBranchAnchor(item);
    const layout = `${bounds.width}:${bounds.height}:${anchor.centerY - bounds.top}`;
    const previous = tree.branchLayouts.get(card);
    tree.branchLayouts.set(card, layout);
    return previous !== layout;
  }

  function invalidateReplyBranchLayout(tree, item) {
    for (let owner = item; owner; owner = owner.parentElement.closest('.betterld-reply-tree__item')) {
      tree.branchDirty.add(owner);
      let previous = owner.previousElementSibling;
      while (previous?.hasAttribute('data-betterld-system-event')) previous = previous.previousElementSibling;
      if (previous) tree.branchDirty.add(previous);
    }
  }

  function setReplyBranchSpace(item, bottom) {
    if (!bottom) {
      item.style.removeProperty('min-height');
      return;
    }
    const style = getComputedStyle(item);
    const inset = style.boxSizing === 'border-box' ? 0
      : parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const value = `${Math.max(0, bottom - inset)}px`;
    if (item.style.minHeight !== value) item.style.minHeight = value;
  }

  function cancelReplyBranchLayout(tree) {
    cancelAnimationFrame(tree.branchLayoutFrame);
    tree.branchLayoutFrame = 0;
  }

  function scheduleReplyBranchLayout(tree) {
    if (tree.branchLayoutFrame || !pageActive() || tree.contentContainer.hidden) return;
    tree.branchLayoutFrame = requestAnimationFrame(() => {
      tree.branchLayoutFrame = 0;
      if (state.replyTree === tree && pageActive()) positionReplyBranchControls(tree);
    });
  }

  function positionReplyBranchControls(tree, preservePosition = true) {
    if (state.replyTree !== tree || tree.contentContainer.hidden) return;
    const anchor = preservePosition && pageActive() ? captureReplyTreeAnchor(tree) : null;
    const items = [...tree.content.querySelectorAll('.betterld-reply-tree__item:not([data-betterld-system-event])')].filter((item) => item.getClientRects().length);
    for (const item of items) {
      // 隐藏正文的原生挂载由 DOM 通知失效；可见尺寸变化继续使用几何签名。
      if (replyBranchLayoutChanged(tree, item)) invalidateReplyBranchLayout(tree, item);
    }
    // 先同步后代占位，再测祖先后续入口；旧 tail 占位不能参与自身中点计算。
    for (const item of items.reverse()) {
      const button = item.querySelector(':scope > .betterld-reply-tree__collapse');
      const tail = item.querySelector(':scope > .betterld-reply-tree__tail-control');
      const refresh = tree.branchDirty.has(item);
      // 无尺寸/正文/收放变化时不清占位或临时展开，避免重复通知改变滚动布局。
      if (!refresh) continue;
      let bottom = 0;
      setReplyBranchSpace(item, 0);
      if (button) {
        const collapsed = button.getAttribute('aria-expanded') === 'false';
        const cached = item.style.getPropertyValue('--betterld-branch-toggle-y');
        const preserve = collapsed || tree.tailStates.get(Number(item.dataset.postNumber))?.size;
        if (!preserve || !cached || refresh) {
          const anchor = replyBranchAnchor(item);
          const children = item.querySelector(':scope > .betterld-reply-tree__children');
          const wasHidden = children.hidden;
          try {
            children.hidden = false;
            const firstVisible = [...children.children].find((child) => !child.hidden && !child.hasAttribute('data-betterld-system-event'));
            const y = firstVisible ? (anchor.centerY + replyBranchAnchor(firstVisible).centerY) / 2 : anchor.bottom + button.offsetHeight / 2;
            setReplyBranchCoordinate(item, '--betterld-branch-toggle-y', y - item.getBoundingClientRect().top);
            if (firstVisible && !tree.branchLayouts.has(firstVisible.querySelector(':scope > .betterld-reply-tree__card'))) replyBranchLayoutChanged(tree, firstVisible);
          } finally {
            children.hidden = wasHidden;
          }
        }
        if (collapsed) bottom = parseFloat(item.style.getPropertyValue('--betterld-branch-toggle-y')) + button.offsetHeight / 2;
      }
      setReplyBranchSpace(item, bottom);
      if (tail) {
        const collapsed = tail.getAttribute('aria-expanded') === 'false';
        const cached = item.style.getPropertyValue('--betterld-reply-tail-y');
        if (!collapsed || !cached || refresh) {
          let next = item.nextElementSibling;
          while (next?.hasAttribute('data-betterld-system-event')) next = next.nextElementSibling;
          const wasHidden = next.hidden;
          try {
            next.hidden = false;
            const y = (replyBranchAnchor(item).centerY + replyBranchAnchor(next).centerY) / 2;
            setReplyBranchCoordinate(item, '--betterld-reply-tail-y', y - item.getBoundingClientRect().top);
            if (!tree.branchLayouts.has(next.querySelector(':scope > .betterld-reply-tree__card'))) replyBranchLayoutChanged(tree, next);
          } finally {
            next.hidden = wasHidden;
          }
        }
        if (collapsed) {
          const y = parseFloat(item.style.getPropertyValue('--betterld-reply-tail-y'));
          bottom = Math.max(bottom, y + tail.offsetHeight / 2);
          setReplyBranchCoordinate(item, '--betterld-reply-trunk-end', y + tail.firstElementChild.offsetHeight / 2);
        }
      }
      setReplyBranchSpace(item, bottom);
      const branch = item.querySelector(':scope > .betterld-reply-tree__children:not([hidden])');
      if (branch) {
        const last = [...branch.children].findLast((child) => !child.hidden && !child.hasAttribute('data-betterld-system-event'));
        if (last) {
          const trunk = last.querySelector(':scope > .betterld-reply-tree__line-hit--trunk');
          const top = parseFloat(getComputedStyle(item, '::after').top);
          const height = trunk.getBoundingClientRect().bottom - item.getBoundingClientRect().top - top;
          setReplyBranchCoordinate(item, '--betterld-reply-trunk-height', height);
        }
      }
      tree.branchDirty.delete(item);
    }
    // 临时清占位、展开隐藏内容的测量也可能触发浏览器滚动钳制。
    // 只在最终几何确定后保留读段，不让观察器每轮把视口推向更早楼层。
    restoreReplyTreeAnchor(tree, anchor);
  }

  function syncReplyTailControls(tree, branch, parentNumber) {
    const siblings = [...branch.children].filter((item) => !item.hasAttribute('data-betterld-system-event'));
    for (const event of branch.querySelectorAll(':scope > [data-betterld-system-event]')) {
      event.hidden = false;
      event.removeAttribute('data-reply-last-visible');
      event.querySelector(':scope > .betterld-reply-tree__tail-control')?.remove();
    }
    const tails = tree.tailStates.get(parentNumber);
    // 先显示最前面的收起点；恢复后仍保留后面各段原来的收放选择。
    const collapsedIndex = siblings.findIndex((item, index) => index < siblings.length - 1 && tails?.has(Number(item.dataset.postNumber)));
    const collapsed = collapsedIndex !== -1;
    const stop = collapsed ? collapsedIndex : siblings.length - 1;
    siblings.forEach((item, index) => {
      item.hidden = index > stop;
      item.toggleAttribute('data-reply-last-visible', index === stop);
      item.style.removeProperty('--betterld-reply-trunk-end');
      const needsButton = collapsed ? index === stop : index < siblings.length - 1;
      let button = item.querySelector(':scope > .betterld-reply-tree__tail-control');
      if (!needsButton) {
        button?.remove();
        return;
      }
      if (!button) {
        button = createElement('button', 'betterld-reply-tree__tail-control');
        button.type = 'button';
        const symbol = createElement('span', 'betterld-reply-tree__collapse-symbol');
        symbol.setAttribute('aria-hidden', 'true');
        button.append(symbol);
        item.append(button);
      }
      const expanded = !collapsed;
      const count = siblings.length - index - 1;
      button.dataset.replyBranchOwner = String(parentNumber);
      button.dataset.replyTailAfter = item.dataset.postNumber;
      button.firstElementChild.textContent = expanded ? '−' : '+';
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', `${expanded ? '收起' : '展开'} #${item.dataset.postNumber} 后面的 ${count} 条同级回复`);
    });
  }

  function syncReplyReadIndicator(card, read) {
    if (typeof read !== 'boolean') return;
    const head = card.querySelector('.betterld-reply-tree__head');
    let indicator = head.querySelector('.betterld-reply-tree__read-state');
    if (!indicator) {
      indicator = createElement('span', 'betterld-reply-tree__read-state');
      head.prepend(indicator);
    }
    indicator.classList.toggle('is-read', read);
    indicator.title = read ? '已读' : '未读';
    indicator.setAttribute('aria-label', indicator.title);
  }

  function syncReplyReadStates(tree, posts) {
    for (const entry of posts) {
      const post = tree.posts.get(entry.id);
      if (!post || typeof entry.read !== 'boolean') continue;
      post.read = entry.read;
      // 切回时的新模型状态也覆盖尚未消费的旧增量，避免正文任务结束后倒灌旧圆点。
      const pending = tree.pendingData?.posts.find((value) => value.id === entry.id);
      if (pending) pending.read = entry.read;
      const card = tree.content.querySelector(`[data-post-number="${post.post_number}"] > .betterld-reply-tree__card`);
      if (card) syncReplyReadIndicator(card, entry.read);
    }
  }

  function captureReplyTreeAnchor(tree) {
    if (tree.contentContainer.hidden) return null;
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    for (const card of tree.content.querySelectorAll('.betterld-reply-tree__card')) {
      if (!card.getClientRects().length) continue;
      const bounds = card.getBoundingClientRect();
      if (bounds.bottom > headerHeight && bounds.top < innerHeight) {
        return { card, number: card.parentElement.dataset.postNumber, top: bounds.top };
      }
    }
    return null;
  }

  function cancelReplyTreeAnchorRestore(tree) {
    if (!tree.anchorRestoreTimer) return;
    clearTimeout(tree.anchorRestoreTimer);
    tree.anchorRestoreTimer = 0;
    tree.compensating = false;
  }

  function restoreReplyTreeAnchor(tree, anchor) {
    if (!anchor || tree.contentContainer.hidden) return;
    const card = tree.content.querySelector(`[data-post-number="${anchor.number}"] > .betterld-reply-tree__card`);
    if (!card?.getClientRects().length) return;
    const delta = card.getBoundingClientRect().top - anchor.top;
    if (!delta) return;
    cancelReplyTreeAnchorRestore(tree);
    tree.compensating = true;
    // 一次即时补偿；auto 会继承原站的平滑滚动，旧基线不能跨任务继续纠偏。
    window.scrollBy({ top: delta, behavior: 'instant' });
    tree.bodyLoadScrollTop = pageScrollTop();
    const generation = tree.filterGeneration;
    tree.anchorRestoreTimer = window.setTimeout(() => {
      tree.anchorRestoreTimer = 0;
      tree.compensating = false;
      if (replyTreeTaskActive(tree, generation)) maybeLoadMoreReplyTree(tree);
    }, 0);
  }

  function renderReplyTree(tree) {
    if (!tree.context) return;
    if (!pageActive() || !tree.bridgeReady || tree.wait.pendingJump?.state === 'neighborhood') {
      tree.renderPending = true;
      return;
    }
    tree.renderPending = false;
    cancelReplyBranchLayout(tree);
    cancelReplyTreeAnchorRestore(tree);
    tree.positionedPost = null;
    for (const post of tree.posts.values()) {
      if (typeof post.bookmarked === "boolean") syncReplyBookmark(tree, post, post.bookmarked);
    }
    // 只取可见的直接 CARD；item 的矩形包含整棵子树。
    const anchor = tree.skipAnchorRestore ? null : captureReplyTreeAnchor(tree);
    tree.skipAnchorRestore = false;
    const anchorCard = anchor?.card;
    const anchorNumber = anchor?.number || "";
    const focusedBoostInput = document.activeElement?.closest?.(".betterld-reply-tree__boost-editor") ? document.activeElement : null;
    const focusedReactionTrigger = tree.reactionPicker && document.activeElement === tree.reactionTrigger;
    // 摘要流中的回复沿已有祖先补作上下文，正文默认折叠但命中子树保持可见。
    const { posts, streamNumbers, contextNumbers, byNumber } = replyTreePostGraph(tree);
    if (!tree.skipBranchAnchor && anchorNumber && byNumber.has(Number(anchorNumber))) {
      const post = byNumber.get(Number(anchorNumber));
      const previousPath = [];
      let container = anchorCard.parentElement.parentElement.closest('.betterld-reply-tree__item');
      while (container) {
        previousPath.push(Number(container.dataset.postNumber));
        container = container.parentElement.closest('.betterld-reply-tree__item');
      }
      const nextPath = [];
      let child = post;
      while (child && child.post_number !== 1) {
        const parent = Number(child.reply_to_post_number);
        const number = parent > 1 && parent < child.post_number && byNumber.has(parent) ? parent : 1;
        nextPath.push(number);
        child = byNumber.get(number);
      }
      // 比较整条归属路径：补祖父楼也须保持阅读，普通同步不推翻收放选择。
      if (previousPath.join(',') !== nextPath.join(',')) expandReplyBranchPath(tree, post, byNumber);
    }
    tree.skipBranchAnchor = false;
    const topicOwnerId = byNumber.get(1)?.user_id;
    const currentUserId = preloadedCurrentUser()?.id;
    const children = new Map(posts.map((post) => [post.post_number, []]));
    const cachedParents = new Set([...tree.posts.values()].map((post) => Number(post.reply_to_post_number)));
    for (const post of posts) {
      if (post.post_number === 1) continue;
      const parent = Number(post.reply_to_post_number);
      // 系统事件属于主题时间流，不充当回复树的父节点或子分支。
      const parentPost = byNumber.get(parent);
      const key = post.post_type !== 3 && parent > 1 && parent < post.post_number && parentPost && parentPost.post_type !== 3 ? parent : 1;
      children.get(key)?.push(post);
    }

    const existingItems = new Map([...tree.content.querySelectorAll(".betterld-reply-tree__item")]
      .map((item) => [Number(item.dataset.postNumber), item]));
    const previousPosts = tree.renderedPosts || new Map();
    const renderedPosts = new Map();
    // 同一次渲染里签名要被变更比对与 renderPost 各算一次，按楼号缓存避免同帖重复序列化。
    const signatures = new Map();
    const signatureFor = (post) => {
      const cached = signatures.get(post.post_number);
      if (cached !== undefined) return cached;
      const badgeIds = tree.userBadges?.users?.[post.user_id]?.badge_ids;
      // 上下文身份本身参与签名：命中楼变成上下文楼时属性与正文折叠状态都要重排。
      const isContextPost = contextNumbers.has(post.post_number);
      const signature = JSON.stringify([post, state.currentSettings.replyTreeNameMode, topicOwnerId, currentUserId,
        badgeIds?.map((id) => tree.userBadges.badges[id]), byNumber.has(Number(post.reply_to_post_number)),
        tree.parentLoadingNumber === Number(post.reply_to_post_number), tree.parentErrors.get(Number(post.reply_to_post_number)),
        userMarksApi.find(state.userMarks, post.user_id)?.tag || "",
        tree.boostEditor?.postNumber === post.post_number,
        isContextPost, isContextPost && tree.contextExpanded.has(post.post_number),
        tree.context?.currentUserId, tree.context?.canCreatePost, post.post_number === 1 && tree.context?.hasAcceptedAnswers,
        replyTreePostIgnored(tree, post)]);
      signatures.set(post.post_number, signature);
      return signature;
    };
    const changedAuthors = new Set();
    for (const [number, rendered] of previousPosts) {
      const post = byNumber.get(number);
      if (!post || signatureFor(post) !== rendered.signature) changedAuthors.add(rendered.id);
    }
    if (changedAuthors.size) {
      document.dispatchEvent(new CustomEvent("betterld:reply-author-reset", {
        detail: JSON.stringify({ postIds: [...changedAuthors] })
      }));
    }
    const list = tree.listElement;
    function renderPost(post) {
      const existing = existingItems.get(post.post_number);
      const previous = previousPosts.get(post.post_number);
      const signature = signatureFor(post);
      const editing = tree.boostEditor?.postNumber === post.post_number;
      const isContext = contextNumbers.has(post.post_number);
      const bodyState = replyTreeBodyState(post);
      const ignoredAuthor = replyTreePostIgnored(tree, post);
      renderedPosts.set(post.post_number, { id: post.id, signature, cooked: post.cooked, bodyState, ignoredAuthor, boostUserId: tree.context?.currentUserId, boosts: post.boosts, canBoost: post.can_boost, editing });
      if (existing && previous?.signature === signature) return syncChildren(existing, post);
      const item = existing || createElement("li", "betterld-reply-tree__item");
      item.dataset.postNumber = String(post.post_number);
      item.toggleAttribute('data-betterld-system-event', post.post_type === 3);
      if (isContext) item.dataset.betterldContext = "true";
      else delete item.dataset.betterldContext;
      // 帖子身份挂在卡片上而不是 li 上：原站选文引用按最近的祖先识别楼层，挂在 li 会把引用的楼错认成祖先楼。
      const card = createElement("article", "betterld-reply-tree__card boxed");
      card.dataset.postId = String(post.id);
      card.dataset.topicId = tree.topicId;
      const avatarWrap = createElement("div", "topic-avatar betterld-reply-tree__avatar-wrap");
      const avatar = createElement("img", "betterld-reply-tree__avatar");
      const avatarPath = topicAvatarUrl(post.avatar_template, 48);
      if (avatarPath) avatar.src = avatarPath;
      avatar.alt = "";
      avatar.loading = "lazy";
      const username = cleanText(post.username);
      const nickname = cleanText(post.name);
      const avatarHref = userProfileHref(username);
      // 忽略列表来自原站 currentUser，正文宿主随忽略状态改变同步替换。
      const avatarLink = avatarHref ? createElement("a", "betterld-reply-tree__avatar-link trigger-user-card") : null;
      if (avatarLink) {
        avatarLink.href = avatarHref;
        avatarLink.dataset.userCard = username;
        avatarLink.setAttribute("aria-label", `查看 ${nickname || username} 的个人资料`);
        avatarLink.append(avatar);
      }
      avatarWrap.append(avatarLink || avatar);
      // 无状态的作者也交给原站 User 模型追踪，才能接收后续设置的新状态。
      if (Number.isInteger(post.user_id) && username) {
        const badges = tree.userBadges?.users?.[post.user_id]?.badge_ids;
        avatarWrap.dataset.betterldAuthorDetails = JSON.stringify({
          ...post,
          user_badges: badges?.map((id) => tree.userBadges.badges[id])
        });
      }
      const body = createElement("div", "betterld-reply-tree__body");
      const head = createElement("div", "betterld-reply-tree__head");
      const author = createElement("span", "betterld-reply-tree__author");
      const nameMode = state.currentSettings.replyTreeNameMode;
      function appendName(className, text) {
        const name = createElement(avatarHref ? "a" : "span", className, text);
        name.title = text;
        if (avatarHref) {
          name.href = avatarHref;
          name.dataset.userCard = username;
          name.classList.add("trigger-user-card");
        }
        author.append(name);
      }
      if (nameMode !== "username" && nickname) appendName("betterld-reply-tree__nickname", nickname);
      if ((nameMode !== "nickname" || !nickname) && username && (nameMode !== "both" || nickname !== username)) {
        appendName("betterld-reply-tree__username", username);
      }
      if (!author.textContent) author.textContent = username || `#${post.post_number}`;
      const mark = userMarkChip(post.user_id);
      if (mark) author.append(mark);
      if (post.post_number > 1 && Number.isInteger(topicOwnerId) && post.user_id === topicOwnerId) {
        const mark = createElement("span", "betterld-reply-tree__author-mark", "OP");
        mark.title = "楼主（话题发起人）";
        mark.setAttribute("aria-label", mark.title);
        author.append(mark);
      }
      if (Number.isInteger(currentUserId) && post.user_id === currentUserId) {
        const mark = createElement("span", "betterld-reply-tree__author-mark betterld-reply-tree__author-mark--me", "ME");
        mark.title = "我（当前登录用户）";
        mark.setAttribute("aria-label", mark.title);
        author.append(mark);
      }
      if (isContext) {
        const mark = createElement("span", "betterld-reply-tree__author-mark betterld-reply-tree__author-mark--context", "上下文");
        mark.title = "此楼不在当前筛选结果中，只作回复上下文";
        mark.setAttribute("aria-label", mark.title);
        author.append(mark);
      }
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
        const parentNumber = Number(post.reply_to_post_number);
        const note = createElement("span", "betterld-reply-tree__date");
        note.append("回复 ");
        const context = createElement("a", "betterld-reply-tree__context", `#${parentNumber} · 查看上文`);
        context.href = topicReplyUrl(tree.topicId, parentNumber);
        context.title = "在树内读取父楼上文；Ctrl / Command 点击在新标签页打开原帖";
        context.dataset.betterldParentNumber = String(parentNumber);
        context.addEventListener("click", (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          tree.parentErrors.delete(parentNumber);
          tree.parentLoadPaused = false;
          tree.parentRetryNumber = parentNumber;
          if (tree.status.textContent.startsWith("父楼 #")) tree.status.textContent = "";
          renderReplyTree(tree);
          maybeLoadMoreReplyTree(tree);
        });
        const parentError = tree.parentErrors.get(parentNumber);
        note.append(context, tree.parentLoadingNumber === parentNumber ? "（正在读取上文…）"
          : parentError ? `（${parentError}，点击重试）` : "（父楼尚未载入，将按需读取）");
        head.append(note);
      }
      // 分页、回应与作者变化保留未变正文及其混排、播放器、引用/剧透状态。
      const previousBody = existing?.firstElementChild.querySelector(".betterld-reply-tree__body");
      let cooked = previousBody?.querySelector(":scope > .betterld-reply-tree__cooked");
      if (!cooked || previous.cooked !== post.cooked || previous.bodyState !== bodyState || previous.ignoredAuthor !== ignoredAuthor) {
        cooked = createElement("div", "betterld-reply-tree__cooked");
        // 被忽略的作者不解析原站正文，避免旧缓存正文泄露；隐藏/删除楼显示的是服务端自己的占位正文。
        if (!ignoredAuthor && !post.cooked_hidden && (typeof post.cooked === 'string' || bodyState === 'action')) {
          cooked.dataset.betterldCookedId = crypto.randomUUID();
          // 直接交给原生正文组件；不先展示随后会被清空的临时HTML。
        }
      }
      body.append(head);
      syncReplyReadIndicator(body, post.read);
      let contextToggle = null;
      if (isContext) {
        const expanded = tree.contextExpanded.has(post.post_number);
        cooked.hidden = !expanded || ignoredAuthor;
        contextToggle = createElement("button", "betterld-reply-tree__context-toggle", expanded ? "收起上下文正文" : "展开上下文正文");
        contextToggle.type = "button";
        contextToggle.setAttribute("aria-expanded", String(expanded));
        contextToggle.addEventListener("click", () => {
          if (tree.contextExpanded.has(post.post_number)) tree.contextExpanded.delete(post.post_number);
          else tree.contextExpanded.add(post.post_number);
          renderReplyTree(tree);
        });
        body.append(contextToggle);
      } else {
        cooked.hidden = ignoredAuthor;
      }
      // 隐藏、删除与忽略都是原站给出的合法状态：正文位显示状态与可恢复入口，不留旧缓存正文。
      const stateNotice = ignoredAuthor
        ? createElement("p", "betterld-reply-tree__state-notice", `已忽略 ${nickname || username}：按你的站点设置隐藏正文。`)
        : bodyState === "hidden"
          ? createElement("p", "betterld-reply-tree__state-notice", "此楼已被站点隐藏，正文需要站点权限才能读取。")
          : null;
      const stateAction = ignoredAuthor
        ? replyTreeActionButton('显示此条忽略回复', 'eye', () => revealReplyTreeIgnoredPost(tree, post, stateAction), 'betterld-reply-tree__state-action')
        : bodyState === "hidden" && post.can_see_hidden_post === true
          ? replyTreeActionButton("读取被隐藏的正文", "eye", () => revealReplyTreeHiddenBody(tree, post, stateAction), "betterld-reply-tree__state-action")
          : null;
      function solvedSlot(className) {
        const slot = previousBody?.querySelector(`.${className}`) || createElement("div", className);
        if (!slot.dataset.betterldMenuId) slot.dataset.betterldMenuId = crypto.randomUUID();
        return slot;
      }
      const solutionSummary = post.post_number === 1 && tree.context?.hasAcceptedAnswers && !ignoredAuthor && !post.cooked_hidden
        ? solvedSlot("betterld-reply-tree__solutions") : null;
      const actions = createElement("div", "betterld-reply-tree__actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", `#${post.post_number} 帖子操作`);
      if (!ignoredAuthor && !post.cooked_hidden && (post.accepted_answer === true || post.can_accept_answer === true)) {
        actions.append(solvedSlot("betterld-reply-tree__solution-action"));
      }
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
      // 点赞入口按原站模型投影显示：只有明确不可用时才隐藏或禁用，缺字段不误禁；
      // 未登录时点击会唤出登录，登录后的真实权限仍由桥在执行前核对。
      if (post.showLike !== false) {
        if (post.canToggleLike === false) {
          like.disabled = true;
          like.title = "当前不允许更改回应";
        }
        actions.append(like);
      }
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
      // 只有 can_boost 明确为真才给入口：未知状态不显示，也不由客户端猜测。
      if (post.can_boost === true && !post.boosts?.length) {
        actions.append(replyTreeActionButton("Boost 此帖", "rocket", () => openReplyTreeBoostEditor(tree, post)));
      }
      const more = replyTreeActionButton("更多帖子操作", "ellipsis", () => openReplyTreeMore(tree, post, more), "betterld-reply-tree__action--more");
      const nativeMenu = previousBody?.querySelector(":scope > .betterld-reply-tree__native-menu");
      if (ignoredAuthor || post.cooked_hidden) nativeMenu?.remove();
      more.setAttribute("aria-expanded", String(Boolean(nativeMenu?.isConnected && !nativeMenu.hidden)));
      if (nativeMenu?.isConnected) more.setAttribute("aria-controls", nativeMenu.id);
      actions.append(more);
      const reply = replyTreeActionButton(`回复 #${post.post_number}`, "reply", () => openReplyTreeComposer(tree, post), "betterld-reply-tree__action--reply");
      reply.append(createElement("span", "betterld-reply-tree__action-label", "回复"));
      // 回复入口按主题权限显示：不允许回复时明确禁用并说明，不假装可用。
      if (tree.context?.currentUserId && tree.context.canCreatePost === false) {
        reply.disabled = true;
        reply.title = "当前主题不允许回复";
        reply.setAttribute("aria-label", "当前主题不允许回复");
      }
      actions.append(reply);
      if (stateNotice) body.append(stateNotice);
      if (stateAction) body.append(stateAction);
      // 被忽略的作者不给帖子操作入口，回复归属仍留在树里。
      body.append(actions);
      actions.hidden = ignoredAuthor || post.post_type === 3;
      const boostsChanged = !previous || JSON.stringify(previous.boosts?.map(({ id, cooked, user }) => ({ id, cooked, user }))) !== JSON.stringify(post.boosts?.map(({ id, cooked, user }) => ({ id, cooked, user })))
        || previous.canBoost !== post.can_boost || previous.editing !== editing || previous.ignoredAuthor !== ignoredAuthor || previous.bodyState !== bodyState
        || previous.boostUserId !== tree.context?.currentUserId;
      const boosts = boostsChanged && !ignoredAuthor && !post.cooked_hidden && post.post_type !== 3 ? replyTreeBoostSection(tree, post) : null;
      if (existing) {
        existing.firstElementChild.firstElementChild.replaceWith(avatarWrap);
        previousBody.firstElementChild.replaceWith(head);
        // 正文与展开按钮按类名定位，不假设正文是第几个子节点；顺序保持 head / 展开按钮 / 正文 / 操作。
        if (cooked.parentElement !== previousBody) {
          previousBody.querySelector(":scope > .betterld-reply-tree__cooked").replaceWith(cooked);
        }
        const previousToggle = previousBody.querySelector(":scope > .betterld-reply-tree__context-toggle");
        if (contextToggle) {
          if (previousToggle) previousToggle.replaceWith(contextToggle);
          else previousBody.insertBefore(contextToggle, cooked);
        } else previousToggle?.remove();
        previousBody.querySelector(":scope > .betterld-reply-tree__state-notice")?.remove();
        previousBody.querySelector(":scope > .betterld-reply-tree__state-action")?.remove();
        if (stateNotice) previousBody.insertBefore(stateNotice, cooked);
        if (stateAction) previousBody.insertBefore(stateAction, cooked);
        const previousSummary = previousBody.querySelector(":scope > .betterld-reply-tree__solutions");
        if (solutionSummary) previousBody.insertBefore(solutionSummary, previousBody.querySelector(":scope > .betterld-reply-tree__actions"));
        else previousSummary?.remove();
        const previousActions = previousBody.querySelector(":scope > .betterld-reply-tree__actions");
        if (previousActions) previousActions.replaceWith(actions);
        else previousBody.append(actions);
        if (boostsChanged) {
          previousBody.querySelector(":scope > .betterld-reply-tree__boosts")?.remove();
          if (boosts) previousBody.append(boosts);
        }
      } else {
        body.insertBefore(cooked, stateNotice || actions);
        if (solutionSummary) body.insertBefore(solutionSummary, actions);
        if (boosts) body.append(boosts);
        card.append(avatarWrap, body);
        item.append(card);
      }
      return syncChildren(item, post);
    }
    function syncChildren(item, post) {
      for (const bubble of item.querySelectorAll(':scope > .betterld-reply-tree__card .discourse-boosts__bubble')) {
        const boost = post.boosts?.find((entry) => String(entry.id) === bubble.dataset.boostId);
        if (boost) syncReplyBoostControls(tree, bubble, post, boost);
      }
      const replies = children.get(post.post_number) || [];
      const hasReplies = replies.some((reply) => reply.post_type !== 3);
      item.toggleAttribute('data-betterld-reply-branches', hasReplies);
      // 当前窗口外仍有已缓存子楼时保留会话收放选择，实际叶子楼才清除旧状态。
      if (!replies.length && !cachedParents.has(post.post_number)) tree.branchStates.delete(post.post_number);

      if (replies.length) {
        let button = item.querySelector(":scope > .betterld-reply-tree__collapse");
        let branch = item.querySelector(":scope > .betterld-reply-tree__children");
        if (!hasReplies) button?.remove();
        if (hasReplies && !button) {
          button = createElement("button", "betterld-reply-tree__collapse");
          button.type = "button";
          item.append(button);
        }
        if (!branch) {
          branch = createElement("ol", "betterld-reply-tree__list betterld-reply-tree__children");
          item.append(branch);
        }
        if (item.dataset.branchHighlight && tree.highlightedBranch !== post.post_number) delete item.dataset.branchHighlight;
        const expanded = !hasReplies || replyBranchExpanded(tree, post.post_number);
        if (hasReplies) {
          button.dataset.replyBranchOwner = String(post.post_number);
          let symbol = button.querySelector('.betterld-reply-tree__collapse-symbol');
          if (!symbol) {
            symbol = createElement('span', 'betterld-reply-tree__collapse-symbol');
            symbol.setAttribute('aria-hidden', 'true');
            button.append(symbol);
          }
          symbol.textContent = expanded ? "−" : "+";
          button.setAttribute("aria-label", `${expanded ? "收起" : "展开"} #${post.post_number} 的 ${replies.filter((reply) => reply.post_type !== 3).length} 条回复`);
          button.setAttribute("aria-expanded", String(expanded));
        }
        branch.hidden = !expanded;
        const card = item.querySelector(':scope > .betterld-reply-tree__card');
        for (const type of ['stem', 'tail']) {
          let hit = card.querySelector(`:scope > .betterld-reply-tree__line-hit--${type}`);
          if (!hasReplies) {
            hit?.remove();
            continue;
          }
          if (!hit) {
            hit = createElement('span', `betterld-reply-tree__line-hit betterld-reply-tree__line-hit--${type}`);
            hit.setAttribute('aria-hidden', 'true');
            card.append(hit);
          }
          hit.dataset.replyBranchOwner = String(post.post_number);
        }
        syncReplyTreeChildren(branch, replies.map(renderPost));
        syncReplyTailControls(tree, branch, post.post_number);
        for (const child of branch.children) {
          if (child.hasAttribute('data-betterld-system-event')) {
            child.querySelectorAll(':scope > .betterld-reply-tree__line-hit').forEach((hit) => hit.remove());
            continue;
          }
          for (const type of ['trunk', 'arc']) {
            let hit = child.querySelector(`:scope > .betterld-reply-tree__line-hit--${type}`);
            if (!hit) {
              hit = createElement('span', `betterld-reply-tree__line-hit betterld-reply-tree__line-hit--${type}`);
              hit.setAttribute('aria-hidden', 'true');
              child.append(hit);
            }
            hit.dataset.replyBranchOwner = String(post.post_number);
          }
        }
      } else {
        delete item.dataset.branchHighlight;
        item.querySelector(':scope > .betterld-reply-tree__collapse')?.remove();
        item.style.removeProperty('--betterld-branch-toggle-y');
        item.querySelector(":scope > .betterld-reply-tree__children")?.remove();
        const card = item.querySelector(':scope > .betterld-reply-tree__card');
        tree.branchLayoutObserver.unobserve(card);
        tree.branchLayoutObserver.unobserve(card.querySelector('.betterld-reply-tree__actions'));
        card.querySelectorAll(':scope > .betterld-reply-tree__line-hit').forEach((hit) => hit.remove());
      }
      return item;
    }
    const rootPost = byNumber.get(1);
    syncReplyTreeChildren(list, rootPost ? [renderPost(rootPost)] : []);
    list.firstElementChild?.querySelectorAll(':scope > .betterld-reply-tree__line-hit, :scope > .betterld-reply-tree__tail-control').forEach((hit) => hit.remove());
    if (list.firstElementChild) {
      list.firstElementChild.hidden = false;
      list.firstElementChild.removeAttribute('data-reply-last-visible');
      list.firstElementChild.style.removeProperty('--betterld-reply-trunk-end');
      list.firstElementChild.style.removeProperty('--betterld-reply-tail-y');
    }
    // 重建观察范围，已替换或移出树的卡片即时释放。
    tree.branchLayoutObserver.disconnect();
    for (const card of tree.content.querySelectorAll('.betterld-reply-tree__card')) {
      tree.branchLayoutObserver.observe(card);
      tree.branchLayoutObserver.observe(card.querySelector('.betterld-reply-tree__actions'));
    }
    syncReplyReactionPopover(tree);
    if (focusedReactionTrigger && tree.reactionTrigger) tree.reactionTrigger.focus({ preventScroll: true });
    // 本人楼层索引只列已加载且已渲染的命中楼层，不预读全帖，也不把上下文楼算成本人楼层。
    const myPosts = currentUserId ? posts.filter((post) => !contextNumbers.has(post.post_number) && post.user_id === currentUserId) : [];
    tree.mine.replaceChildren(...myPosts.map((post) => {
      const item = createElement("button", "betterld-reply-tree__mine-item", `#${post.post_number}`);
      item.type = "button";
      item.title = `定位到 #${post.post_number}`;
      item.addEventListener("click", () => requestReplyTreeJump(tree, post.post_number, post.id, ""));
      return item;
    }));
    tree.mine.hidden = myPosts.length === 0;
    if (myPosts.length) tree.mine.prepend(createElement("span", "betterld-reply-tree__mine-label", `我的楼层（已加载 ${myPosts.length}）`));
    tree.renderedPosts = renderedPosts;
    if (tree.bridgeReady) {
      const unregistered = [...byNumber.values()].filter((post) => !tree.registeredPostIds.has(post.id));
      if (unregistered.length) {
        document.dispatchEvent(new CustomEvent("betterld:reply-register-posts", {
          detail: JSON.stringify({ topicId: tree.topicId, posts: unregistered })
        }));

      }
      const bodies = [...tree.content.querySelectorAll("[data-betterld-cooked-id]")]
        .filter((element) => !element.dataset.betterldCookedMounted)
        // 普通楼层按 postId 取已登记的原站模型，只有嵌入的 Boost 正文才带自己的模型数据。
        .map((element) => element.betterldCookedPost
          ? { id: element.dataset.betterldCookedId, post: element.betterldCookedPost }
          : { id: element.dataset.betterldCookedId, postId: byNumber.get(Number(element.closest("[data-post-number]").dataset.postNumber)).id });
      if (bodies.length) document.dispatchEvent(new CustomEvent("betterld:reply-cooked-mount", { detail: JSON.stringify({ topicId: tree.topicId, bodies }) }));
      const solvedSlots = [...tree.content.querySelectorAll(".betterld-reply-tree__solution-action, .betterld-reply-tree__solutions")]
        .filter((element) => !element.dataset.betterldMenuMounted)
        .map((element) => ({ id: element.dataset.betterldMenuId, summary: element.classList.contains("betterld-reply-tree__solutions"),
          postId: byNumber.get(Number(element.closest("[data-post-number]").dataset.postNumber)).id }));
      if (solvedSlots.length) document.dispatchEvent(new CustomEvent("betterld:reply-solved-mount", {
        detail: JSON.stringify({ topicId: tree.topicId, slots: solvedSlots })
      }));
      document.dispatchEvent(new CustomEvent("betterld:reply-author-details", { detail: JSON.stringify({ topicId: tree.topicId }) }));
    }
    // 窗口前面还有未加载楼层时提供真实入口，而不是从流首缺口补到目标。
    const reading = replyTreeWindow(tree);
    tree.previous.hidden = !reading || reading.empty || reading.lo === 0;
    tree.panel.hidden = false;
    syncReplyTreeFilterBar(tree);
    // 未变编辑器保留光标；仅编辑器实际被替换时恢复输入焦点。
    if (focusedBoostInput && !focusedBoostInput.isConnected && tree.boostEditor) focusReplyTreeBoostInput(tree);
    if (state.replyTreeNativeTopicId !== tree.topicId) {
      tree.streamElement.dataset.betterldReplySource = "true";
      tree.topicContainer.dataset.betterldReplyTreeActive = "true";
    }
    scheduleReplyPosition();
    updateReplyTreeMore(tree);
    // 深链楼层不在筛选流里时明确告知；流还没加载完就继续等，不提前下结论。
    const streamComplete = tree.stream.every((id) => tree.loaded.has(id));
    if (!tree.targetLocated && tree.targetPostNumber > 0 && !streamNumbers.has(tree.targetPostNumber)
      && (tree.userFilters.length > 0 || tree.topReplies) && streamComplete) {
      tree.notice.replaceChildren(
        createElement("span", "", `楼层 #${tree.targetPostNumber} 不在当前筛选结果中。`),
        (() => {
          const all = createElement("button", "betterld-reply-tree__notice-action", "查看全部回复");
          all.type = "button";
          all.addEventListener("click", () => returnAllReplyTreePosts(tree));
          return all;
        })()
      );
      tree.notice.hidden = false;
    } else {
      tree.notice.hidden = true;
    }
    // 原生正文/作者挂载完成后再量连线；结构变化使现有收放坐标失效。
    for (const item of tree.content.querySelectorAll('.betterld-reply-tree__item')) tree.branchDirty.add(item);
    positionReplyBranchControls(tree, false);
    // 包含前段入口、筛选栏、原帖隐藏和提示区的最终布局，只补偿一次。
    restoreReplyTreeAnchor(tree, anchor);
    // 无正文进展暂停后，仅真实新增可读正文解除；单纯滚动不反复补满额度。
    if (tree.prefetch.stalled && replyTreeReadableBodies(tree).some(({ id }) => !tree.prefetch.stalled.has(id))) {
      tree.prefetch.stalled = null;
    }
  }

  async function exportTopicSnapshot(topicId) {
    await loadPageRefreshBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (payload, error) => {
        clearTimeout(timer);
        document.removeEventListener("betterld:export-topic-result", onResult);
        if (error) reject(new Error(error)); else resolve(payload);
      };
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id === id) finish(result.payload, result.error);
      };
      const timer = setTimeout(() => finish(null, "原站导出数据读取超时"), config.topicExport.bridgeTimeoutMs);
      document.addEventListener("betterld:export-topic-result", onResult);
      document.dispatchEvent(new CustomEvent("betterld:export-topic-request", { detail: JSON.stringify({ id, topicId }) }));
    });
  }

  async function readExportTopic({ scope, postNumbers, onProgress, isActive, signal }) {
    const topicId = topicIdFromPath();
    const active = () => isActive() && !signal.aborted && topicIdFromPath() === topicId;
    const assertActive = () => {
      if (!active()) throw new DOMException("导出已取消或主题已切换", "AbortError");
    };
    assertActive();
    const snapshot = await exportTopicSnapshot(topicId);
    assertActive();
    const posts = new Map(snapshot.post_stream.posts.map((post) => [post.post_number, post]));
    const preloaded = preloadedReplyTopic(topicId);
    for (const post of preloaded?.post_stream?.posts || []) if (!posts.has(post.post_number)) posts.set(post.post_number, post);
    if (scope === "all") {
      // summary/user 筛选的流不是全帖流，显式读取无筛选的主题快照。
      const full = snapshot.filtered ? await requestTopicResponse(`/t/${topicId}.json`, active) : snapshot;
      assertActive();
      const ids = full.post_stream?.stream;
      if (!Array.isArray(ids) || !ids.length) throw new Error("原站完整楼层列表不可用");
      for (const post of full.post_stream.posts) posts.set(post.post_number, post);
      const loadedIds = new Set([...posts.values()].map((post) => String(post.id)));
      const missing = ids.filter((id) => !loadedIds.has(String(id)));
      onProgress(`已读取 ${ids.length - missing.length}/${ids.length} 个帖子`);
      for (let offset = 0; offset < missing.length; offset += config.replyTreePageSize) {
        const batch = missing.slice(offset, offset + config.replyTreePageSize);
        const params = new URLSearchParams();
        batch.forEach((id) => params.append("post_ids[]", id));
        const data = await requestTopicResponse(`/t/${topicId}/posts.json?${params}`, active);
        assertActive();
        if (!Array.isArray(data?.post_stream?.posts)) throw new Error("导出分页正文格式不正确");
        const received = new Set(data.post_stream.posts.map((post) => String(post.id)));
        if (batch.some((id) => !received.has(String(id)))) throw new Error("原站返回了不完整的导出分页，请重新导出");
        data.post_stream.posts.forEach((post) => posts.set(post.post_number, post));
        onProgress(`已读取 ${ids.length - missing.length + Math.min(offset + batch.length, missing.length)}/${ids.length} 个帖子`);
      }
      const wanted = new Set(ids.map(String));
      for (const [number, post] of posts) if (!wanted.has(String(post.id))) posts.delete(number);
      if (posts.size !== ids.length) throw new Error("完整帖子数量不一致，已停止导出");
    } else if (scope === "loaded") {
      // 已加载回复只导出页面里已有的楼层（原站流、预载与树当前已加载的楼），不补发任何请求。
      if (state.replyTree?.topicId === topicId) {
        for (const post of state.replyTree.posts.values()) if (!posts.has(post.post_number)) posts.set(post.post_number, post);
      }
      if (!posts.size) throw new Error("页面里还没有已加载的楼层，请先展开回复再导出");
    } else {
      if (!Array.isArray(postNumbers) || !postNumbers.length || postNumbers.some((number) => !Number.isSafeInteger(number) || number < 1)) {
        throw new Error("请选择有效的导出楼层");
      }
      const numbers = scope === "main" ? [1] : [...new Set(postNumbers)];
      for (const number of numbers) {
        assertActive();
        if (!posts.has(number)) {
          const post = await requestTopicResponse(`/posts/by_number/${topicId}/${number}.json`, active);
          assertActive();
          if (post?.post_number !== number || Number(post.topic_id) !== Number(topicId)) throw new Error(`#${number} 楼正文不属于当前主题`);
          posts.set(number, post);
        }
        onProgress(`正在整理 #${number} 楼`);
      }
      const wanted = new Set(numbers);
      for (const number of posts.keys()) if (!wanted.has(number)) posts.delete(number);
    }
    assertActive();
    const selected = [...posts.values()].sort((a, b) => a.post_number - b.post_number);
    if (selected.some((post) => typeof post.cooked !== "string" || !post.cooked.trim())) throw new Error("所选楼层正文为空或不可读取，已停止导出");
    return {
      topic: { title: snapshot.title, posts: selected },
      topicInfo: { id: topicId, origin: location.origin, originalUrl: new URL(`/t/topic/${topicId}`, location.origin).href },
      exportMode: state.replyTree?.topicId === topicId && state.replyTreeNativeTopicId !== topicId ? "nest" : "flat"
    };
  }

  function syncTopicExport() {
    const id = topicIdFromPath();
    const title = document.querySelector(`#topic-title h1[data-topic-id="${id}"] .fancy-title`)?.textContent;
    globalThis.BETTERLD_EXPORT.sync({ topicId: title ? id : "", title: cleanText(title), readTopic: readExportTopic });
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

  function mergeReplyUserBadges(tree, badges) {
    if (!badges) return false;
    const previous = JSON.stringify(tree.userBadges);
    tree.userBadges = {
      users: { ...tree.userBadges?.users, ...badges.users },
      badges: { ...tree.userBadges?.badges, ...badges.badges }
    };
    return previous !== JSON.stringify(tree.userBadges);
  }

  // 树内读取任务只登记在 tree.tasks，任务本体直接进唯一的全局请求队列：
  // 排队不占 busy，队列真正取数时才置 activeTask/busy，取数与投影在同一队列条目内完成，
  // 所以同一棵树不会在前一次投影结束前启动下一个任务，后来的跳楼也能抢在未启动的父楼/正文前。
  function scheduleReplyTreeTask(tree, task) {
    const existing = tree.tasks.find((pending) => pending.kind === task.kind && pending.key === task.key);
    if (existing) {
      // 可启动条件可能刚刚满足（父楼预算到点、重新可见），再叫一次全局队列。
      drainMetadataQueue();
      return existing;
    }
    const generation = task.generation;
    const entry = {
      kind: task.kind,
      key: task.key,
      priority: task.priority,
      cancelled: false,
      run: task.run,
      finish: task.finish,
      jump: task.jump,
      canStart: task.canStart || (() => true),
      readyAt: task.readyAt || (() => 0),
      isNeeded: () => !entry.cancelled && task.isNeeded()
    };
    // stillCurrent 用于错误处理（页面隐藏时也要保留失败状态），active 用于回写正文。
    entry.stillCurrent = () => !entry.cancelled && state.replyTree === tree
      && topicIdFromPath() === tree.topicId && tree.filterGeneration === generation;
    entry.active = () => entry.stillCurrent() && pageActive() && !tree.contentContainer.hidden
      && topicFilterStateKey(topicStreamFiltersFromUrl()) === tree.filterViewKey;
    tree.tasks.push(entry);
    // 正文与跳楼是当前阅读意图：尚未真正取数的父楼任务直接取消，不占住队列。
    if (entry.priority <= config.topicRequestPriority.body) {
      cancelReplyTreeTasks(tree, (pending) => pending.priority > config.topicRequestPriority.body);
    }
    scheduleMetadataRequest(async () => {
      try {
        // 排队期间原站可能已补到正文；先同步现有模型，再核对任务，避免按旧缓存重复出网。
        if (tree.bridgeReady && entry.active()) {
          document.dispatchEvent(new CustomEvent("betterld:reply-sync", { detail: JSON.stringify({ topicId: tree.topicId }) }));
        }
        syncReplyTreeData(tree);
        if (!entry.active() || !entry.isNeeded()) return;
        tree.activeTask = entry;
        tree.busy = true;
        syncReplyTreeStatusTimer(tree);
        await entry.run(entry);
      } catch (error) {
        // 取消不是错误；其他异常必须暴露，不能静默成“已处理”。
        if (error?.name === "AbortError") {
          console.warn("[betterLD] reply tree task aborted", error);
        } else if (entry.stillCurrent()) {
          handleReplyTreeTaskError(tree, error, "树状回复任务异常");
        } else {
          console.error("[betterLD] reply tree task failed", error);
        }
      } finally {
        settleReplyTreeTask(tree, entry);
      }
    }, () => entry.isNeeded(), () => entry.priority, () => entry.canStart(), () => entry.readyAt())
      .catch((error) => {
        if (error?.name !== "AbortError") {
          if (entry.stillCurrent()) handleReplyTreeTaskError(tree, error, "回复请求排队失败");
          else console.error("[betterLD] reply tree request rejected", error);
        }
        settleReplyTreeTask(tree, entry);
      });
    syncReplyTreeStatusTimer(tree);
    return entry;
  }

  function settleReplyTreeTask(tree, entry) {
    if (tree.activeTask === entry) {
      tree.activeTask = null;
      tree.busy = false;
    }
    tree.tasks = tree.tasks.filter((pending) => pending !== entry);
    if (entry.finish) entry.finish();
    syncReplyTreeStatusTimer(tree);
    if (state.replyTree === tree) {
      syncReplyTreeData(tree);
      scheduleReplyTreeWake(tree);
    }
  }

  function cancelReplyTreeTasks(tree, match = () => true) {
    for (const pending of tree.tasks) {
      if (!match(pending)) continue;
      pending.cancelled = true;
      // 尚未开始的跳楼被取消时也要回执，主世界不能等到超时。
      if (pending.finish) pending.finish();
    }
    tree.tasks = tree.tasks.filter((pending) => !pending.cancelled);
    drainMetadataQueue();
  }

  function scheduleReplyTreeWake(tree) {
    window.setTimeout(() => {
      if (state.replyTree === tree) maybeLoadMoreReplyTree(tree);
    }, 0);
  }

  // 任务有效的唯一判据：同一棵树、同一主题、同一筛选世代、可见且页面活跃。
  // 筛选可能回到原值（全部→摘要→全部），所以用单调递增的世代而不是比较键。
  function replyTreeTaskActive(tree, generation) {
    return pageActive() && state.replyTree === tree && !tree.contentContainer.hidden
      && topicIdFromPath() === tree.topicId && tree.filterGeneration === generation
      && topicFilterStateKey(topicStreamFiltersFromUrl()) === tree.filterViewKey;
  }

  // 等待可见性：冷却与队列等待只读本地状态，不产生任何轮询请求。
  function syncReplyTreeStatusTimer(tree) {
    const needed = Boolean(tree.activeTask || tree.wait.until
      || (tree.tasks.length && metadataQueueWaitUntil() > Date.now()));
    if (needed && !tree.statusTimer) {
      tree.statusTimer = window.setInterval(() => tickReplyTreeStatus(tree), config.replyTreeStatusTickMs);
    } else if (!needed && tree.statusTimer) {
      stopReplyTreeStatusTimer(tree);
    }
  }

  function stopReplyTreeStatusTimer(tree) {
    clearInterval(tree.statusTimer);
    tree.statusTimer = 0;
  }

  function tickReplyTreeStatus(tree) {
    if (state.replyTree !== tree) {
      stopReplyTreeStatusTimer(tree);
      return;
    }
    const now = Date.now();
    const waitingJump = tree.wait.pendingJump || tree.tasks.find((task) => task.kind === "jump")?.jump;
    const until = Math.max(tree.wait.until, metadataQueueWaitUntil(now));
    if (waitingJump?.requestId && until > now) {
      document.dispatchEvent(new CustomEvent("betterld:reply-jump-wait", {
        detail: JSON.stringify({ topicId: tree.topicId, requestId: waitingJump.requestId, until,
          message: `等待站点请求预算，剩 ${Math.ceil((until - now) / 1000)} 秒` })
      }));
    }
    if (tree.wait.until && now >= tree.wait.until) {
      // 冷却到点后按当前阅读需要续载一次；再次失败转为手动重试。
      tree.wait.until = 0;
      if (tree.status.textContent.startsWith("站点限流冷却中")) tree.status.textContent = "";
      if (tree.autoLoadPaused) {
        // 手动重试阶段：保留待恢复的跳楼意图，等用户点“重试加载回复”。
      } else {
        maybeLoadMoreReplyTree(tree);
      }
    } else if (tree.wait.until) {
      tree.status.textContent = `站点限流冷却中（剩 ${Math.ceil((tree.wait.until - now) / 1000)} 秒），到点自动继续。`;
    } else if (!tree.busy && tree.tasks.length) {
      const wait = metadataQueueWaitUntil(now) - now;
      if (wait > 0) tree.status.textContent = `等待站点请求队列（剩 ${Math.ceil(wait / 1000)} 秒）`;
      else if (tree.status.textContent.startsWith("等待站点请求队列")) tree.status.textContent = "";
    }
    if (!tree.activeTask && !tree.wait.until
      && (!tree.tasks.length || metadataQueueWaitUntil(now) <= now)) stopReplyTreeStatusTimer(tree);
  }

  function clearReplyTreeWait(tree) {
    tree.wait.until = 0;
    tree.wait.retryUsed = false;
    syncReplyTreeStatusTimer(tree);
  }

  // 首次限流只记录到点自动续载一次；再次限流（或普通网络失败）保留给用户手动重试。
  function noteReplyTreeRateLimit(tree, error) {
    const until = Math.max(Number(error?.cooldownUntil) || 0, state.metadataCooldownUntil, Date.now() + 1000);
    if (tree.wait.retryUsed) {
      tree.autoLoadPaused = true;
      tree.more.hidden = false;
      tree.more.textContent = "重试加载回复";
      tree.status.textContent = `站点限流冷却到 ${new Date(until).toLocaleTimeString()}；点击“重试加载回复”继续。`;
      return;
    }
    tree.wait.retryUsed = true;
    tree.wait.until = until;
    tree.status.textContent = `站点限流冷却中（剩 ${Math.ceil((until - Date.now()) / 1000)} 秒），到点自动继续。`;
    syncReplyTreeStatusTimer(tree);
  }

  function handleReplyTreeTaskError(tree, error, label) {
    if (error?.name === "AbortError" || state.replyTree !== tree) return;
    if (error?.rateLimited) {
      noteReplyTreeRateLimit(tree, error);
      return;
    }
    console.error("[betterLD] reply tree load failed", error);
    tree.panel.hidden = false;
    tree.autoLoadPaused = true;
    tree.status.textContent = `${label}：${error.message}。${tree.posts.size ? "可通过楼层链接进入原站回复。" : "原站回复保持可用。"}`;
    tree.more.hidden = false;
    tree.more.textContent = "重试加载回复";
  }

  function replyTreePostIgnored(tree, post) {
    return Boolean(post.username && tree.context?.ignoredUsernames?.includes(post.username)
      && !tree.context?.revealedIgnoredIds?.includes(String(post.id)));
  }

  async function revealReplyTreeIgnoredPost(tree, post, button) {
    button.disabled = true;
    try {
      let updated;
      if (typeof post.cooked !== 'string' || !post.cooked.trim()) {
        const data = await requestTopicResponse(`/t/${tree.topicId}/posts.json?post_ids[]=${post.id}`, () => state.replyTree === tree && topicIdFromPath() === tree.topicId);
        updated = data?.post_stream?.posts?.find((entry) => entry.id === post.id);
        if (!updated || updated.post_number !== post.post_number || !replyTreeBodyState(updated)) throw new Error('站点未返回该忽略回复');
      }
      const result = await requestReplyTreeAction(tree, post, 'ignore-reveal', { updated });
      if (state.replyTree !== tree) return;
      mergeReplyTreePost(tree, result.post);
    } catch (error) {
      if (state.replyTree === tree) tree.status.textContent = `显示忽略回复失败：${error.message}`;
      button.disabled = false;
    }
  }

  // 正文状态：系统事件、隐藏、删除与忽略作者都是原站给出的合法状态，不是“正文缺失”。
  // 合并、父楼补读、分页与实时同步共用这一处判定，普通空正文仍然算缺口。
  function replyTreeBodyState(post) {
    if (post.cooked_hidden) return "hidden";
    if (post.deleted_post_placeholder || post.deleted_at || post.user_deleted) return "deleted";
    // 系统事件以 action_code 表达内容（如置顶），cooked 可以合法为空。
    if (post.post_type === 3) return "action";
    if (typeof post.cooked === "string" && post.cooked.trim()) return "ready";
    return "";
  }

  // 树内正文的唯一写入点：只接受属于本主题且带真实正文的帖子。
  // overwrite=false 用于 HTTP 补读：已有正文的楼层不覆盖，原站模型同步才是权威更新。
  function mergeReplyTreePost(tree, post, { overwrite = true } = {}) {
    if (!Number.isInteger(post?.id) || !Number.isInteger(post?.post_number)) return false;
    if (post.topic_id !== undefined && String(post.topic_id) !== tree.topicId) return false;
    const bodyState = replyTreeBodyState(post);
    if (!bodyState && !replyTreePostIgnored(tree, post)) return false;
    const previous = tree.posts.get(post.id);
    // 真实状态优先：楼层在服务端变成隐藏/删除时，即使 overwrite=false 也要替掉缓存正文。
    const cached = replyTreeBodyState(previous || {}) && (bodyState === 'ready' || bodyState === 'action' || !bodyState);
    if (cached && !overwrite) {
      tree.loaded.add(post.id);
      return false;
    }
    tree.posts.set(post.id, post);
    tree.loaded.add(post.id);
    if (!tree.stream.includes(post.id)) tree.orphanContextIds.add(post.id);
    return true;
  }

  function mergeReplyTreePosts(tree, posts, options) {
    let changed = false;
    for (const post of posts || []) {
      if (mergeReplyTreePost(tree, post, options)) changed = true;
    }
    return changed;
  }

  // 所有权威换流共用身份更新，缓存可保留，但不能继续赋予旧成员阅读位置。
  function setReplyTreeStream(tree, stream) {
    const previous = tree.stream;
    const ids = new Set(stream);
    if (tree.anchorId && !ids.has(tree.anchorId)) {
      const index = previous.indexOf(tree.anchorId);
      let adjacent;
      // 删除当前锚点时沿旧流找最近仍存在的邻帖，避免退回帖首缓存段。
      for (let distance = 1; index >= 0 && distance < previous.length && adjacent === undefined; distance += 1) {
        const offsets = tree.bodyLoadDirection === 'backward' ? [-distance, distance] : [distance, -distance];
        adjacent = offsets.map((offset) => previous[index + offset]).find((id) => ids.has(id));
      }
      tree.anchorId = adjacent ?? "";
    }
    if (tree.positionedPost && !ids.has(tree.positionedPost.postId)) tree.positionedPost = null;
    tree.stream = stream;
    tree.streamReady = true;
  }

  // 阅读窗口围绕当前锚点，stream 索引是连续范围的唯一权威顺序。
  function replyTreeWindow(tree) {
    const stream = tree.stream;
    if (!stream.length) return null;
    let anchor = tree.anchorId ? stream.indexOf(tree.anchorId) : -1;
    if (anchor < 0) anchor = stream.findIndex((id) => tree.loaded.has(id));
    if (anchor < 0) return { lo: 0, hi: -1, anchor: 0, empty: true };
    if (!tree.loaded.has(stream[anchor])) return { lo: anchor, hi: anchor, anchor, empty: true };
    let lo = anchor;
    let hi = anchor;
    while (lo > 0 && tree.loaded.has(stream[lo - 1])) lo -= 1;
    while (hi < stream.length - 1 && tree.loaded.has(stream[hi + 1])) hi += 1;
    return { lo, hi, anchor, empty: false };
  }

  // 正文批次只围绕窗口双向取相邻一批，不从流首缺口补到目标。
  function replyTreeBodyBatch(tree, direction) {
    const reading = replyTreeWindow(tree);
    if (!reading) return null;
    const stream = tree.stream;
    const unloaded = (ids) => ids.filter((id) => !tree.loaded.has(id));
    if (reading.empty) {
      const ids = unloaded(stream.slice(reading.anchor, reading.anchor + config.replyTreePageSize));
      return ids.length ? { key: `body:at:${reading.anchor}`, ids, direction } : null;
    }
    if (direction === "backward") {
      if (!reading.lo) return null;
      const ids = unloaded(stream.slice(Math.max(0, reading.lo - config.replyTreePageSize), reading.lo));
      return ids.length ? { key: `body:back:${reading.lo}`, ids, direction } : null;
    }
    const ids = unloaded(stream.slice(reading.hi + 1, reading.hi + 1 + config.replyTreePageSize));
    return ids.length ? { key: `body:next:${reading.hi}`, ids, direction } : null;
  }

  function scheduleReplyTreeTopic(tree) {
    const generation = tree.filterGeneration;
    return scheduleReplyTreeTask(tree, {
      kind: "topic",
      key: "topic",
      generation,
      priority: config.topicRequestPriority.body,
      isNeeded: () => replyTreeTaskActive(tree, generation)
        && (!tree.streamReady || (tree.stream.length > 0 && ![...tree.posts.values()].some((post) => post.post_number === 1))),
      run: (entry) => loadReplyTreeTopic(tree, entry)
    });
  }

  async function loadReplyTreeTopic(tree, entry) {
    if (!tree.posts.size) tree.status.textContent = "正在读取回复…";
    try {
      const preloaded = preloadedReplyTopic(tree.topicId);
      const startsAtFirstPost = state.preloadedReplyFilterKey === tree.filterViewKey
        && preloaded?.post_stream?.posts?.some((post) => post.post_number === 1);
      let data = preloaded;
      let nearbyPosts = [];
      if (!startsAtFirstPost) {
        // 深链或 SPA 切换时预载可能不含主帖；补读带上当前摘要与作者筛选，不用完整流覆盖筛选结果。
        data = await shareTopicFetch(replyTreeTopicUrl(tree));
        if (!entry.active()) return;
        if (state.preloadedReplyFilterKey === tree.filterViewKey && Array.isArray(preloaded?.post_stream?.posts)) nearbyPosts = preloaded.post_stream.posts;
      }
      const stream = data?.post_stream?.stream;
      if (!Array.isArray(stream) || !Array.isArray(data?.post_stream?.posts)
        || (stream.length > 0 && !data.post_stream.posts.some((post) => post.post_number === 1))) {
        throw new Error("主题回复数据格式不正确");
      }
      setReplyTreeStream(tree, stream);
      if (data.details?.created_by?.username) tree.ownerUsername = data.details.created_by.username;
      if (data.title) tree.title = cleanText(data.title);
      mergeReplyUserBadges(tree, data.user_badges);
      mergeReplyTreePosts(tree, data.post_stream.posts, { overwrite: false });
      mergeReplyTreePosts(tree, nearbyPosts, { overwrite: false });
      clearReplyTreeWait(tree);
      tree.autoLoadPaused = false;
      tree.status.textContent = "";
      renderReplyTree(tree);
    } catch (error) {
      if (!entry.stillCurrent()) return;
      handleReplyTreeTaskError(tree, error, "树状回复读取失败");
    }
  }

  function replyTreeTopicUrl(tree) {
    const params = new URLSearchParams();
    if (tree.topReplies) params.set("filter", "summary");
    if (tree.userFilters.length) params.set("username_filters", tree.userFilters.join(","));
    return `/t/${tree.topicId}.json${params.size ? `?${params}` : ""}`;
  }

  function replyTreeMissingIds(tree, batch) {
    const streamIds = new Set(tree.stream);
    return batch.ids.filter((id) => streamIds.has(id) && !tree.loaded.has(id));
  }

  function clearReplyTreeBodyRetry(tree) {
    tree.retryBatch = null;
    clearReplyTreeWait(tree);
    tree.autoLoadPaused = false;
    tree.status.textContent = "";
  }

  function resetReplyTreePrefetch(tree) {
    tree.prefetch = {
      speed: 0, sampledAt: 0, until: 0, remaining: 0, stalled: null,
      loadMs: tree.prefetch ? tree.prefetch.loadMs : config.replyTreePrefetch.initialLoadMs
    };
  }

  function noteReplyTreeScroll(tree, top) {
    const now = performance.now();
    const direction = top < tree.bodyLoadScrollTop ? 'backward' : 'forward';
    if (direction !== tree.bodyLoadDirection) resetReplyTreePrefetch(tree);
    const prefetch = tree.prefetch;
    const elapsed = now - prefetch.sampledAt;
    const options = config.replyTreePrefetch;
    if (prefetch.sampledAt && elapsed > 0 && elapsed <= options.scrollIdleMs) {
      const sample = Math.abs(top - tree.bodyLoadScrollTop) / elapsed;
      prefetch.speed += options.speedSampleWeight * (sample - prefetch.speed);
    } else {
      prefetch.speed = 0;
    }
    prefetch.sampledAt = now;
    prefetch.until = now + options.scrollIdleMs;
    if (!prefetch.stalled) prefetch.remaining = options.maxBatchesPerScroll;
    tree.bodyLoadDirection = direction;
    tree.bodyLoadScrollTop = top;
    tree.bodyLoadBlocked = false;
  }

  function replyTreePrefetchActive(tree) {
    return tree.prefetch.remaining > 0 && performance.now() < tree.prefetch.until;
  }

  function replyTreeLoadAhead(tree) {
    const options = config.replyTreePrefetch;
    const viewport = innerHeight;
    const speed = replyTreePrefetchActive(tree) ? tree.prefetch.speed : 0;
    const predicted = speed * (tree.prefetch.loadMs + options.latencyMarginMs) + config.replyTreeLoadAheadPx;
    return Math.min(viewport * options.maxScreens, Math.max(viewport * options.minScreens, predicted));
  }

  function replyTreeReadableBodies(tree) {
    const reading = replyTreeWindow(tree);
    if (!reading || reading.empty) return [];
    const ids = new Set(tree.stream.slice(reading.lo, reading.hi + 1));
    return [...tree.content.querySelectorAll('.betterld-reply-tree__card')].flatMap((card) => {
      const id = Number(card.dataset.postId);
      const post = tree.posts.get(id);
      const body = card.querySelector(':scope > .betterld-reply-tree__body > .betterld-reply-tree__cooked');
      if (!ids.has(id) || !post || post.post_type === 3 || replyTreeBodyState(post) !== 'ready'
        || replyTreePostIgnored(tree, post) || body?.dataset.betterldCookedMounted !== 'true' || !body.getClientRects().length) return [];
      return [{ id, bounds: body.getBoundingClientRect() }];
    });
  }

  function replyTreeBufferNeeded(tree, direction) {
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    const available = replyTreeReadableBodies(tree).reduce((sum, { bounds }) => {
      const length = direction === 'backward'
        ? Math.min(bounds.bottom, headerHeight) - bounds.top
        : bounds.bottom - Math.max(bounds.top, innerHeight);
      return sum + Math.max(0, length);
    }, 0);
    return available < replyTreeLoadAhead(tree);
  }

  function scheduleReplyTreeBody(tree, direction, source = tree.retryBatch || replyTreeBodyBatch(tree, direction)) {
    if (!source) return null;
    const batch = { ...source, ids: replyTreeMissingIds(tree, source) };
    if (!batch.ids.length) {
      clearReplyTreeBodyRetry(tree);
      updateReplyTreeMore(tree);
      scheduleReplyTreeWake(tree);
      return null;
    }
    const generation = tree.filterGeneration;
    const queuedAt = performance.now();
    const continuation = tree.bodyLoadBlocked;
    return scheduleReplyTreeTask(tree, {
      kind: "body",
      key: batch.key,
      generation,
      priority: batch.neighborhood ? config.topicRequestPriority.jump : config.topicRequestPriority.body,
      isNeeded: () => replyTreeTaskActive(tree, generation) && replyTreeMissingIds(tree, batch).length > 0
        && (batch.neighborhood || Boolean(tree.retryBatch) || (!tree.prefetch.stalled && direction === tree.bodyLoadDirection
          && (!continuation || (replyTreePrefetchActive(tree) && replyTreeBufferNeeded(tree, direction))))),
      canStart: () => !tree.tasks.some((pending) => pending.kind === "jump" && !pending.cancelled),
      run: (entry) => loadReplyTreeBody(tree, entry, batch, queuedAt)
    });
  }

  async function loadReplyTreeBody(tree, entry, batch, queuedAt) {
    if (!tree.posts.size) tree.status.textContent = "正在读取回复…";
    const prefetch = tree.prefetch;
    const before = new Set(replyTreeReadableBodies(tree).map(({ id }) => id));
    if (!batch.neighborhood && prefetch.remaining > 0) prefetch.remaining -= 1;
    try {
      const params = new URLSearchParams();
      replyTreeMissingIds(tree, batch).forEach((id) => params.append("post_ids[]", id));
      const data = await shareTopicFetch(batch.reconcile ? replyTreeTopicUrl(tree) : `/t/${tree.topicId}/posts.json?${params}`);
      if (!entry.active()) return;
      const posts = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : null;
      if (!posts) throw new Error("回复分页数据格式不正确");
      if (batch.reconcile) {
        const stream = data.post_stream.stream;
        if (String(data.id) !== tree.topicId || !Array.isArray(stream) || stream.some((id) => !Number.isInteger(id))) {
          throw new Error("核对回复失败：原站未返回有效楼层列表");
        }
        setReplyTreeStream(tree, stream);
      }
      mergeReplyUserBadges(tree, data.user_badges);
      // 只登记真实带正文的返回；漏返回或没正文的楼层用 loaded 判定为缺口，不假装成功。
      mergeReplyTreePosts(tree, posts, { overwrite: false });
      const missing = replyTreeMissingIds(tree, batch);
      // 完成后仅在当前方向、阅读意图仍有效且正文缓冲不足时继续有限补批。
      if (!batch.neighborhood) tree.bodyLoadBlocked = batch.direction === tree.bodyLoadDirection;
      tree.bodyLoadScrollTop = pageScrollTop();
      renderReplyTree(tree);
      if (!batch.neighborhood && tree.prefetch === prefetch) {
        prefetch.loadMs = performance.now() - queuedAt;
        const readable = replyTreeReadableBodies(tree);
        if (!readable.some(({ id }) => !before.has(id))) {
          prefetch.remaining = 0;
          prefetch.stalled = new Set(readable.map(({ id }) => id));
        }
      }
      if (missing.length) {
        // 分页可能遇到已删/移走的旧ID；另排一次主题核对，不在同一队列条目内连发请求。
        const exhausted = Boolean(batch.verified);
        tree.retryBatch = {
          ...batch, ids: missing, reconcile: !batch.reconcile && !exhausted, verified: Boolean(batch.reconcile) || exhausted
        };
        tree.autoLoadPaused = exhausted;
        tree.more.hidden = false;
        tree.more.textContent = exhausted ? "重试加载回复" : "加载更多回复";
        tree.status.textContent = exhausted
          ? `核对并重读后，帖子 ID ${missing.join("、")} 仍未返回正文；点击“重试加载回复”定点重读。`
          : batch.reconcile ? `帖子 ID ${missing.join("、")} 仍在楼层列表中，正在定点重读正文…`
            : `帖子 ID ${missing.join("、")} 未返回正文，正在核对楼层列表…`;
        if (exhausted && tree.wait.pendingJump?.state === 'neighborhood') {
          const record = tree.wait.pendingJump;
          ackReplyTreeJump(tree, record, `楼层跳转未完成：${tree.status.textContent}`);
          tree.wait.pendingJump = record;
        }
        return;
      }
      clearReplyTreeBodyRetry(tree);
    } catch (error) {
      if (!entry.stillCurrent()) return;
      tree.retryBatch = batch;
      handleReplyTreeTaskError(tree, error, "回复续载失败");
      if (tree.autoLoadPaused && tree.wait.pendingJump?.state === 'neighborhood') {
        const record = tree.wait.pendingJump;
        ackReplyTreeJump(tree, record, `楼层跳转未完成：${error.message}`);
        tree.wait.pendingJump = record;
      }
    }
  }

  function visibleReplyParentGap(tree) {
    const { byNumber } = replyTreePostGraph(tree);
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    for (const card of tree.content.querySelectorAll('.betterld-reply-tree__card')) {
      if (!card.getClientRects().length) continue;
      const bounds = card.getBoundingClientRect();
      if (bounds.bottom <= headerHeight || bounds.top >= innerHeight) continue;
      let child = byNumber.get(Number(card.parentElement.dataset.postNumber));
      while (child && !replyTreePostIgnored(tree, child)) {
        const number = Number(child.reply_to_post_number);
        if (!(number > 1 && number < child.post_number)) break;
        const parent = byNumber.get(number);
        if (!parent) {
          if (!tree.parentErrors.has(number) && (!tree.parentRetryNumber || tree.parentRetryNumber === number)) return { child, number };
          break;
        }
        child = parent;
      }
    }
    return null;
  }

  function cacheReplyParentPage(tree, posts, parentNumber) {
    const returned = new Map(posts.map((post) => [post.post_number, post]));
    const accepted = new Set(posts.filter((post) => tree.stream.includes(post.id)));
    let parent = returned.get(parentNumber);
    while (parent) {
      accepted.add(parent);
      const number = Number(parent.reply_to_post_number);
      if (!(number >= 1 && number < parent.post_number)) break;
      parent = returned.get(number);
    }
    for (const post of accepted) {
      // 模型同步可能已给出更近的编辑/回应，补上下文不覆盖已缓存的正文楼层。
      mergeReplyTreePost(tree, post, { overwrite: false });
      tree.parentErrors.delete(post.post_number);
    }
  }

  function scheduleReplyTreeParent(tree, gap) {
    const generation = tree.filterGeneration;
    const key = `parent:${gap.number}`;
    // 只保留一个父楼意图：换了另一对父子就直接取消旧的，不留多个待办。
    cancelReplyTreeTasks(tree, (pending) => pending.kind === "parent" && pending.key !== key);
    return scheduleReplyTreeTask(tree, {
      kind: "parent",
      key,
      generation,
      priority: config.topicRequestPriority.parent,
      // 可见性属于有效性：离开视口就是意图失效，当场取消，不永久滞留。
      isNeeded: () => {
        if (!replyTreeTaskActive(tree, generation) || tree.parentLoadPaused) return false;
        const current = visibleReplyParentGap(tree);
        return current?.number === gap.number && current.child.id === gap.child.id;
      },
      // 父楼预算只是可启动条件：还没到 5s 就等，不代表可见意图失效。
      readyAt: () => state.replyParentNextAt,
      canStart: () => !tree.tasks.some((pending) => pending.priority < config.topicRequestPriority.parent && !pending.cancelled),
      run: (entry) => loadReplyParent(tree, entry, gap)
    });
  }

  async function loadReplyParent(tree, entry, gap) {
    try {
      tree.parentLoadingNumber = gap.number;
      renderReplyTree(tree);
      const data = await shareTopicFetch(`/t/${tree.topicId}/${gap.number}.json`, (at) => {
        state.replyParentNextAt = Math.max(state.replyParentNextAt, at + config.replyTreeParentLoadIntervalMs);
      });
      if (!entry.active()) return;
      if (Number(tree.posts.get(gap.child.id)?.reply_to_post_number) !== gap.number) return;
      if (String(data?.id) !== tree.topicId || !Array.isArray(data?.post_stream?.posts)) throw new Error("父楼数据格式不正确");
      const posts = data.post_stream.posts;
      if (posts.some((post) => !Number.isInteger(post.id) || !Number.isInteger(post.post_number)
        || (post.topic_id !== undefined && String(post.topic_id) !== tree.topicId))) throw new Error("父楼数据不属于当前主题");
      const parent = posts.find((post) => post.post_number === gap.number);
      // 隐藏/删除的父楼也是合法状态：照样合并，由卡片显示状态与可恢复入口。
      if (!parent || (!replyTreeBodyState(parent) && !replyTreePostIgnored(tree, parent))) throw new Error(`父楼 #${gap.number} 不存在或不可读取`);
      mergeReplyUserBadges(tree, data.user_badges);
      cacheReplyParentPage(tree, posts.filter((post) => Boolean(replyTreeBodyState(post)) || replyTreePostIgnored(tree, post)), gap.number);
      tree.parentRetryNumber = 0;
      clearReplyTreeWait(tree);
      tree.status.textContent = "";
    } catch (error) {
      if (error?.name === "AbortError" || !entry.stillCurrent()) return;
      if (error?.rateLimited) {
        tree.parentLoadPaused = true;
        tree.parentErrors.set(gap.number, error.message);
        tree.status.textContent = `上文读取受站点限制，冷却到 ${new Date(error.cooldownUntil).toLocaleTimeString()}；已载正文保持可读，上文可点击重试。`;
        return;
      }
      console.error("[betterLD] reply parent load failed", error);
      // 父楼失败只暂停父楼补载，正文续载继续。
      tree.parentErrors.set(gap.number, error.message);
      tree.parentLoadPaused = true;
      tree.status.textContent = `父楼 #${gap.number} 读取失败：${error.message}。点击“查看上文”重试，或通过楼层链接打开原帖。`;
    } finally {
      tree.parentLoadingNumber = 0;
      if (state.replyTree === tree) {
        renderReplyTree(tree);
        syncReplyTreeData(tree);
      }
    }
  }

  function updateReplyTreeMore(tree) {
    const remaining = Boolean(replyTreeBodyBatch(tree, 'forward'));
    tree.more.hidden = !tree.autoLoadPaused && !remaining;
    tree.more.textContent = tree.autoLoadPaused ? '重试加载回复' : '加载更多回复';
  }

  function maybeLoadMoreReplyTree(tree) {
    if (!pageActive() || state.replyTree !== tree || tree.busy || tree.compensating || tree.autoLoadPaused
      || tree.contentContainer.hidden || tree.filterBusy
      || topicFilterStateKey(topicStreamFiltersFromUrl()) !== tree.filterViewKey) return;
    if (tree.wait.until) return;
    if (!tree.streamReady || (tree.stream.length > 0 && ![...tree.posts.values()].some((post) => post.post_number === 1))) {
      scheduleReplyTreeTopic(tree);
      return;
    }
    if (!tree.stream.length) {
      const pending = tree.wait.pendingJump;
      if (pending) ackReplyTreeJump(tree, pending, '当前阅读范围没有可跳转的回复');
      for (const task of tree.tasks) {
        if (task.kind === 'jump') ackReplyTreeJump(tree, task.jump, '当前阅读范围没有可跳转的回复');
      }
      cancelReplyTreeTasks(tree, (task) => task.kind === 'jump' || task.kind === 'body');
      tree.retryBatch = null;
      if (tree.renderPending) renderReplyTree(tree);
      return;
    }
    if (tree.wait.pendingJump) {
      const record = tree.wait.pendingJump;
      if (record.state === 'neighborhood') {
        if (tree.retryBatch) scheduleReplyTreeBody(tree, tree.retryBatch.direction);
        else {
          const post = replyTreePostByTarget(tree, record.postNumber, record.postId);
          applyReplyTreeJump(tree, record, post, post ? '' : '目标楼层已不可访问');
        }
      } else scheduleReplyTreeJump(tree, record);
      return;
    }
    // 模型/主帖刚到齐时唤醒已登记的跳楼，不让正文或父楼抢先改变读段。
    if (tree.tasks.some((task) => task.kind === 'jump')) {
      drainMetadataQueue();
      return;
    }
    // 正文优先：沿用户滚动方向补当前窗口相邻一批，不跨回其他缓存读段。
    const reading = replyTreeWindow(tree);
    const direction = tree.bodyLoadDirection;
    const batch = tree.retryBatch || replyTreeBodyBatch(tree, direction);
    const needsBody = batch && !tree.prefetch.stalled && (!tree.bodyLoadBlocked
      ? replyTreeBoundaryReached(tree, direction)
      : replyTreePrefetchActive(tree) && replyTreeBufferNeeded(tree, direction));
    if (batch && (tree.retryBatch || reading.empty || needsBody)) {
      scheduleReplyTreeBody(tree, direction);
      return;
    }
    // 空闲时才补可见回复的父楼上文；图索引扫描按父楼预算节流，滚动不反复全量构建。
    if (tree.parentLoadPaused) return;
    if (!tree.parentRetryNumber && Date.now() - tree.parentScanAt < config.replyTreeParentLoadIntervalMs) return;
    tree.parentScanAt = Date.now();
    const gap = topicFilterStateKey(tree) === topicFilterStateKey(topicStreamFiltersFromUrl()) ? visibleReplyParentGap(tree) : null;
    if (!gap) tree.parentRetryNumber = 0;
    if (gap && Date.now() >= state.replyParentNextAt) scheduleReplyTreeParent(tree, gap);
  }

  function replyTreeBoundaryReached(tree, direction) {
    const reading = replyTreeWindow(tree);
    if (!reading || reading.empty) return false;
    const ids = new Set(tree.stream.slice(reading.lo, reading.hi + 1));
    const cards = [...tree.content.querySelectorAll('.betterld-reply-tree__card')]
      .filter((card) => ids.has(Number(card.dataset.postId)) && card.getClientRects().length);
    // 树按父子关系排列，stream边界楼可能折叠；用读段实际可见的首尾正文判断边界。
    const card = direction === 'backward' ? cards[0] : cards.at(-1);
    // 缓冲以当前读段展开的正文累计长度衡量，祖先外壳与折叠后代不充数。
    if (replyTreeBufferNeeded(tree, direction)) return true;
    if (card) {
      const boundary = card.getBoundingClientRect();
      if (direction === 'backward') {
        const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
        // 上翻到还剩约五条可见回复时预载，避免长正文使像素阈值触发过晚。
        const ahead = cards[Math.min(config.replyTreeBackwardLoadAheadPosts, cards.length - 1)].getBoundingClientRect();
        return ahead.bottom >= headerHeight || boundary.top >= headerHeight - config.replyTreeLoadAheadPx;
      }
      if (boundary.bottom >= 0 && boundary.bottom <= innerHeight + config.replyTreeLoadAheadPx) return true;
    }
    if (direction === 'backward') return false;
    const boundary = tree.sentinel.getBoundingClientRect();
    return boundary.top <= innerHeight + config.replyTreeLoadAheadPx && boundary.bottom >= 0;
  }

  function replyTreeCurrentPost(tree) {
    if (tree.positionedPost && tree.stream.includes(tree.positionedPost.postId) && tree.posts.has(tree.positionedPost.postId)
      && tree.positionedPost.scrollY === pageScrollTop()) return { ...tree.positionedPost, visible: true };
    tree.positionedPost = null;
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    const cards = tree.content.querySelectorAll('.betterld-reply-tree__card');
    const streamIds = new Set(tree.stream);
    let visible;
    for (const card of cards) {
      if (!streamIds.has(Number(card.dataset.postId))) continue;
      const bounds = card.getBoundingClientRect();
      if (card.getClientRects().length && bounds.bottom > headerHeight && bounds.top < innerHeight) {
        visible = card;
        break;
      }
    }
    const postNumber = Number(visible?.parentElement.dataset.postNumber) || 0;
    const postId = visible ? Number(visible.dataset.postId) : undefined;
    // 没有流内可见楼时上报未知，不把首帖或流外上下文当作阅读位置。
    const bounds = visible?.getBoundingClientRect();
    const ratio = bounds ? Math.max(0, Math.min(1, (headerHeight - bounds.top) / bounds.height)) : 0;
    return { postNumber, postId, ratio, visible: Boolean(visible) };
  }

  // 实时同步只合并原站模型与流；正文由阅读窗口按需续载，不在这里自己发请求。
  function syncReplyTreeData(tree) {
    if (!pageActive() || tree.busy || !tree.pendingData) return;
    if (tree.filterBusy) return;
    const data = tree.pendingData;
    tree.pendingData = null;
    // 与任务同一世代：筛选切换后遗留的旧世代批次不再消费。
    if (data.generation !== undefined && data.generation !== tree.filterGeneration) return;
    if (data.error) {
      tree.status.textContent = `回复实时同步失败：${data.error}`;
      return;
    }
    if (typeof data.ownerUsername === "string" && data.ownerUsername) tree.ownerUsername = data.ownerUsername;
    // 权限与忽略列表以桥的原站投影为唯一来源；桥没给时保持未知，不在这里推断。
    const contextChanged = Boolean(data.context && JSON.stringify(tree.context) !== JSON.stringify(data.context));
    if (data.context) tree.context = data.context;
    const currentUrlFilters = topicStreamFiltersFromUrl();
    if (tree.filterTransition && topicFilterStateKey(tree.filterTransition) === topicFilterStateKey(currentUrlFilters)) tree.filterTransition = null;
    if (tree.filterTransition && topicFilterStateKey(currentUrlFilters) !== tree.filterTransitionFrom) tree.filterTransition = null;
    const urlFilters = tree.filterTransition || currentUrlFilters;
    // 导航初期原站可能仍持有旧模型；先沿 URL 保持当前视图，等新筛选模型到齐再消费楼层。
    if (Array.isArray(data.userFilters) && (data.userFilters.join(",") !== urlFilters.userFilters.join(",")
      || Boolean(data.topReplies) !== urlFilters.topReplies)) {
      syncReplyTreeFilterBar(tree);
      return;
    }
    if (typeof data.topReplies === "boolean") {
      tree.topReplies = data.topReplies;
      tree.returnAll.hidden = !tree.topReplies;
    }
    if (Array.isArray(data.userFilters)) {
      tree.userFilters = data.userFilters;
    }
    applyTopicReadingFilterView(tree);
    const streamChanged = JSON.stringify(tree.stream) !== JSON.stringify(data.stream);
    setReplyTreeStream(tree, data.stream);
    const streamIds = new Set(tree.stream);
    const badgesChanged = mergeReplyUserBadges(tree, data.user_badges);
    let changed = streamChanged || badgesChanged || contextChanged;
    // 摘要与作者筛选下，流内的楼层只是筛选结果；未命中的已加载楼层继续作为父上下文保留。
    const filteredStream = tree.topReplies || tree.userFilters.length > 0;
    for (const [id] of tree.posts) {
      if (streamIds.has(id)) tree.orphanContextIds.delete(id);
      if (!filteredStream && !streamIds.has(id) && !tree.orphanContextIds.has(id)) {
        tree.posts.delete(id);
        tree.loaded.delete(id);
        changed = true;
      }
    }
    for (const post of data.posts) {
      if ((!streamIds.has(post.id) && !tree.orphanContextIds.has(post.id)) || (!replyTreeBodyState(post) && !replyTreePostIgnored(tree, post))) continue;
      const previous = tree.posts.get(post.id);
      if (previous && Object.keys(post).every((key) => JSON.stringify(previous[key]) === JSON.stringify(post[key]))) continue;
      if (mergeReplyTreePost(tree, post)) changed = true;
    }
    // 原站实时流可能已移除缺失ID，或模型已补到正文；旧失败批次不再阻断续读。
    if (tree.retryBatch && !replyTreeMissingIds(tree, tree.retryBatch).length) clearReplyTreeBodyRetry(tree);
    if (changed) {
      if (tree.contentContainer.hidden) tree.renderPending = true;
      else renderReplyTree(tree);
    }
    updateReplyTreeMore(tree);
    scheduleReplyTreeWake(tree);
  }

  function replyTreePostByTarget(tree, postNumber, postId) {
    if (postId) return tree.posts.get(postId);
    return [...tree.posts.values()].find((post) => post.post_number === postNumber);
  }

  // 跳转回执只发一次：同一个 requestId 不会因为冷却重试而被重复确认。
  function ackReplyTreeJump(tree, record, errorMessage) {
    if (tree.wait.pendingJump === record) tree.wait.pendingJump = null;
    if (record.acked) return;
    record.acked = true;
    if (!record.requestId) return;
    document.dispatchEvent(new CustomEvent("betterld:reply-jumped", {
      detail: JSON.stringify({ topicId: tree.topicId, requestId: record.requestId, postNumber: record.postNumber || 0, error: errorMessage })
    }));
  }

  function createReplyTreeJump(postNumber, postId, requestId) {
    return { postNumber: Number(postNumber) || 0, postId: postId || 0, requestId: requestId || "", acked: false, state: "pending" };
  }

  // 缓存目标与双侧邻域都就绪才直接定位；缺正文沿共用队列准备。
  function requestReplyTreeJump(tree, postNumber, postId, requestId) {
    const record = createReplyTreeJump(postNumber, postId, requestId);
    if (tree.streamReady && !tree.stream.length) {
      ackReplyTreeJump(tree, record, "当前阅读范围没有可跳转的回复");
      return;
    }
    cancelReplyTreeTasks(tree, (pending) => pending.kind === "jump" || pending.kind === "body");
    tree.retryBatch = null;
    if (tree.wait.pendingJump) ackReplyTreeJump(tree, tree.wait.pendingJump, "跳转请求已被新的跳转取代");
    const post = replyTreePostByTarget(tree, record.postNumber, record.postId);
    if (tree.bridgeReady && tree.context && [...tree.posts.values()].some((entry) => entry.post_number === 1)
      && tree.stream.length && post && (Boolean(replyTreeBodyState(post)) || replyTreePostIgnored(tree, post))) {
      applyReplyTreeJump(tree, record, post, "");
      return;
    }
    scheduleReplyTreeJump(tree, record);
  }

  function scheduleReplyTreeJump(tree, record) {
    // 冷却期间只保留最新一次跳楼意图；被取代的那次立刻回执，不让主世界超时。
    const superseded = tree.wait.pendingJump;
    if (superseded && superseded !== record) ackReplyTreeJump(tree, superseded, "跳转请求已被新的跳转取代");
    record.state = "pending";
    const generation = tree.filterGeneration;
    return scheduleReplyTreeTask(tree, {
      kind: "jump",
      jump: record,
      key: `jump:${record.postId || `#${record.postNumber}`}`,
      generation,
      priority: config.topicRequestPriority.jump,
      isNeeded: () => replyTreeTaskActive(tree, generation),
      canStart: () => tree.bridgeReady && Boolean(tree.context) && tree.stream.length > 0 && [...tree.posts.values()].some((post) => post.post_number === 1),
      // 排队中或取数中被取消（切帖、隐藏、筛选切换）时也要及时回执。
      finish: () => {
        if (record.state === "pending") ackReplyTreeJump(tree, record, "楼层跳转请求已取消");
      },
      run: (entry) => loadReplyTreeJump(tree, entry, record)
    });
  }

  async function loadReplyTreeJump(tree, entry, record) {
    let post = replyTreePostByTarget(tree, record.postNumber, record.postId);
    // 初始跳楼可能先于模型到齐登记；出队时已有正文就复用，不再请求同一楼。
    if (post && (replyTreeBodyState(post) || replyTreePostIgnored(tree, post))) {
      applyReplyTreeJump(tree, record, post, "");
      return;
    }
    try {
      let endpoint = `/t/${tree.topicId}/${record.postNumber}.json`;
      if (record.postId) {
        if (!tree.stream.includes(record.postId)) throw new Error('目标回复已不在当前阅读范围');
        const batch = replyTreeJumpNeighborhood(tree, record.postId);
        const params = new URLSearchParams();
        (batch ? batch.ids : [record.postId]).forEach((id) => params.append('post_ids[]', id));
        endpoint = `/t/${tree.topicId}/posts.json?${params}`;
      }
      const data = await shareTopicFetch(endpoint);
      if (!entry.active()) return;
      if (!Array.isArray(data?.post_stream?.posts)) throw new Error("跳转楼层数据格式不正确");
      mergeReplyUserBadges(tree, data.user_badges);
      mergeReplyTreePosts(tree, data.post_stream.posts, { overwrite: false });
      post = replyTreePostByTarget(tree, record.postNumber, record.postId);
      if (!post) throw new Error("目标楼层不存在或不可访问");
    } catch (error) {
      if (error?.name === "AbortError" || !entry.stillCurrent()) return;
      if (error?.rateLimited) {
        // 首次限流保留这一次跳楼意图，冷却到点自动再试一次。
        const firstLimit = !tree.wait.retryUsed;
        noteReplyTreeRateLimit(tree, error);
        if (firstLimit) {
          record.state = "deferred";
          tree.wait.pendingJump = record;
          return;
        }
      }
      applyReplyTreeJump(tree, record, null, `楼层跳转失败：${error.message}`);
      return;
    }
    applyReplyTreeJump(tree, record, post, "");
  }

  function replyTreeJumpNeighborhood(tree, postId) {
    const index = tree.stream.indexOf(postId);
    const size = config.replyTreePageSize;
    const start = Math.max(0, Math.min(index - Math.floor(size / 2), tree.stream.length - size));
    const ids = tree.stream.slice(start, start + size).filter((id) => !tree.loaded.has(id));
    return ids.length ? {
      key: `body:around:${postId}`, ids, direction: 'forward', neighborhood: true
    } : null;
  }

  function applyReplyTreeJump(tree, record, post, errorMessage) {
    record.state = "settled";
    if (post) {
      record.postNumber = post.post_number;
      record.postId = post.id;
    }
    if (post && !tree.stream.includes(post.id)) {
      errorMessage = `楼层 #${post.post_number} 不在当前筛选结果中，请点击“返回全部回复”查看。`;
      post = null;
    }
    try {
      if (post && state.replyTree === tree) {
        const batch = replyTreeJumpNeighborhood(tree, post.id);
        if (batch) {
          // 准备期只合并数据，不切阅读锚点、不滚动、不提前确认成功。
          record.state = 'neighborhood';
          tree.wait.pendingJump = record;
          tree.status.textContent = `正在准备 #${post.post_number} 附近的回复…`;
          scheduleReplyTreeBody(tree, batch.direction, batch);
          return;
        }
        clearReplyTreeWait(tree);
        // 命中楼成为阅读窗口锚点：后续正文围绕它续载，而不是从流首缺口补过来。
        tree.anchorId = post.id;
        resetReplyTreePrefetch(tree);
        tree.bodyLoadBlocked = false;
        tree.bodyLoadDirection = 'forward';
        tree.autoLoadPaused = false;
        expandReplyBranchPath(tree, post, new Map([...tree.posts.values()].map((entry) => [entry.post_number, entry])));
        // 主动跳楼自己决定滚动位置，跳过锚点补偿。
        tree.skipAnchorRestore = true;
        renderReplyTree(tree);
        const card = tree.content.querySelector(`[data-post-number="${post.post_number}"] > .betterld-reply-tree__card`);
        if (!card?.getClientRects().length) throw new Error(`楼层 #${post.post_number} 尚未渲染，跳转未完成`);
        scrollReplyTreeCard(tree, post);
        tree.targetLocated = true;
        tree.status.textContent = "";
      } else if (errorMessage && state.replyTree === tree) {
        tree.status.textContent = errorMessage;
      }
    } catch (error) {
      console.error("[betterLD] reply jump projection failed", error);
      errorMessage = `楼层跳转失败：${error.message}`;
      post = null;
      if (state.replyTree === tree) tree.status.textContent = errorMessage;
    }
    ackReplyTreeJump(tree, record, post ? "" : errorMessage);
  }

  function scrollReplyTreeCard(tree, post) {
    const card = tree.content.querySelector(`[data-post-number="${post.post_number}"] > .betterld-reply-tree__card`);
    if (!card) return;
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    window.scrollTo({ top: pageScrollTop() + card.getBoundingClientRect().top - headerHeight, behavior: 'instant' });
    // 末楼可能无法贴到视口顶部；在用户实际滚动前保持刚命中的楼号。
    tree.bodyLoadScrollTop = pageScrollTop();
    tree.positionedPost = { postNumber: post.post_number, postId: post.id, scrollY: pageScrollTop() };
  }

  function syncReplyBookmark(tree, post, bookmarked, changed = false) {
    const previous = tree.bookmarkStates.get(String(post.id));
    if (previous === bookmarked) return;
    // 首次未加书签的楼不删除用户独立保存的本地收藏；已保存或发生变化时才镜像。
    if (!bookmarked && previous === undefined && !changed) {
      tree.bookmarkStates.set(String(post.id), false);
      return;
    }
    const title = tree.title || cleanText(document.querySelector(`#topic-title h1[data-topic-id="${tree.topicId}"] .fancy-title, .d-header .header-title .topic-link[data-topic-id="${tree.topicId}"]`)?.textContent);
    if (!title) {
      tree.status.textContent = "书签同步失败：主题标题尚未加载";
      return;
    }
    tree.bookmarkStates.set(String(post.id), bookmarked);
    document.dispatchEvent(new CustomEvent("betterld:reply-bookmark", {
      detail: JSON.stringify({ bookmarked, topic: {
        id: tree.topicId, postNumber: post.post_number, title,
        href: `${location.origin}${topicReplyUrl(tree.topicId, post.post_number)}`
      } })
    }));
  }

  document.addEventListener("betterld:reply-bookmark-changed", (event) => {
    const data = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (!tree || data.topicId !== tree.topicId) return;
    const post = tree.posts.get(data.postId);
    if (!post) return;
    if (data.title) tree.title = cleanText(data.title);
    post.bookmarked = data.bookmarked;
    syncReplyBookmark(tree, post, data.bookmarked, true);
  });

  document.addEventListener('betterld:reply-poll-refresh', async (event) => {
    const { topicId, postId, revision } = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId !== topicId || !tree.posts.has(postId) || tree.contentContainer.hidden) return;
    const pending = tree.pollRefreshRequests ||= new Map();
    const existing = pending.get(postId);
    if (existing) { existing.revision = revision; return; }
    const request = { revision };
    pending.set(postId, request);
    try {
      const active = () => state.replyTree === tree && topicIdFromPath() === topicId && !tree.contentContainer.hidden;
      while (active()) {
        const requestedRevision = request.revision;
        // 同一队列串行，直接读取本次消息之后的新响应，不复用投票前的正文在途请求。
        const data = await scheduleMetadataRequest(
          () => fetchTopicJson(`/t/${topicId}/posts.json?post_ids[]=${postId}`), active
        );
        if (!active()) return;
        if (request.revision !== requestedRevision) continue;
        const post = data?.post_stream?.posts?.find((entry) => entry.id === postId);
        if (!post || !Array.isArray(post.polls)) throw new Error('站点未返回该楼层的投票结果');
        document.dispatchEvent(new CustomEvent('betterld:reply-poll-data', {
          detail: JSON.stringify({ topicId, postId, polls: post.polls, revision: requestedRevision })
        }));
        break;
      }
    } catch (error) {
      console.error('[betterLD] poll result refresh failed', error);
      if (state.replyTree === tree) tree.status.textContent = `投票结果同步失败：${error.message}`;
    } finally {
      pending.delete(postId);
    }
  });

  document.addEventListener('betterld:reply-posts-registered', (event) => {
    const { topicId, postIds } = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId === topicId) for (const id of postIds) tree.registeredPostIds.add(id);
  });

  document.addEventListener('betterld:reply-data', (event) => {
    const data = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (!tree || data.topicId !== tree.topicId) return;
    if (data.error) {
      tree.status.textContent = `回复实时同步失败：${data.error}`;
      return;
    }
    // 已读元状态不依赖正文任务或树的可见性，避免增量被隐藏视图提前消费。
    syncReplyReadStates(tree, data.posts);
    // 忙碌/隐藏期间多个增量批次合并，后到的批次只覆盖同一楼，不能丢掉之前的其他楼。
    const posts = new Map((tree.pendingData?.posts || []).map((post) => [post.id, post]));
    for (const post of data.posts) posts.set(post.id, post);
    tree.pendingData = { ...data, posts: [...posts.values()], generation: tree.filterGeneration };
    syncReplyTreeData(tree);
  });
  document.addEventListener("betterld:reply-author-status", (event) => {
    const { topicId, postId, status } = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId !== topicId) return;
    // 主世界已原位更新本楼；缓存同值供后续树重建，避免分页快照恢复旧状态。
    const post = tree.posts.get(postId);
    if (post) post.user_status = status;
  });
  document.addEventListener('betterld:reply-jump', (event) => {
    const data = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId === data.topicId && !tree.contentContainer.hidden) requestReplyTreeJump(tree, data.postNumber, data.postId, data.requestId);
  });

  function returnAllReplyTreePosts(tree) {
    changeTopicAuthorFilter(tree, "");
  }

  // 原站的摘要与作者筛选都写在 URL 上（filter=summary / username_filters=a,b），与 Discourse setupParams 读入的 postStream 同值。
  function topicStreamFiltersFromUrl() {
    const params = new URLSearchParams(location.search);
    const usernames = params.get("username_filters");
    return {
      userFilters: usernames ? [...new Set(usernames.split(",").filter(Boolean))] : [],
      topReplies: params.get("filter") === "summary"
    };
  }

  // 筛选状态的比较键：URL 与树对象用同一份字段，快照流只在筛选状态一致时才能复用。
  function topicFilterStateKey(filters) {
    return `${filters.userFilters.join(",")}|${filters.topReplies}`;
  }

  function topicOwnerUsername(tree) {
    return tree.ownerUsername || preloadedReplyTopic(tree.topicId)?.details?.created_by?.username || "";
  }

  const replyTreeFooterSelectors = [".topic-timer-info", ".topic-status-info", ".topic-map.--bottom"];

  function restoreReplyTreeFooter(tree) {
    // 原生节点由原站维护；还原后再释放树底板，不克隆控件或丢失事件。
    for (const [selector, { element, marker }] of tree.footerSources) {
      const replacement = tree.topicContainer.querySelector(`${selector}:not(.betterld-reply-tree__footer *)`);
      if (element.isConnected && marker.isConnected && !replacement) marker.replaceWith(element);
      else {
        element.remove();
        marker.remove();
      }
    }
    tree.footerSources.clear();
  }

  function syncReplyTreeFooter(tree) {
    if (tree.contentContainer.hidden) {
      restoreReplyTreeFooter(tree);
      return;
    }
    for (const selector of replyTreeFooterSelectors) {
      const source = tree.topicContainer.querySelector(`${selector}:not(.betterld-reply-tree__footer *)`);
      const previous = tree.footerSources.get(selector);
      // 原站替换节点时丢弃旧挂载，不把过期提示或控件还原成第二份。
      if (previous && (source || !previous.marker.isConnected || !previous.element.isConnected)) {
        previous.element.remove();
        previous.marker.remove();
        tree.footerSources.delete(selector);
      }
      if (!source) continue;
      const marker = document.createComment(`betterLD ${selector} original position`);
      source.before(marker);
      tree.footerSources.set(selector, { element: source, marker });
      tree.footer.append(source);
    }
    // 原生提示可能晚到；沿同一顺序归位，只移动顺序发生变化的节点。
    let next = null;
    for (const selector of [...replyTreeFooterSelectors].reverse()) {
      const element = tree.footerSources.get(selector)?.element;
      if (!element) continue;
      if (next && element.nextElementSibling !== next) next.before(element);
      next = element;
    }
  }

  function syncReplyTreeFilterBar(tree) {
    // 原站筛选会拆掉旧流；保留旧底板引用供重建清理，不把它改写成 null。
    if (!tree.streamElement.isConnected) return;
    syncReplyTreeFooter(tree);
    // 底板只包住回复区，原站时间轴和普通原帖容器不参与阅读材质。
    const container = tree.streamElement.parentElement;
    if (container !== tree.readingPanelContainer) {
      tree.readingPanelContainer.classList.remove("betterld-reading-panel");
      tree.readingPanelContainer = container;
    }
    const readingActive = Boolean(tree.userFilters.length || tree.filterBusy);
    tree.readingPanelContainer.classList.toggle("betterld-reading-panel", readingActive);
    if (readingActive) tree.topicContainer.setAttribute("data-betterld-reading-active", "true");
    else tree.topicContainer.removeAttribute("data-betterld-reading-active");
    tree.toggle.disabled = Boolean(tree.filterBusy || tree.userFilters.length);
    tree.returnAll.disabled = Boolean(tree.filterBusy);
    tree.toggle.textContent = tree.contentContainer.hidden ? "树状回复" : "原帖回复";
    const currentUsername = preloadedCurrentUser()?.username;
    const ownerUsername = topicOwnerUsername(tree);
    // 摘要筛选不是作者筛选，此时三个选项都不选中；同一用户名既是楼主又是本人时两个入口同时成立。
    const selected = new Set();
    if (!tree.topReplies) {
      if (tree.userFilters.length === 0) {
        selected.add("all");
      } else {
        if (ownerUsername && tree.userFilters.includes(ownerUsername)) selected.add("owner");
        if (currentUsername && tree.userFilters.includes(currentUsername)) selected.add("me");
      }
    }
    for (const [key, button] of tree.filters) {
      button.disabled = Boolean(tree.filterBusy);
      const active = selected.has(key);
      button.classList.toggle("betterld-reply-tree__filter--active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const scope = tree.topReplies
      ? "摘要筛选"
      : tree.userFilters.length ? `只看 ${tree.userFilters.join("、")}` : "";
    tree.range.hidden = !scope && !tree.filterBusy;
    // 作者筛选的原帖模式由服务端过滤整条流，没有树内的已加载计数可报。
    tree.range.textContent = tree.filterBusy ? "正在切换阅读筛选…" : scope
      ? state.replyTreeNativeTopicId === tree.topicId
        ? `${scope} · 原帖回复（服务端筛选结果）`
        : `${scope} · 已加载 ${tree.stream.filter((id) => tree.loaded.has(id)).length}/${tree.stream.length} 楼`
      : "";
  }

  document.addEventListener('betterld:reply-reading-status', (event) => {
    const { topicId, error } = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId !== topicId) return;
    if (error) tree.status.textContent = error;
    else if (tree.status.textContent.startsWith('阅读登记失败（')) tree.status.textContent = '';
  });

  document.addEventListener('betterld:reply-read-state', (event) => {
    const { topicId, posts, error } = JSON.parse(event.detail);
    const tree = state.replyTree;
    if (tree?.topicId !== topicId) return;
    if (error) {
      tree.status.textContent = `已读状态同步失败：${error}`;
      return;
    }
    syncReplyReadStates(tree, posts);
  });

  // 返回树视图：与 showNativeReply 互为反向操作，供原帖/树入口与筛选状态变化共用。
  function showReplyTree(tree) {
    sessionStorage.removeItem(config.topicReadingViewStorageKey);
    state.replyTreeNativeTopicId = "";
    tree.toggle.hidden = false;
    tree.toggle.textContent = "原帖回复";
    tree.contentContainer.hidden = false;
    syncReplyTreeFilterBar(tree);
    if (tree.bridgeReady) document.dispatchEvent(new CustomEvent('betterld:reply-read-state-request', {
      detail: JSON.stringify({ topicId: tree.topicId })
    }));
    if (tree.posts.size || tree.renderPending) renderReplyTree(tree);
    maybeLoadMoreReplyTree(tree);
  }

  // 筛选视图的唯一规则：作者筛选由服务端过滤整条流，用原帖回复呈现，不强制构建筛选树；
  // 没有作者筛选就回到默认树。只有筛选状态真的变化时才切换，用户自己选的视图不被后续同步覆盖。
  function applyTopicReadingFilterView(tree) {
    const key = topicFilterStateKey(tree);
    if (key === tree.filterViewKey) {
      syncReplyTreeFilterBar(tree);
      return;
    }
    // 状态变化后旧流属于另一种筛选：丢掉已加载楼层按新筛选重读；首次建立面板沿用同筛选的快照流。
    if (tree.filterViewKey !== null) {
      cancelReplyTreeAnchorRestore(tree);
      closeReplyReactionPicker(tree);
      tree.boostExpanded.clear();
      tree.stream = [];
      tree.streamReady = false;
      tree.positionedPost = null;
      tree.loaded.clear();
      tree.posts.clear();
      tree.orphanContextIds.clear();
      tree.parentErrors.clear();
      tree.parentLoadPaused = false;
      tree.parentRetryNumber = 0;
      tree.anchorId = "";
      tree.retryBatch = null;
      tree.autoLoadPaused = false;
      tree.wait.until = 0;
      tree.wait.retryUsed = false;
      tree.status.textContent = "";
      tree.pendingData = null;
      // 筛选世代变化后，尚未发请求的旧世代任务全部作废。
      cancelReplyTreeTasks(tree);
      if (tree.wait.pendingJump) ackReplyTreeJump(tree, tree.wait.pendingJump, "筛选切换，楼层跳转请求已取消");
    }
    clearReplyTreeFilterError(tree);
    // 筛选世代单调递增：全部→摘要→全部 这类回到原值的切换也能作废旧任务。
    tree.filterGeneration += 1;
    resetReplyTreePrefetch(tree);
    tree.filterViewKey = key;
    if (tree.userFilters.length) {
      showNativeReply(tree);
      tree.panel.hidden = false;
    } else {
      const saved = sessionStorage.getItem(config.topicReadingViewStorageKey);
      const restore = saved ? JSON.parse(saved) : null;
      if (restore?.topicId === tree.topicId) {
        sessionStorage.removeItem(config.topicReadingViewStorageKey);
        if (restore.native) showNativeReply(tree);
        else if (tree.contentContainer.hidden) showReplyTree(tree);
      } else if (tree.contentContainer.hidden && state.replyTreeNativeTopicId !== tree.topicId) {
        showReplyTree(tree);
      }
    }
    tree.panel.dataset.authorFiltered = String(Boolean(tree.userFilters.length));
    syncReplyTreeFilterBar(tree);
  }

  // 使用原站 postStream 筛选与分页，在当前面板切换，不重新装载 Document。
  async function changeTopicAuthorFilter(tree, username) {
    if (tree.filterBusy) return;
    clearReplyTreeFilterError(tree);
    const previousNative = tree.contentContainer.hidden;
    tree.filterBusy = true;
    syncReplyTreeFilterBar(tree);
    if (!tree.userFilters.length && username) {
      sessionStorage.setItem(config.topicReadingViewStorageKey, JSON.stringify({ topicId: tree.topicId, native: tree.contentContainer.hidden }));
    }
    // 原站筛选会跳到命中楼层，先退出树的楼号拦截，让原帖自行定位。
    showNativeReply(tree);
    try {
      await loadPageRefreshBridge();
      const data = await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (result, error) => {
          clearTimeout(timer);
          document.removeEventListener("betterld:reading-filter-result", onResult);
          error ? reject(new Error(error)) : resolve(result);
        };
        const onResult = (event) => {
          const result = JSON.parse(event.detail);
          if (result.id === id) finish(result, result.error);
        };
        const timer = setTimeout(() => finish(null, "原站筛选超时，请重试"), config.topicRequestTimeoutMs);
        document.addEventListener("betterld:reading-filter-result", onResult);
        document.dispatchEvent(new CustomEvent("betterld:reading-filter-request", {
          detail: JSON.stringify({ id, topicId: tree.topicId, username })
        }));
      });
      if (state.replyTree !== tree) return;
      tree.userFilters = data.userFilters;
      tree.topReplies = data.topReplies;
      const filters = { userFilters: data.userFilters, topReplies: data.topReplies };
      tree.filterTransitionFrom = topicFilterStateKey(topicStreamFiltersFromUrl());
      tree.filterTransition = topicFilterStateKey(filters) === tree.filterTransitionFrom ? null : filters;
      applyTopicReadingFilterView(tree);
    } catch (error) {
      if (state.replyTree === tree) {
        if (!previousNative) showReplyTree(tree);
        showReplyTreeFilterError(tree, `筛选失败：${error.message}`);
      }
    } finally {
      tree.filterBusy = false;
      if (state.replyTree === tree) {
        syncReplyTreeFilterBar(tree);
        document.dispatchEvent(new CustomEvent("betterld:reply-sync", { detail: JSON.stringify({ topicId: tree.topicId }) }));
      }
    }
  }

  function applyReplyTreeReadingFilter(tree, key) {
    clearReplyTreeFilterError(tree);
    if (key === "all") {
      returnAllReplyTreePosts(tree);
      return;
    }
    if (key === "owner") {
      const username = topicOwnerUsername(tree);
      if (!username) {
        showReplyTreeFilterError(tree, "无法读取楼主用户名，暂时无法只看楼主。");
        return;
      }
      changeTopicAuthorFilter(tree, username);
      return;
    }
    const currentUsername = preloadedCurrentUser()?.username;
    if (!currentUsername) {
      promptReplyTreeLogin(tree, "请登录后再使用「我的回复」筛选。", tree.filterStatus);
      return;
    }
    changeTopicAuthorFilter(tree, currentUsername);
  }

  function syncReplyTree() {
    if (!pageActive()) return;
    const topicId = topicIdFromPath();
    document.body.dataset.betterldTopicDetail = String(Boolean(topicId));
    const stream = topicId && document.querySelector(".container.posts .post-stream");
    if (state.replyTree && (state.replyTree.topicId !== topicId || !stream || state.replyTree.panel.parentElement !== stream.parentElement || state.replyTree.streamElement !== stream)) {
      if (state.replyTree.topicId === topicId && state.replyTree.posts.size) {
        state.replyTreeSnapshot = state.replyTree;
      } else {
        state.replyTreeSnapshot = null;
      }
      cancelReplyTreeAnchorRestore(state.replyTree);
      cancelReplyBranchLayout(state.replyTree);
      state.replyTree.observer.disconnect();
      state.replyTree.branchLayoutObserver.disconnect();
      state.replyTree.branchContentObserver.disconnect();
      state.replyTree.content.removeEventListener('load', state.replyTree.branchMediaLoad, true);
      state.replyTree.content.removeEventListener('loadedmetadata', state.replyTree.branchMediaLoad, true);
      clearInterval(state.replyTree.relativeTimeTimer);
      stopReplyTreeStatusTimer(state.replyTree);
      cancelReplyTreeTasks(state.replyTree);
      if (state.replyTree.wait.pendingJump) ackReplyTreeJump(state.replyTree, state.replyTree.wait.pendingJump, "主题已切换，楼层跳转请求已取消");
      closeReplyReactionPicker(state.replyTree);
      state.replyTree.streamElement.removeAttribute("data-betterld-reply-source");
      state.replyTree.topicContainer.removeAttribute("data-betterld-reply-tree-active");
      state.replyTree.readingPanelContainer.classList.remove("betterld-reading-panel");
      state.replyTree.topicContainer.removeAttribute("data-betterld-reading-active");
      document.dispatchEvent(new CustomEvent("betterld:reply-author-reset"));
      restoreReplyTreeFooter(state.replyTree);
      state.replyTree.panel.remove();
      document.dispatchEvent(new CustomEvent('betterld:timeline-reset'));
      document.dispatchEvent(new CustomEvent('betterld:reply-reading-release'));
      state.replyTree = null;
    }
    if (!topicId) {
      state.replyTreeNativeTopicId = "";
      state.replyTreeSnapshot = null;
    }
    if (!topicId || !stream) return;
    if (state.replyTree) {
      const tree = state.replyTree;
      if (tree.filterBusy) return;
      // 站点自身或 SPA 改了筛选参数时按同一套规则重算视图，不留下过期的筛选状态。
      const urlFilters = topicStreamFiltersFromUrl();
      if (tree.filterTransition && (topicFilterStateKey(tree.filterTransition) === topicFilterStateKey(urlFilters)
        || topicFilterStateKey(urlFilters) !== tree.filterTransitionFrom)) tree.filterTransition = null;
      const currentFilters = tree.filterTransition || urlFilters;
      tree.topReplies = currentFilters.topReplies;
      tree.userFilters = currentFilters.userFilters;
      applyTopicReadingFilterView(tree);
      if (tree.renderPending && !tree.busy) renderReplyTree(tree);
      syncReplyTreeData(tree);
      // 可见性恢复与低频数据核对仍补查续载，避免交叉观察器在忙碌时漏掉一次回调。
      maybeLoadMoreReplyTree(tree);
      if (tree.bridgeReady) {
        document.dispatchEvent(new CustomEvent("betterld:reply-sync", { detail: JSON.stringify({ topicId }) }));
        syncReplyTreePosition();
      }
      return;
    }
    if (state.replyTreeNativeTopicId && state.replyTreeNativeTopicId !== topicId) state.replyTreeNativeTopicId = "";
    const urlFilters = topicStreamFiltersFromUrl();
    // 快照流只在筛选状态一致时复用：作者筛选的原帖模式不能把无筛选流当成筛选结果。
    const previousBranches = state.replyTreeSnapshot?.topicId === topicId ? state.replyTreeSnapshot.branchStates : null;
    const previousTails = state.replyTreeSnapshot?.topicId === topicId ? state.replyTreeSnapshot.tailStates : null;
    const previous = state.replyTreeSnapshot?.topicId === topicId && topicFilterStateKey(state.replyTreeSnapshot) === topicFilterStateKey(urlFilters) ? state.replyTreeSnapshot : null;
    state.replyTreeSnapshot = null;
    const panel = createElement("section", "betterld-reply-tree betterld-topic-reading");
    panel.setAttribute("aria-label", "主题阅读与筛选");
    const toggle = createElement("button", "betterld-reply-tree__toggle", "返回树状回复");
    toggle.type = "button";
    toggle.hidden = false;
    toggle.textContent = state.replyTreeNativeTopicId === topicId ? "树状回复" : "原帖回复";
    const returnAll = createElement("button", "betterld-reply-tree__toggle betterld-reply-tree__return-all", "返回全部回复");
    returnAll.type = "button";
    returnAll.hidden = !urlFilters.topReplies;
    const filters = createElement("div", "betterld-reply-tree__filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "阅读筛选");
    const filterButtons = new Map();
    for (const [key, label] of [["all", "全部"], ["owner", "只看楼主"], ["me", "我的回复"]]) {
      const button = createElement("button", "betterld-reply-tree__filter", label);
      button.type = "button";
      button.dataset.betterldFilter = key;
      button.addEventListener("click", () => applyReplyTreeReadingFilter(tree, key));
      filterButtons.set(key, button);
      filters.append(button);
    }
    const range = createElement("p", "betterld-reply-tree__range");
    range.hidden = true;
    const filterStatus = createElement("p", "betterld-reply-tree__filter-status");
    filterStatus.hidden = true;
    filterStatus.setAttribute("role", "status");
    const mine = createElement("div", "betterld-reply-tree__mine");
    mine.hidden = true;
    const notice = createElement("p", "betterld-reply-tree__notice");
    notice.hidden = true;
    notice.setAttribute("role", "status");
    const content = createElement("div", "betterld-reply-tree__content");
    content.hidden = state.replyTreeNativeTopicId === topicId;
    const replies = createElement("div", "betterld-reply-tree__replies");
    const previousButton = createElement("button", "betterld-reply-tree__more betterld-reply-tree__previous", "加载前面的回复");
    previousButton.type = "button";
    previousButton.hidden = true;
    const listElement = createElement("ol", "betterld-reply-tree__list");
    replies.append(previousButton, listElement);
    const status = createElement("p", "betterld-reply-tree__status", previous?.autoLoadPaused ? previous.status.textContent : "");
    status.setAttribute("role", "status");
    const sentinel = createElement("div", "betterld-reply-tree__sentinel");
    sentinel.setAttribute("aria-hidden", "true");
    const moreButton = createElement("button", "betterld-reply-tree__more", "重试加载回复");
    moreButton.type = "button";
    moreButton.hidden = !previous?.autoLoadPaused;
    content.append(replies, status, sentinel, moreButton);
    const toolbar = createElement("div", "betterld-topic-reading__toolbar");
    toolbar.append(filters, toggle, returnAll);
    const footer = createElement("div", "betterld-reply-tree__footer");
    panel.append(toolbar, range, filterStatus, notice, mine, content, footer);
    stream.before(panel);
    const targetPostNumber = Number(location.pathname.match(/^\/t\/(?:\d+|[^/]+\/\d+)\/(\d+)\/?$/)?.[1]) || 0;
    const tree = { title: previous?.title, bookmarkStates: previous?.bookmarkStates || new Map(), topicId, panel, footer, toggle, returnAll, filters: filterButtons, range, filterStatus, filterViewKey: null, filterGeneration: 0, notice, mine, contextExpanded: previous?.contextExpanded || new Set(), userFilters: urlFilters.userFilters, topReplies: urlFilters.topReplies, ownerUsername: previous?.ownerUsername || "", contentContainer: content, streamElement: stream, readingPanelContainer: stream.parentElement, topicContainer: stream.closest(".container.posts"), content: replies, listElement, previous: previousButton, status, sentinel, more: moreButton, posts: previous?.posts || new Map(), loaded: previous?.loaded || new Set(), stream: previous?.stream || [], branchStates: previousBranches || new Map(), tailStates: previousTails || new Map(), autoLoadPaused: previous?.autoLoadPaused || false, targetPostNumber, targetLocated: false, busy: false, boostEditor: null };
    tree.streamReady = previous ? previous.streamReady : false;
    tree.footerSources = new Map();
    tree.boostExpanded = new Set();
    tree.orphanContextIds = previous?.orphanContextIds || new Set();
    tree.parentErrors = previous?.parentErrors || new Map();
    tree.parentLoadingNumber = 0;
    tree.parentLoadPaused = previous?.parentLoadPaused || false;
    tree.parentRetryNumber = 0;
    tree.parentScanAt = 0;
    // 阅读窗口锚点、任务队列与等待状态都属于本树实例，不跨树共享。
    tree.anchorId = previous?.anchorId || "";
    tree.tasks = [];
    tree.activeTask = null;
    tree.wait = { until: 0, retryUsed: false, pendingJump: null };
    tree.statusTimer = 0;
    tree.compensating = false;
    tree.skipAnchorRestore = false;
    tree.registeredPostIds = new Set();
    tree.bodyLoadBlocked = false;
    tree.bodyLoadDirection = 'forward';
    tree.bodyLoadScrollTop = pageScrollTop();
    resetReplyTreePrefetch(tree);
    bindReplyBranchInteraction(tree);
    tree.branchLayouts = new WeakMap();
    tree.branchDirty = new WeakSet();
    tree.branchLayoutFrame = 0;
    tree.branchLayoutObserver = new ResizeObserver(() => scheduleReplyBranchLayout(tree));
    const branchContentSelector = '.betterld-reply-tree__cooked, .betterld-reply-tree__boosts, .betterld-reply-tree__head, .betterld-reply-tree__avatar-wrap';
    tree.branchContentObserver = new MutationObserver((records) => {
      let changed = false;
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        // 同批正文替换可能已移除此前修改过的文本；由替换的 childList 记录处理。
        if (!element || !tree.content.contains(element)) continue;
        const replacesContent = record.type === 'childList' && element.closest('.betterld-reply-tree__card')
          && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && node.matches(branchContentSelector));
        if (!element.closest(branchContentSelector) && !replacesContent) continue;
        invalidateReplyBranchLayout(tree, element.closest('.betterld-reply-tree__item'));
        changed = true;
      }
      if (changed) scheduleReplyBranchLayout(tree);
    });
    tree.branchContentObserver.observe(tree.content, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'width', 'height', 'src']
    });
    tree.branchMediaLoad = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(branchContentSelector)) return;
      invalidateReplyBranchLayout(tree, event.target.closest('.betterld-reply-tree__item'));
      scheduleReplyBranchLayout(tree);
    };
    tree.content.addEventListener('load', tree.branchMediaLoad, true);
    tree.content.addEventListener('loadedmetadata', tree.branchMediaLoad, true);
    tree.observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) maybeLoadMoreReplyTree(tree);
    }, { rootMargin: `0px 0px ${config.replyTreeLoadAheadPx}px 0px` });
    tree.observer.observe(sentinel);
    tree.userBadges = previous?.userBadges;
    state.replyTree = tree;
    loadPageRefreshBridge().then(() => {
      if (state.replyTree !== tree) return;
      tree.bridgeReady = true;
      scheduleSync();
      document.dispatchEvent(new CustomEvent("betterld:reply-author-details", { detail: JSON.stringify({ topicId: tree.topicId }) }));
    }).catch((error) => {
      console.error('[betterLD] reply bridge failed', error);
      if (state.replyTree === tree) tree.status.textContent = `树状回复正文组件加载失败：${error.message}。请通过“原帖回复”查看内容。`;
    });
    tree.relativeTimeTimer = setInterval(() => refreshReplyTreeTimes(tree), config.replyTreeTimeRefreshMs);
    returnAll.addEventListener("click", () => returnAllReplyTreePosts(tree));
    applyTopicReadingFilterView(tree);
    toggle.addEventListener("click", () => tree.contentContainer.hidden ? showReplyTree(tree) : showNativeReply(tree));
    const loadBody = (requestedDirection) => {
      const direction = tree.retryBatch?.direction || requestedDirection;
      tree.autoLoadPaused = false;
      tree.wait.until = 0;
      tree.wait.retryUsed = false;
      moreButton.hidden = true;
      resetReplyTreePrefetch(tree);
      tree.bodyLoadBlocked = false;
      tree.bodyLoadDirection = direction;
      tree.status.textContent = "";
      if ((tree.retryBatch || replyTreeBodyBatch(tree, direction)) && !tree.wait.pendingJump) scheduleReplyTreeBody(tree, direction);
      else maybeLoadMoreReplyTree(tree);
    };
    moreButton.addEventListener("click", () => loadBody('forward'));
    previousButton.addEventListener("click", () => loadBody('backward'));
    if (content.hidden) panel.hidden = false;
    else if (tree.posts.size) renderReplyTree(tree);
    // 深链先登记目标意图，优先级高于任何正文/上文任务。
    if (!content.hidden && tree.targetPostNumber > 0) {
      requestReplyTreeJump(tree, tree.targetPostNumber, 0, "");
    }
    maybeLoadMoreReplyTree(tree);
  }

  function checkDailyWallpaper() {
    if (state.currentSettings.wallpaperMode !== config.wallpaperModes.random) {
      return;
    }
    if (state.currentSettings.wallpaperRandomDate !== localDateKey()) {
      applyVisualSettings(state.currentSettings);
    }
  }

  function syncReplyTreePosition() {
    const tree = state.replyTree;
    if (!pageActive() || !tree) return;
    const active = !tree.contentContainer.hidden;
    const headerHeight = document.querySelector('.d-header')?.offsetHeight || 0;
    const current = active ? replyTreeCurrentPost(tree) : null;
    // 必要父楼可能位于另一缓存段；读到上下文不把窗口切回帖首。
    const reading = replyTreeWindow(tree);
    const currentIndex = current?.postId ? tree.stream.indexOf(current.postId) : -1;
    if (current?.visible && reading && !reading.empty && currentIndex >= reading.lo && currentIndex <= reading.hi) {
      tree.anchorId = current.postId;
    }
    // 楼层上报依赖原站桥接，本地锚点更新不依赖。
    if (tree.bridgeReady) {
      const visiblePostIds = active ? [...tree.content.querySelectorAll('.betterld-reply-tree__card')].flatMap((card) => {
        const post = tree.posts.get(Number(card.dataset.postId));
        const body = card.querySelector(':scope > .betterld-reply-tree__body > .betterld-reply-tree__cooked');
        if (!post || replyTreePostIgnored(tree, post) || post.cooked_hidden || !post.cooked?.trim() || !body?.getClientRects().length) return [];
        const bounds = body.getBoundingClientRect();
        return bounds.bottom > headerHeight && bounds.top < innerHeight ? [post.id] : [];
      }) : [];
      document.dispatchEvent(new CustomEvent("betterld:reply-position", {
        detail: JSON.stringify({ topicId: tree.topicId, ...(current || {}), visiblePostIds, active, timeoutMs: config.pageRefreshTimeoutMs })
      }));
    }
    // 树展开或重建后可见楼层可能变化，阅读楼层跟着核对一次。
  }

  function scheduleReplyPosition() {
    if (!pageActive() || !state.replyTree) return;
    state.replyTree.positionedPost = null;
    if (state.positionTimer) return;
    state.positionTimer = window.setTimeout(() => {
      state.positionTimer = 0;
      syncReplyTreePosition();
      if (state.replyTree) maybeLoadMoreReplyTree(state.replyTree);
    }, config.syncDebounceMs);
  }

  // URL 探测保持轻量；列表/正文投影由相关 DOM 变化和独立慢核对驱动。
  // 返回本次是否已经记录了一次实际访问，供页面恢复可见时避免重复写入。
  function checkRoute() {
    if (!pageActive() || !state.settingsResolved) return false;
    applyTopicSort();
    enforceRefreshScrollTop();
    if (location.href === state.currentHref) return false;
    const previousPathname = new URL(state.currentHref, location.origin).pathname;
    state.currentHref = location.href;
    const id = topicIdFromPath();
    // 同一主题内的楼层与锚点变化只更新阅读楼层，不重复记为一次新访问。
    const sameTopic = Boolean(id) && id === topicIdFromPath(previousPathname);
    updateRouteState();
    scheduleSync();
    return !sameTopic;
  }

  // 媒体降噪：参数集中在 config.media，模块只按当前 document 的真实 DOM 处理；
  // 静态头像的身份与 CDN 解析都走原站模型桥接，不猜文件后缀、不补用户请求。
  const staticAvatarTemplates = new Map();

  function syncMediaSettings(settings) {
    const autoplay = settings.mediaBlockAutoplay === true;
    const avatars = settings.staticAvatarsEnabled === true;
    if (state.mediaSynced && state.mediaAutoplay === autoplay && state.mediaAvatars === avatars) return;
    state.mediaSynced = true;
    state.mediaAutoplay = autoplay;
    state.mediaAvatars = avatars;
    mediaApi.sync({ autoplay, avatars });
  }

  async function resolveStaticAvatars(pairs) {
    await loadPageRefreshBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener("betterld:media-data", onResult);
        if (result.error) reject(new Error(result.error));
        else resolve(result.payload);
      };
      const timer = window.setTimeout(() => {
        document.removeEventListener("betterld:media-data", onResult);
        reject(new Error("原站头像数据读取超时"));
      }, config.pageRefreshTimeoutMs);
      document.addEventListener("betterld:media-data", onResult);
      document.dispatchEvent(new CustomEvent("betterld:media-data-request", {
        detail: JSON.stringify({ id, pairs, templates: Object.fromEntries(staticAvatarTemplates) })
      }));
    });
  }

  // 私人用户标记：本机 storage.local 是唯一数据源，增删统一走后台串行队列，跨标签由 storage 事件刷新。
  async function readUserMarks() {
    const stored = await storageGet([userMarksApi.storageKey]);
    try {
      state.userMarks = userMarksApi.normalize(stored[userMarksApi.storageKey]);
      state.userMarksError = "";
    } catch (error) {
      state.userMarks = { version: 1, marks: {} };
      state.userMarksError = error.message;
      console.error("[betterLD] user marks storage invalid", error);
    }
    refreshUserMarks();
  }

  async function writeUserMark(message) {
    const response = await sendRuntimeMessage({ type: "user-marks-write", ...message });
    if (!response?.ok) {
      throw new Error(response?.error || "用户标记写入失败");
    }
    state.userMarks = userMarksApi.normalize(response.marks);
    refreshUserMarks();
  }

  // 短标签只消费真实用户 ID；备注不进作者栏，只在用户卡片与设置管理里出现。
  function userMarkChip(userId) {
    if (!state.currentSettings.userMarksEnabled) return null;
    const mark = userMarksApi.find(state.userMarks, userId);
    if (!mark?.tag) return null;
    const chip = createElement("span", "betterld-user-mark", mark.tag);
    chip.title = `私人标签：${mark.tag}`;
    return chip;
  }

  function syncUserMarkChips() {
    let needsSearchAuthors = false;
    for (const article of document.querySelectorAll(".container.posts .post-stream article[data-user-id]")) {
      const names = article.querySelector(".names");
      if (!names) continue;
      applyUserMarkChip(names, userMarkChip(Number(article.dataset.userId)), ":scope > span.first", "after");
    }
    for (const row of document.querySelectorAll(".betterld-topic-row")) {
      const author = row.querySelector(".betterld-topic-row__info > .betterld-topic-card__author");
      if (!author) continue;
      // 列表作者 ID 来自主题模型；搜索结果的作者 ID 由原站搜索模型桥接，两者都缺时不加标签。
      const topicId = row.dataset.topicId;
      const authorId = Number(state.topicListMetadata.get(topicId)?.authorId) || Number(state.searchAuthorIds.get(topicId));
      if (!authorId && row.dataset.betterldSearchResult === "true") needsSearchAuthors = true;
      applyUserMarkChip(author.parentElement, userMarkChip(authorId), null, "after", author);
    }
    if (needsSearchAuthors) refreshSearchAuthorIds();
  }

  // 搜索结果行的作者 ID 只在原站搜索模型里，每个已就绪的搜索地址只向桥接要一次。
  function refreshSearchAuthorIds() {
    const href = location.href;
    if (state.searchAuthorsHref === href) return;
    state.searchAuthorsHref = href;
    readNativeSearchState()
      .then((native) => {
        if (location.href !== href) return;
        if (!native.ready) {
          state.searchAuthorsHref = "";
          return;
        }
        state.searchAuthorIds = new Map(Object.entries(native.authors || {}));
        syncUserMarkChips();
      })
      .catch((error) => {
        state.searchAuthorsHref = "";
        console.error("[betterLD] search author ids unavailable", error);
      });
  }

  // 原位更新已有标签，无实际变化不写 DOM，避免触发原站作者栏的变更观察。
  function applyUserMarkChip(container, chip, anchorSelector, position, anchor) {
    const existing = container.querySelector(":scope > .betterld-user-mark");
    if (!chip) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.textContent !== chip.textContent) existing.textContent = chip.textContent;
      if (existing.title !== chip.title) existing.title = chip.title;
      return;
    }
    const target = anchor || (anchorSelector ? container.querySelector(anchorSelector) : null);
    if (target && position === "after") target.after(chip);
    else container.append(chip);
  }

  function refreshUserMarks() {
    if (!state.currentSettings.userMarksEnabled) {
      // 关闭开关时同时移除已注入卡片的编辑器，不留半截入口。
      document.querySelectorAll(".betterld-user-marks").forEach((row) => row.remove());
      state.userCardMountedKey = "";
    } else if (document.querySelector("#user-card.show")) {
      mountUserCardMarks();
    }
    if (state.replyTree?.posts.size) renderReplyTree(state.replyTree);
    syncUserMarkChips();
  }

  async function requestUserCardIdentity() {
    await loadPageRefreshBridge();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const onResult = (event) => {
        const result = JSON.parse(event.detail);
        if (result.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener("betterld:user-card", onResult);
        if (result.error) reject(new Error(result.error));
        else resolve(result.payload);
      };
      const timer = setTimeout(() => {
        document.removeEventListener("betterld:user-card", onResult);
        reject(new Error("用户卡片身份读取超时"));
      }, config.pageRefreshTimeoutMs);
      document.addEventListener("betterld:user-card", onResult);
      document.dispatchEvent(new CustomEvent("betterld:user-card-request", { detail: JSON.stringify({ id }) }));
    });
  }

  function observeUserCard() {
    const card = document.querySelector("#user-card");
    if (!card || state.userCardObserver) return;
    // 卡片先显示 loading 骨架再填内容，除了 show 类还要跟着卡片内容变化重试身份读取；
    // 插件自己写入的行会被过滤，避免自触发循环。
    state.userCardObserver = new MutationObserver((records) => {
      if (!card.classList.contains("show")) return;
      const ownOnly = records.every((record) => {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        return target?.closest("[data-betterld-owned]");
      });
      if (ownOnly) return;
      mountUserCardMarks();
    });
    state.userCardObserver.observe(card, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
  }

  async function mountUserCardMarks() {
    if (!state.currentSettings.userMarksEnabled || state.userCardMounting) return;
    const card = document.querySelector("#user-card.show");
    if (!card) return;
    const requestSeq = ++state.userCardRequestSeq;
    state.userCardMounting = true;
    let identity;
    try {
      identity = await requestUserCardIdentity();
    } catch (error) {
      console.error("[betterLD] user card identity unavailable", error);
      state.userCardMounting = false;
      if (requestSeq === state.userCardRequestSeq && card.classList.contains("show")) {
        renderUserCardMarks(card, null, error.message);
      }
      return;
    }
    state.userCardMounting = false;
    // 异步期间卡片可能已关闭或已换人，只对仍然显示的卡片写入。
    if (!identity || requestSeq !== state.userCardRequestSeq || !card.classList.contains("show")) return;
    // 卡片带回了模型之外的静态头像模板：登记后让媒体模块重算，卡片头像也能静态化。
    if (identity.avatarTemplate && !staticAvatarTemplates.has(identity.username)) {
      staticAvatarTemplates.set(identity.username, identity.avatarTemplate);
      mediaApi.invalidate();
    }
    renderUserCardMarks(card, identity);
  }

  // 原站卡片不重建，只在操作区追加一项自有内容；身份缺失时就地说明原因。
  function renderUserCardMarks(card, identity, error = "") {
    const controls = card.querySelector(".usercard-controls");
    if (!controls) return;
    let row = controls.querySelector(".betterld-user-marks");
    if (!row) {
      row = createElement("li", "betterld-user-marks");
      controls.append(row);
    }
    const key = identity
      ? `${identity.userId}:${JSON.stringify(userMarksApi.find(state.userMarks, identity.userId))}`
      : `error:${error}`;
    if (state.userCardMountedKey === key && row.firstElementChild) return;
    state.userCardMountedKey = key;
    row.replaceChildren();
    const status = createElement("p", "betterld-user-marks__status");
    status.setAttribute("role", "status");
    if (state.userMarksError) {
      row.append(createElement("p", "betterld-user-marks__status", `用户标记存储异常：${state.userMarksError}`));
    }
    if (!identity) {
      status.textContent = `私人标记不可用：${error}`;
      row.append(status);
      return;
    }
    const mark = userMarksApi.find(state.userMarks, identity.userId);
    const toggle = createElement("button", "btn-default betterld-user-marks__toggle", mark?.tag ? `私人标记：${mark.tag}` : "私人标记");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    const panel = createElement("div", "betterld-user-marks__panel");
    panel.hidden = true;
    const tag = createElement("input", "betterld-user-marks__input");
    tag.type = "text";
    tag.maxLength = userMarksApi.tagMaxLength;
    tag.placeholder = `短标签（最长 ${userMarksApi.tagMaxLength} 字，显示在作者名旁）`;
    tag.value = mark?.tag || "";
    tag.setAttribute("aria-label", "私人标签");
    const note = createElement("textarea", "betterld-user-marks__input");
    note.maxLength = userMarksApi.noteMaxLength;
    note.placeholder = `备注（最长 ${userMarksApi.noteMaxLength} 字，只在卡片与设置中可见）`;
    note.value = mark?.note || "";
    note.setAttribute("aria-label", "私人备注");
    const actions = createElement("div", "betterld-user-marks__actions");
    const save = createElement("button", "btn-primary betterld-user-marks__save", "保存");
    save.type = "button";
    const clear = createElement("button", "btn-default betterld-user-marks__clear", "清除");
    clear.type = "button";
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) tag.focus();
    });
    save.addEventListener("click", async () => {
      status.textContent = "";
      try {
        await writeUserMark({ mark: { userId: identity.userId, username: identity.username, tag: tag.value, note: note.value } });
        status.textContent = "已保存";
      } catch (writeError) {
        status.textContent = `保存失败：${writeError.message}`;
      }
    });
    clear.addEventListener("click", async () => {
      status.textContent = "";
      try {
        await writeUserMark({ remove: true, userId: identity.userId });
        status.textContent = "已清除";
      } catch (writeError) {
        status.textContent = `清除失败：${writeError.message}`;
      }
    });
    actions.append(save, clear);
    panel.append(tag, note, actions, status);
    row.append(toggle, panel);
  }

  function syncPageData() {
    if (!pageActive() || !state.settingsResolved) return;
    checkRoute();
    checkDailyWallpaper();
    if (state.currentSettings.themeMode === "scheduled") applyColorMode();
    syncReplyTree();
    syncTopicListMetadata();
    // 分页、搜索与帖底推荐的新行也在这里补标签，不只在标记变化时同步。
    syncUserMarkChips();
    observeUserCard();
    syncExternalSearch();
    syncSearchLoadMore(state.currentSettings, isSearchPage());
    if (state.pageRefreshBridge) document.dispatchEvent(new CustomEvent("betterld:host-cleanup"));
  }

  function pausePageWork() {
    document.dispatchEvent(new CustomEvent('betterld:reply-reading-release'));
    for (const key of ["routeTimer", "dataTimer"]) {
      clearInterval(state[key]);
      state[key] = 0;
    }
    clearTimeout(state.syncTimer);
    clearTimeout(state.positionTimer);
    state.syncTimer = 0;
    state.positionTimer = 0;
    cancelAnimationFrame(state.filterBinFrame);
    state.filterBinFrame = 0;
    if (state.replyTree) {
      resetReplyTreePrefetch(state.replyTree);
      cancelReplyTreeAnchorRestore(state.replyTree);
      cancelReplyBranchLayout(state.replyTree);
      clearInterval(state.replyTree.relativeTimeTimer);
      state.replyTree.relativeTimeTimer = 0;
    }
  }

  function resumePageWork() {
    if (!pageActive()) return;
    if (!state.routeTimer) state.routeTimer = window.setInterval(checkRoute, config.routePollMs);
    if (!state.dataTimer) state.dataTimer = window.setInterval(syncPageData, config.pageDataSyncMs);
    checkRoute();
    scheduleSync();
    if (state.replyTree) {
      const tree = state.replyTree;
      refreshReplyTreeTimes(tree);
      scheduleReplyBranchLayout(tree);
      if (!tree.relativeTimeTimer) tree.relativeTimeTimer = setInterval(() => refreshReplyTreeTimes(tree), config.replyTreeTimeRefreshMs);
    }
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
  mediaApi.setAvatarResolver(resolveStaticAvatars);
  startup.ready.then(({ stored, settings, area, error }) => {
    state.localWallpaper = isStoredLocalWallpaper(stored[config.wallpaperLocalStorageKey])
      ? stored[config.wallpaperLocalStorageKey] : null;
    state.remoteWallpaperCache = stored[config.wallpaperRemoteCacheKey]
      && typeof stored[config.wallpaperRemoteCacheKey] === "object"
      ? stored[config.wallpaperRemoteCacheKey] : null;
    // IP 冷却沿原记录跨页面存活，不因提前启动重新发起突发请求。
    const cooldown = stored[config.topicRequestCooldownStorageKey];
    const storedCooldown = Number(typeof cooldown === "object" && cooldown ? cooldown.until : cooldown);
    if (Number.isFinite(storedCooldown) && storedCooldown > Date.now()) state.metadataCooldownUntil = storedCooldown;
    if (Number.isSafeInteger(cooldown?.failures) && cooldown.failures >= 0) state.metadataRateLimitFailures = cooldown.failures;
    state.activeStorageArea = area;
    state.currentSettings = settings;
    state.settingsResolved = true;
    seedPreloadedTopicList();
    updateRouteState();
    applyVisualSettings(settings, { forceFallback: Boolean(error) });
    readUserMarks().catch((error) => console.error("[betterLD] user marks read failed", error));
    scheduleSync({ lists: false });
  }).catch((error) => console.error("[betterLD] page initialization failed", error));

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
    if (changes[config.userMarksStorageKey]) {
      readUserMarks().catch((error) => console.error("[betterLD] user marks reload failed", error));
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

  const sourceSelector = ".topic-list, .latest-topic-list, .fps-result-entries, .search-container, .container.posts .post-stream, .topic-map.--bottom, .topic-status-info, .topic-timer-info, #topic-title, #topic-footer-buttons, .topic-timeline, .load-more-sentinel, .list-controls, #data-preloaded";
  function ownedNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest("[data-betterld-owned], .betterld-topic-row__info, .betterld-topic-empty"));
  }

  function sourceMutation(record) {
    if (ownedNode(record.target)) return false;
    const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    if (record.type === "attributes") {
      const value = element.getAttribute(record.attributeName);
      if (record.oldValue === value) return false;
      if (record.attributeName === "class") {
        // 原站动态 class 重算可能覆盖布局标记，必须在本轮绘制前恢复。
        const layoutClasses = ["betterld-topic-list", "betterld-search-results", "betterld-topic-row", "betterld-search-result"];
        const previousClasses = (record.oldValue || "").split(/\s+/);
        if (layoutClasses.some((name) => previousClasses.includes(name) && !element.classList.contains(name))) return true;
        const nativeClasses = (text) => (text || "").split(/\s+/).filter((name) => name && !name.startsWith("betterld-")).sort().join(" ");
        if (nativeClasses(record.oldValue) === nativeClasses(value)) return false;
      }
      // 筛选显隐是插件输出；标题/分类/摘要及原站行状态继续被观察。
      if (record.attributeName === "hidden" && element.matches(".betterld-topic-row, .betterld-search-result")) return false;
      return Boolean(element.closest(sourceSelector));
    }
    if (record.type === "characterData") return Boolean(element?.closest(sourceSelector));
    const nodes = [...record.addedNodes, ...record.removedNodes].filter((node) => !ownedNode(node));
    if (!nodes.length) return false;
    return Boolean(element?.closest(sourceSelector)) || nodes.some((node) =>
      node instanceof Element && (node.matches(sourceSelector) || node.querySelector(sourceSelector)));
  }

  const domObserver = new MutationObserver((records) => {
    if (!pageActive() || !state.settingsResolved) return;
    if (records.some((record) => record.attributeName === "aria-checked" && record.target.matches('.semantic-search__results-toggle[role="switch"]'))) {
      syncExternalSearch();
    }
    const sources = records.filter(sourceMutation).filter((record) => {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (element?.closest(".topic-timeline")) {
        scheduleReplyPosition();
        return false;
      }
      return true;
    });
    if (!sources.length) return;
    // 新行及原站分批填入的标题/状态当轮增强，不等尾部扫描补齐。
    const rows = new Set();
    if (topicListEnhancementEnabled() && (isTopicListPage() || isSearchPage() || topicIdFromPath())) {
      const searchContainers = new Set();
      const containers = new Set();
      const rowSelector = ".topic-list-item, .latest-topic-list-item, .fps-result";
      const containerSelector = ".topic-list, .latest-topic-list, .fps-result-entries";
      for (const record of sources) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const container = target?.closest(containerSelector);
        if (container) containers.add(container);
        const row = target?.closest(rowSelector);
        if (row) rows.add(row);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element) || ownedNode(node)) continue;
          if (node.matches(containerSelector)) containers.add(node);
          node.querySelectorAll(containerSelector).forEach((item) => containers.add(item));
          if (node.matches(rowSelector)) rows.add(node);
          node.querySelectorAll(rowSelector).forEach((item) => rows.add(item));
        }
      }
      // topics 更新也会重算原站 table class；不能等防抖期间整表退回原样再切回来。
      containers.forEach((container) => {
        if (!container.isConnected || (topicIdFromPath() && !container.closest(".more-topics__lists"))) return;
        container.classList.add(container.matches(".fps-result-entries") ? "betterld-search-results" : "betterld-topic-list");
      });
      rows.forEach((row) => {
        if (!row.isConnected || (topicIdFromPath() && !row.closest(".more-topics__lists"))) return;
        if (row.matches(".fps-result")) {
          const container = row.closest(".fps-result-entries");
          container?.classList.add("betterld-search-results");
          if (container) searchContainers.add(container);
          enhanceSearchResult(row);
        } else {
          row.closest(".topic-list, .latest-topic-list")?.classList.add("betterld-topic-list");
          enhanceTopicRow(row);
        }
      });
      searchContainers.forEach(syncFilterEmptyState);
    }
    // 原站滚到页底才创建收藏入口，此时也可能没有列表行变化。
    globalThis.BETTERLD_LIBRARY.sync(rows);
    // 行已在本轮完成增强，尾部只核对模型/主题状态，不再遍历所有行。
    scheduleSync({ lists: false });
  });
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["class", "style", "href", "src", "srcset", "data-topic-id", "data-user-card", "title", "hidden", "aria-checked"]
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
    const tree = state.replyTree;
    if (tree && !tree.compensating && !tree.contentContainer.hidden && pageScrollTop() !== tree.bodyLoadScrollTop) {
      noteReplyTreeScroll(tree, pageScrollTop());
      updateReplyTreeMore(tree);
    }
    scheduleReplyPosition();
  }, { passive: true });
  window.addEventListener("resize", () => {
    resizeTopicDrawer();
    scheduleReplyPosition();
  });
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  state.currentHref = location.href;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pausePageWork();
    else resumePageWork();
  });
  window.addEventListener("pagehide", () => {
    state.pageSuspended = true;
    pausePageWork();
  });
  window.addEventListener("pageshow", () => {
    state.pageSuspended = false;
    resumePageWork();
  });
  resumePageWork();
})();
