(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const api = globalThis.browser || globalThis.chrome;
  const firefoxApi = Boolean(globalThis.browser);

  if (!config || !api) {
    throw new Error("betterLD settings could not initialize: extension API is unavailable");
  }

  const form = document.querySelector("#settings-form");
  const wallpaper = document.querySelector("#wallpaper");
  const maskOpacity = document.querySelector("#mask-opacity");
  const blur = document.querySelector("#blur");
  const cardOpacity = document.querySelector("#card-opacity");
  const maskOpacityValue = document.querySelector("#mask-opacity-value");
  const blurValue = document.querySelector("#blur-value");
  const cardOpacityValue = document.querySelector("#card-opacity-value");
  const reset = document.querySelector("#reset");
  const status = document.querySelector("#status");

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

  function clamp(value, limits) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(limits.max, Math.max(limits.min, number)) : limits.min;
  }

  function normalizeWallpaper(value) {
    const input = String(value || "").trim();
    if (!input) {
      return "";
    }

    const url = new URL(input);
    if (url.protocol !== "https:") {
      throw new Error("背景图片必须使用 HTTPS 地址");
    }
    return url.href;
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

  function populate(value) {
    const settings = normalizeSettings(value);
    wallpaper.value = settings.wallpaper;
    maskOpacity.value = String(settings.maskOpacity);
    blur.value = String(settings.blurPx);
    cardOpacity.value = String(settings.cardOpacity);
    updateOutputs();
  }

  function readForm() {
    return normalizeSettings({
      wallpaper: normalizeWallpaper(wallpaper.value),
      maskOpacity: maskOpacity.value,
      blurPx: blur.value,
      cardOpacity: cardOpacity.value
    });
  }

  async function save(value) {
    await storageSet({ [config.storageKey]: value });
    status.textContent = "设置已保存";
  }

  setRangeAttributes(maskOpacity, config.settingsLimits.maskOpacity);
  setRangeAttributes(blur, config.settingsLimits.blurPx);
  setRangeAttributes(cardOpacity, config.settingsLimits.cardOpacity);
  maskOpacity.addEventListener("input", updateOutputs);
  blur.addEventListener("input", updateOutputs);
  cardOpacity.addEventListener("input", updateOutputs);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
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
    try {
      await save(normalizeSettings(config.settingsDefaults));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "默认设置保存失败";
      console.error("[betterLD] default settings save failed", error);
    }
  });

  storageGet()
    .then((stored) => populate(stored[config.storageKey]))
    .catch((error) => {
      populate(config.settingsDefaults);
      status.textContent = "读取设置失败，当前显示默认值";
      console.error("[betterLD] settings load failed", error);
    });
})();
