(() => {
  "use strict";

  if (window !== window.top && !window.frameElement?.matches("iframe[data-betterld-topic-preview]")) return;

  const config = globalThis.BETTERLD_CONFIG;
  const settingsApi = globalThis.BETTERLD_SETTINGS;
  const appearance = globalThis.BETTERLD_APPEARANCE;
  const api = globalThis.browser || globalThis.chrome;

  function storageGet(area, keys) {
    if (globalThis.browser) return api.storage[area].get(keys);
    return new Promise((resolve, reject) => {
      api.storage[area].get(keys, (value) => {
        const error = api.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(value);
      });
    });
  }

  async function readActiveSettings(localSettings) {
    const settings = settingsApi.normalizeSettings(localSettings);
    if (settings.syncEnabled) {
      try {
        if (!api.storage.sync?.get) throw new Error("浏览器不支持 storage.sync");
        const stored = await storageGet("sync", [config.storageKey]);
        const remote = stored[config.storageKey];
        if (remote && typeof remote === "object") {
          return { settings: settingsApi.normalizeSettings(remote), area: "sync" };
        }
      } catch (error) {
        console.error("[betterLD] active sync settings read failed; using local settings", error);
      }
    }
    return { settings, area: "local" };
  }

  function prepareAppearance({ settings }) {
    appearance.apply(settings);
    // body 由解析器创建后就启用既有壳层，不等页面资源或主增强脚本。
    if (document.body) document.body.classList.add("betterld-shell");
    else {
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        document.body.classList.add("betterld-shell");
      });
      observer.observe(document.documentElement, { childList: true });
    }
  }

  const ready = storageGet("local", [
    config.storageKey, config.wallpaperLocalStorageKey,
    config.wallpaperRemoteCacheKey, config.topicRequestCooldownStorageKey
  ]).then(async (stored) => ({ stored, ...await readActiveSettings(stored[config.storageKey]) }))
    .catch((error) => {
      console.error("[betterLD] settings load failed; using defaults", error);
      return { stored: {}, settings: settingsApi.normalizeSettings(config.settingsDefaults), area: "local", error };
    });

  // 主增强直接消费这次读取；不再次读取设置，也不先按默认设置增强整页。
  globalThis.BETTERLD_STARTUP = Object.freeze({ ready, readActiveSettings });
  ready.then(prepareAppearance).catch((error) => console.error("[betterLD] early appearance failed", error));
})();
