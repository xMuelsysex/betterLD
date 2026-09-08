globalThis.BETTERLD_CONFIG = Object.freeze({
  homepagePath: "/",
  routePollMs: 500,
  syncDebounceMs: 160,
  excerptRootMargin: "240px 0px",
  excerptMaxCharacters: 2400,
  excerptLoadingLabel: "正在读取正文预览…",
  excerptPlaceholder: "正文预览暂不可用",
  cardMinSize: 280,
  cardSideGutter: 175,
  gridGap: 16,
  storageKey: "betterld.settings",
  settingsDefaults: Object.freeze({
    wallpaper: "",
    maskOpacity: 0.42,
    blurPx: 18,
    cardOpacity: 0.82
  }),
  settingsLimits: Object.freeze({
    maskOpacity: Object.freeze({ min: 0, max: 0.8, step: 0.01 }),
    blurPx: Object.freeze({ min: 0, max: 32, step: 1 }),
    cardOpacity: Object.freeze({ min: 0.55, max: 0.95, step: 0.01 })
  })
});
