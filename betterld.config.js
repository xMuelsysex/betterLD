const wallpaperModes = Object.freeze({
  none: "none",
  random: "random",
  builtin: "builtin",
  url: "url",
  local: "local"
});

const wallpaperDefaults = Object.freeze({
  wallpaper: "",
  wallpaperMode: wallpaperModes.none,
  wallpaperId: "",
  wallpaperUrl: "",
  wallpaperLocalId: "",
  wallpaperRandomDate: "",
  wallpaperRandomUrl: ""
});

globalThis.BETTERLD_CONFIG = Object.freeze({
  homepagePath: "/",
  routePollMs: 500,
  syncDebounceMs: 160,
  excerptRootMargin: "240px 0px",
  excerptMaxCharacters: 2400,
  excerptLoadingLabel: "正在读取正文预览…",
  excerptPlaceholder: "正文预览暂不可用",
  cardMinSize: 280,
  cardSideGutter: 24,
  gridGap: 16,
  storageKey: "betterld.settings",
  wallpaperLocalStorageKey: "betterld.local-wallpaper",
  wallpaperRandomSeedPattern: "https://picsum.photos/seed/{date}/2560/1440/?nature",
  wallpaperUpload: Object.freeze({
    maxWidth: 2560,
    maxHeight: 1440,
    quality: 0.9,
    maxBytes: 8 * 1024 * 1024
  }),
  wallpaperModes,
  wallpaperCatalog: Object.freeze([
    {
      id: "lorem-picsum-random",
      mode: wallpaperModes.random,
      name: "LoremPicsum Random Image",
      url: "https://picsum.photos/2560/1440/?nature",
      thumbnail: "https://picsum.photos/2560/1440/?nature"
    },
    {
      id: "rocky-mountain-cloudscape",
      mode: wallpaperModes.builtin,
      name: "Nicolas Lafargue - Rocky Mountain Cloudscape",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/rocky-mountain-cloudscape.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/rocky-mountain-cloudscape-thumbnail.jpg"
    },
    {
      id: "green-white-mountains",
      mode: wallpaperModes.builtin,
      name: "Zongnan Bao- Green white mountains",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/green-white-mountains.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/green-white-mountains-thumbnail.jpg"
    },
    {
      id: "night-sky-stars",
      mode: wallpaperModes.builtin,
      name: "Colin Watts - Night Sky Stars",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/night-sky-stars.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/night-sky-stars-thumbnail.jpg"
    },
    {
      id: "sailboats-at-exumas",
      mode: wallpaperModes.builtin,
      name: "Ryan Geller - Sailboats moored at Land and Sea Park in The Exumas",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/sailboats-moored-at-the-exumas.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/sailboats-moored-at-the-exumas-thumbnail.jpg"
    },
    {
      id: "outer-space-photo",
      mode: wallpaperModes.builtin,
      name: "NASA - Outer Space Photo",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/outer-space-photo.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/outer-space-photo-thumbnail.jpg"
    },
    {
      id: "bml2019-vr",
      mode: wallpaperModes.builtin,
      name: "BML2019 VR (pid: 74271400)",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/bml2019-vr.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/bml2019-vr-thumbnail.jpg"
    },
    {
      id: "2020-new-year-festival",
      mode: wallpaperModes.builtin,
      name: "2020 拜年祭活动",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/2020-拜年祭活动.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/2020-拜年祭活动-thumbnail.jpg"
    },
    {
      id: "2020-bdf",
      mode: wallpaperModes.builtin,
      name: "2020 BDF",
      url: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/2020-bdf.jpg",
      thumbnail: "https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/wallpapers/2020-bdf-thumbnail.jpg"
    }
  ]),
  wallpaperDefaults,
  settingsDefaults: Object.freeze({
    ...wallpaperDefaults,
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
