(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);

  if (!config || !api?.storage?.local) {
    console.error("[betterLD] content script could not initialize: extension API is unavailable");
    return;
  }

  const state = {
    currentHref: "",
    currentSettings: config.settingsDefaults,
    syncTimer: 0,
    mutating: false,
    wallpaperRequest: 0,
    excerptCache: new Map(),
    excerptObserver: null,
    managedSources: new Map()
  };

  function storageGet() {
    if (firefoxApi) {
      return api.storage.local.get(config.storageKey);
    }

    return new Promise((resolve, reject) => {
      api.storage.local.get(config.storageKey, (value) => {
        const error = api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(value);
      });
    });
  }

  function clamp(value, limits) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return limits.min;
    }
    return Math.min(limits.max, Math.max(limits.min, number));
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      wallpaper: String(source.wallpaper || "").trim(),
      maskOpacity: clamp(source.maskOpacity ?? config.settingsDefaults.maskOpacity, config.settingsLimits.maskOpacity),
      blurPx: clamp(source.blurPx ?? config.settingsDefaults.blurPx, config.settingsLimits.blurPx),
      cardOpacity: clamp(source.cardOpacity ?? config.settingsDefaults.cardOpacity, config.settingsLimits.cardOpacity)
    };
  }

  function safeWallpaperUrl(value) {
    const input = String(value || "").trim();
    if (!input) {
      return "";
    }

    try {
      const url = new URL(input, location.href);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function applyVisualSettings(value) {
    const settings = normalizeSettings(value);
    const root = document.documentElement;
    const wallpaperRequest = ++state.wallpaperRequest;

    state.currentSettings = settings;
    root.style.setProperty("--betterld-mask-opacity", String(settings.maskOpacity));
    root.style.setProperty("--betterld-background-blur", `${settings.blurPx}px`);
    root.style.setProperty("--betterld-card-opacity", String(settings.cardOpacity));
    root.style.setProperty("--betterld-card-min-size", `${config.cardMinSize}px`);
    root.style.setProperty("--betterld-card-side-gutter", `${config.cardSideGutter}px`);
    root.style.setProperty("--betterld-grid-gap", `${config.gridGap}px`);
    root.style.removeProperty("--betterld-wallpaper-image");

    const wallpaperUrl = safeWallpaperUrl(settings.wallpaper);
    if (!wallpaperUrl) {
      return;
    }

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (wallpaperRequest !== state.wallpaperRequest) {
        return;
      }
      root.style.setProperty("--betterld-wallpaper-image", `url(${JSON.stringify(wallpaperUrl)})`);
    };
    image.onerror = () => {
      if (wallpaperRequest === state.wallpaperRequest) {
        console.warn("[betterLD] wallpaper could not be loaded", wallpaperUrl);
      }
    };
    image.src = wallpaperUrl;
  }

  function applyColorMode() {
    const root = document.documentElement;
    const body = document.body;
    const darkClass = root.classList.contains("dark") || root.classList.contains("dark-mode") || body?.classList.contains("dark") || body?.classList.contains("dark-mode");
    const darkData = root.dataset.colorScheme === "dark" || body?.dataset.colorScheme === "dark";
    const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    root.dataset.betterldMode = darkClass || darkData || prefersDark ? "dark" : "light";
  }

  function isHomepage() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    return path === config.homepagePath;
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
    const link = item.querySelector('a[data-user-card], a[href^="/u/"], a[href*="/u/"]');
    let name = cleanText(link?.textContent);

    if (!name && link) {
      try {
        const url = new URL(link.href, location.href);
        const parts = url.pathname.split("/").filter(Boolean);
        name = decodeURIComponent(parts[0] === "u" ? parts[1] || "" : "");
      } catch {
        name = "";
      }
    }

    return name || cleanText(item.querySelector(".topic-poster, .poster, .creator")?.textContent) || "LinuxDo 用户";
  }

  function avatarElement(item, author) {
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

    wrapper.textContent = cleanText(author).slice(0, 1).toUpperCase();
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

    const author = authorName(item);
    const category = categoryInfo(item);
    const card = createElement("a", "betterld-topic-card", undefined);
    const preview = createElement("span", "betterld-topic-card__preview");
    const title = createElement("span", "betterld-topic-card__title", topic.title);
    const excerpt = createElement("span", "betterld-topic-card__excerpt", topic.id ? config.excerptLoadingLabel : config.excerptPlaceholder);
    const footer = createElement("span", "betterld-topic-card__footer");
    const identity = createElement("span", "betterld-topic-card__identity");
    const authorElement = createElement("span", "betterld-topic-card__author", author);
    const chip = createElement("span", "betterld-topic-card__chip", category.name);
    const meta = createElement("span", "betterld-topic-card__meta", compactMeta(item));

    card.href = topic.href;
    card.setAttribute("aria-label", topic.title);
    card.dataset.topicId = topic.id;
    card.dataset.excerptState = topic.id ? "loading" : "failed";
    excerpt.dataset.state = topic.id ? "loading" : "failed";

    if (item.classList.contains("unread")) {
      card.classList.add("is-unread");
    }
    if (item.classList.contains("pinned") || item.classList.contains("topic-list-item--pinned")) {
      card.classList.add("is-pinned");
    }
    if (category.color) {
      card.style.setProperty("--betterld-category-color", category.color);
    }
    if (category.text) {
      card.style.setProperty("--betterld-category-text", category.text);
    }

    preview.append(title, excerpt);
    identity.append(authorElement, chip);
    footer.append(avatarElement(item, author), identity, meta);
    card.append(preview, footer);
    return card;
  }

  function plainText(markup) {
    const documentFragment = new DOMParser().parseFromString(String(markup || ""), "text/html");
    documentFragment.querySelectorAll("script, style, noscript, template, svg").forEach((node) => node.remove());
    return cleanText(documentFragment.body?.textContent).slice(0, config.excerptMaxCharacters);
  }

  async function fetchExcerpt(topicId) {
    const endpoint = new URL(`/t/${topicId}.json`, location.origin);
    const response = await fetch(endpoint.href, {
      credentials: "same-origin",
      cache: "force-cache",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`topic request failed with ${response.status}`);
    }

    const data = await response.json();
    const post = data?.post_stream?.posts?.[0];
    const text = plainText(post?.cooked || post?.raw);
    if (!text) {
      throw new Error("topic has no readable opening post");
    }
    return text;
  }

  function requestExcerpt(topicId) {
    const cached = state.excerptCache.get(topicId);
    if (cached?.state === "ready") {
      return Promise.resolve(cached.text);
    }
    if (cached?.state === "failed") {
      return Promise.reject(cached.error);
    }
    if (cached?.state === "pending") {
      return cached.promise;
    }

    const promise = fetchExcerpt(topicId)
      .then((text) => {
        state.excerptCache.set(topicId, { state: "ready", text });
        return text;
      })
      .catch((error) => {
        state.excerptCache.set(topicId, { state: "failed", error });
        throw error;
      });

    state.excerptCache.set(topicId, { state: "pending", promise });
    return promise;
  }

  function setExcerpt(card, text, stateName) {
    const excerpt = card.querySelector(".betterld-topic-card__excerpt");
    if (!excerpt) {
      return;
    }
    excerpt.textContent = text;
    excerpt.dataset.state = stateName;
    card.dataset.excerptState = stateName;
  }

  function loadExcerpt(card) {
    if (card.dataset.excerptState !== "loading" || !card.dataset.topicId) {
      return;
    }

    const topicId = card.dataset.topicId;
    requestExcerpt(topicId)
      .then((text) => setExcerpt(card, text, "ready"))
      .catch((error) => {
        console.warn(`[betterLD] opening post unavailable for topic ${topicId}`, error);
        setExcerpt(card, config.excerptPlaceholder, "failed");
      });
  }

  function observeCard(card) {
    if (state.excerptObserver && card.dataset.topicId) {
      state.excerptObserver.observe(card);
      return;
    }
    if (card.dataset.topicId) {
      loadExcerpt(card);
    }
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
    const avatar = item.querySelector(".topic-avatar img, .posters img.avatar, .avatar img, img.avatar");
    return JSON.stringify({
      topic,
      author: authorName(item),
      category: categoryInfo(item),
      meta: compactMeta(item),
      avatar: avatar?.currentSrc || avatar?.src || "",
      className: item.className
    });
  }

  function signature(items) {
    return items.map(itemSignature).join("\n");
  }

  function unobserveGrid(grid) {
    if (!state.excerptObserver) {
      return;
    }
    grid.querySelectorAll(".betterld-topic-card").forEach((card) => state.excerptObserver.unobserve(card));
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

  function rebuildContainer(container, items) {
    const currentSignature = signature(items);
    const currentGrid = managedGrid(container);
    if (container.dataset.betterldSignature === currentSignature && currentGrid?.isConnected) {
      return;
    }

    const originallyHidden = container.dataset.betterldSource === "true"
      ? container.dataset.betterldWasHidden === "true"
      : container.hidden;
    restoreContainer(container);

    const grid = createElement("div", "betterld-topic-grid");
    grid.dataset.betterldGrid = "true";
    grid.setAttribute("aria-label", "LinuxDo 主题");

    for (const item of items) {
      const card = createCard(item);
      if (!card) {
        continue;
      }
      grid.append(card);
      observeCard(card);
    }

    if (!grid.childElementCount) {
      return;
    }

    container.dataset.betterldSource = "true";
    container.dataset.betterldWasHidden = String(originallyHidden);
    container.dataset.betterldSignature = currentSignature;
    container.hidden = true;
    container.after(grid);
    state.managedSources.set(container, grid);
  }

  function syncHomepage() {
    if (!isHomepage()) {
      restoreAll();
      return;
    }

    applyColorMode();
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
    const home = isHomepage();
    document.documentElement.classList.toggle("betterld-home", home);
    document.body?.classList.toggle("betterld-home", home);
    applyColorMode();
    if (home) {
      scheduleSync();
    } else {
      restoreAll();
    }
  }

  function checkRoute() {
    if (location.href === state.currentHref) {
      return;
    }
    state.currentHref = location.href;
    updateRouteState();
  }

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

  applyVisualSettings(config.settingsDefaults);
  storageGet()
    .then((stored) => applyVisualSettings(stored[config.storageKey]))
    .catch((error) => {
      console.error("[betterLD] settings load failed; using defaults", error);
      applyVisualSettings(config.settingsDefaults);
    });

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[config.storageKey]) {
      applyVisualSettings(changes[config.storageKey].newValue);
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
  modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-color-scheme", "data-theme"] });
  if (document.body) {
    modeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-color-scheme", "data-theme"] });
  }

  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  state.currentHref = location.href;
  updateRouteState();
  window.setInterval(checkRoute, config.routePollMs);
})();
