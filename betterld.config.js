const wallpaperModes = Object.freeze({
  none: "none",
  random: "random",
  builtin: "builtin",
  url: "url",
  local: "local"
});

// 空值表示不写 order 参数，即 LinuxDo 默认的最后回复（bumped_at）倒序
const topicSortOrders = Object.freeze({
  activity: "",
  created: "created"
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
  userProfilePath: "/u/",
  topicSortOrderParam: "order",
  topicSortOrders,
  routePollMs: 500,
  syncDebounceMs: 160,
  syncQuotaBytes: 102400,
  settingsCommitDelayMs: 220,
  settingsSearchResultLimit: 12,
  settingsSearchHighlightMs: 2400,
  fontRecommendedStack: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  listControlsScrollThreshold: 8,
  scrollTopThreshold: 16,
  excerptRootMargin: "0px",
  excerptDwellMs: 400,
  excerptStoragePrefix: "betterld.excerpt.v1.",
  excerptCacheTtlMs: 24 * 60 * 60 * 1000,
  excerptCacheMaxEntries: 500,
  excerptMaxCharacters: 2400,
  excerptLoadingLabel: "正在读取正文预览…",
  excerptPlaceholder: "正文预览暂不可用",
  excerptEmptyLabel: "正文为空",
  authorLoadingLabel: "作者信息加载中…",
  authorPlaceholder: "作者信息暂不可用",
  topicRequestMinIntervalMs: 500,
  topicRequestWindowMs: 3000,
  topicRequestMaxPerWindow: 6,
  replyTreePageSize: 20,
  replyTreeLoadAheadPx: 400,
  replyTreeTimeRefreshMs: 60000,
  replyTreeDeepLinkDelayMs: 1200,
  replyTreeActionTimeoutMs: 8000,
  replyTreeReactionHoldMs: 500,
  replyTreeReactionHoverMs: 400,
  replyTreeReactionUsersPageSize: 30,
  replyTreeReactionSummaryLimit: 3,
  replyTreeEmojiBaseUrl: "https://cdn.ldstatic.com/images/emoji/",
  replyTreeCustomEmojiUrls: Object.freeze({
    tieba_087: "https://cdn3.ldstatic.com/original/3X/2/e/2e09f3a3c7b27eacbabe9e9614b06b88d5b06343.png?v=15",
    bili_057: "https://cdn3.ldstatic.com/original/3X/1/a/1a9f6c30e88a7901b721fffc1aaeec040f54bdf3.png?v=15"
  }),
  pageRefreshMinIntervalMs: 3000,
  pageRefreshTimeoutMs: 30000,
  topicRequestCooldownMs: 15000,
  topicChallengeCooldownMs: 600000,
  topicRequestRecoveryCount: 1,
  topicRequestRecoveryDelayMs: 10000,
  undoRefreshStorageKey: "betterld.undo-refresh",
  undoRefreshSnapshotMaxBytes: 700000,
  undoRefreshSnapshotTtlMs: 600000,
  refreshScrollTopStorageKey: "betterld.refresh-scroll-top",
  refreshScrollTopWindowMs: 2500,
  searchLoadMoreTimeoutMs: 8000,
  searchNoMoreLabels: ["没有找到更多结果", "没有更多结果", "No more results"],
  searchHistoryPanelMaxItems: 8,
  listRefreshScrollTopWindowMs: 10000,
  visitedTopicStorageKey: "betterld.visited-topics",
  visitedTopicMaxEntries: 500,
  versionCheckUrl: "https://api.github.com/repos/xMuelsysex/betterLD/releases/latest",
  topicCardMotion: Object.freeze({
    durationMs: 200,
    easing: "ease",
    spreadPx: 6,
    hoverOpacity: 0.2,
    activeOpacity: 0.3
  }),
  topicPreview: Object.freeze({
    aspectRatio: 4 / 3,
    viewportArea: 0.7,
    marginPx: 16,
    loadTimeoutMs: 8000
  }),
  storageKey: "betterld.settings",
  syncMetadataKey: "betterld.sync-meta",
  wallpaperLocalStorageKey: "betterld.local-wallpaper",
  wallpaperRemoteCacheKey: "betterld.remote-wallpaper-cache",
  wallpaperRandomSeedPattern: "https://picsum.photos/seed/{date}/2560/1440/?nature",
  wallpaperColorSampleSize: 32,
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
  themeCatalog: Object.freeze([
    {
      id: "material-purple",
      name: "Material Purple",
      lightPrimary: "#6750a4",
      darkPrimary: "#d0bcff",
      lightOnPrimary: "#ffffff",
      darkOnPrimary: "#381e72"
    },
    {
      id: "ocean-blue",
      name: "Ocean Blue",
      lightPrimary: "#315f90",
      darkPrimary: "#a8c8f0",
      lightOnPrimary: "#ffffff",
      darkOnPrimary: "#12304f"
    },
    {
      id: "forest-green",
      name: "Forest Green",
      lightPrimary: "#386a20",
      darkPrimary: "#9dd67e",
      lightOnPrimary: "#ffffff",
      darkOnPrimary: "#17380b"
    },
    {
      id: "sunset-orange",
      name: "Sunset Orange",
      lightPrimary: "#8b5000",
      darkPrimary: "#ffb95c",
      lightOnPrimary: "#ffffff",
      darkOnPrimary: "#472900"
    }
  ]),
  gridBreakpoints: Object.freeze({
    base: 0,
    sm: 560,
    md: 800,
    lg: 1100,
    xl: 1400,
    xxl: 1800
  }),
  topicNavigationItems: Object.freeze([
    "latest",
    "new",
    "unread",
    "hot",
    "top",
    "posted",
    "read",
    "bookmarks",
    "categories"
  ]),
  topicCardContextMenuActions: Object.freeze([
    "openCurrentTab",
    "openNewTab",
    "openBackground",
    "openDrawer",
    "copyTopicUrl",
    "copyCleanUrl",
    "copyTopicId",
    "openCategory",
    "openAuthor",
    "ignoreAuthor"
  ]),
  actionRailItems: Object.freeze(["settings", "theme", "layout"]),
  // 返回顶部与刷新固定在操作栏尾部，它们的显隐分别只由对应的开关决定
  actionRailTailOrder: 90,
  settingsEnums: Object.freeze({
    themeMode: Object.freeze(["auto", "system", "light", "dark", "scheduled"]),
    fontMode: Object.freeze(["default", "recommended", "custom"]),
    fontScope: Object.freeze(["own", "managed"]),
    shadowMode: Object.freeze(["default", "none", "custom"]),
    gridMode: Object.freeze(["auto", "fixed"]),
    topicListLayoutMode: Object.freeze(["reading", "cards", "native"]),
    replyTreeNameMode: Object.freeze(["both", "nickname", "username"]),
    topicSortMode: Object.freeze(Object.keys(topicSortOrders)),
    topicTitleFontSize: Object.freeze(["responsive", "small", "base", "large"]),
    topicAuthorFontSize: Object.freeze(["small", "base", "large"]),
    topicMetaFontSize: Object.freeze(["small", "base", "large"]),
    topicNavigationAlignment: Object.freeze(["left", "center"]),
    headerVisualMode: Object.freeze(["native", "transparent", "frosted", "solid"]),
    sidebarPosition: Object.freeze(["original", "right"]),
    actionRailPosition: Object.freeze(["left", "right", "bottom"]),
    actionRailVisibility: Object.freeze(["always", "auto", "hidden"]),
    topicCardOpenMode: Object.freeze(["currentTab", "newTab", "background", "drawer"]),
    navigationOpenMode: Object.freeze(["currentTab", "newTab", "background", "currentTabIfHomepage", "currentTabIfNotHomepage"]),
    searchOpenMode: Object.freeze(["currentTab", "newTab", "background", "currentTabIfHomepage", "currentTabIfNotHomepage"]),
    notificationOpenMode: Object.freeze(["page", "newTab"]),
    topicFilterMode: Object.freeze(["hide", "dim", "highlight", "include"]),
    topicFilterMatchMode: Object.freeze(["contains", "whole", "regex"]),
    searchMode: Object.freeze(["native", "cards"]),
    searchResultsPaginationMode: Object.freeze(["scroll", "pagination"]),
    searchPageWallpaperMode: Object.freeze(["inherit", "builtin", "url"]),
    touchOptimization: Object.freeze(["auto", "on", "off"]),
    language: Object.freeze(["zh-CN", "en-US"]),
    wallpaperRemoteCacheDays: Object.freeze([0, 1, 7, 30])
  }),
  // 主题过滤的规则组顺序即设置窗口里的展示顺序；白名单最后且优先级最高
  // 服务端屏蔽使用 Discourse 的 notification_level 接口，过期时间给一个远期值即相当于永久
  discourseIgnoreExpiringAt: "3026-08-01 08:00+08:00",
  topicRuleGroups: Object.freeze([
    { key: "topicTitleRules", title: "标题规则", empty: "暂无标题规则", help: "匹配主题标题。" },
    { key: "topicCategoryRules", title: "分类规则", empty: "暂无分类规则", help: "匹配主题所属分类名称。" },
    { key: "topicTagRules", title: "标签规则", empty: "暂无标签规则", help: "匹配主题标签；分类页面行内可能不渲染标签。" },
    { key: "topicAuthorRules", title: "作者规则", empty: "暂无作者规则", help: "主题列表匹配创建者；搜索阅读卡匹配搜索命中帖的作者，直接使用搜索结果，不额外请求。" },
    { key: "topicWhitelistRules", title: "白名单规则", empty: "暂无白名单规则", help: "命中白名单的主题永远不参与过滤。" }
  ]),
  settingsCategories: Object.freeze([
    {
      id: "general",
      title: "常规",
      icon: "settings",
      subcategories: [
        {
          id: "theme",
          title: "主题",
          description: "跟随 LinuxDo 或系统偏好的明暗模式，以及 betterLD 自有主题色。",
          keys: [
            "language",
            "themeMode",
            "themeScheduleStart",
            "themeScheduleEnd",
            "themeColor",
            "wallpaperThemeColor",
            "darkModeBaseColor",
            "useGradientThemeColorBackground",
            "liquidSegmentIndicatorEnabled"
          ]
        },
        {
          id: "surface",
          title: "表面与毛玻璃",
          description: "betterLD 自有卡片、菜单和面板的表面效果。",
          keys: ["frostedGlassEnabled", "surfaceBlurPx", "sidebarCoverBlurEnabled", "userCardCoverMaskEnabled", "userCardCoverMaskOpacity", "shadowMode", "shadowHeight"]
        },
        {
          id: "font",
          title: "字体与文本",
          description: "字体来源与中文排版。",
          keys: ["fontMode", "fontScope", "fontFamily", "removeChinesePunctuationIndent"]
        },
        {
          id: "behavior",
          title: "页面行为",
          description: "触屏目标与横向滚动的范围。",
          keys: ["touchOptimization", "enableHorizontalNavigationScroll", "showHomeButtonInTouchMode"]
        }
      ]
    },
    {
      id: "pages",
      title: "页面",
      icon: "pages",
      subcategories: [
        {
          id: "card",
          title: "主题卡片",
          description: "主题信息流的卡片形式、网格、内容显隐与字号。",
          keys: [
            "topicListLayoutMode",
            "topicSortMode",
            "gridMode",
            "cardMinSize",
            "cardSideGutter",
            "gridGap",
            "showTopicAvatar",
            "showTopicAuthor",
            "showTopicCategory",
            "showTopicExcerpt",
            "showTopicTags",
            "showTopicMeta",
            "showTopicActivityTime",
            "showTopicReplies",
            "showTopicLikes",
            "showTopicViews",
            "showTopicUnreadState",
            "showTopicPinnedState",
            "showTopicWatchedState",
            "topicTitleFontSize",
            "topicAuthorFontSize",
            "topicMetaFontSize"
          ]
        },
        {
          id: "replyTree",
          title: "树状回复",
          description: "主题回复树中作者昵称与用户名的显示方式。",
          keys: ["replyTreeNameMode"]
        },
        {
          id: "filter",
          title: "筛选",
          description: "只影响 betterLD 生成的卡片，不改变 LinuxDo 原始查询与分页。",
          keys: ["topicFilterEnabled", "topicFilterMode", "topicFilterMatchMode", "topicFilterMaxAgeDays", "topicFilterHideLv1", "topicFilterHideLv2", "topicFilterHideLv3", "topicFilterBinEnabled"]
        },
        {
          id: "search",
          title: "搜索",
          description: "搜索页能力需经真实页面确认，未确认前保存后不生效。",
          keys: [
            "searchMode",
            "searchHistoryEnabled",
            "searchHistoryPanelEnabled",
            "searchRecommendationEnabled",
            "searchFocusDimming",
            "searchFocusBlur",
            "searchResultsPaginationMode",
            "searchPageWallpaperMode",
            "searchPageWallpaperId",
            "searchPageWallpaperUrl"
          ]
        }
      ]
    },
    {
      id: "components",
      title: "组件",
      icon: "components",
      subcategories: [
        {
          id: "navigation",
          title: "主题导航",
          description: "保留原站链接与 active 语义，只改变排列与可见性。",
          keys: ["topicNavigationAlignment", "topicNavigationSticky", "showTopicNavigationCounts"]
        },
        {
          id: "shell",
          title: "Header 与 Sidebar",
          description: "覆盖已确认的原生壳层 surface，不重建原站导航内容。",
          keys: [
            "headerVisible",
            "headerVisualMode",
            "autoHideHeader",
            "sidebarPosition",
            "autoHideSidebar",
            "showSettingsTrigger",
            "showThemeToggle",
            "siteLogoVisible",
            "siteLogoOutline",
            "siteLogoGlow"
          ]
        },
        {
          id: "actionRail",
          title: "浮动操作",
          description: "betterLD 自有的浮动操作栏、返回顶部与刷新入口。",
          keys: [
            "actionRailEnabled",
            "actionRailPosition",
            "actionRailVisibility",
            "actionRailGlow",
            "showBackToTopButton",
            "showRefreshButton",
            "separateNavigationActions",
            "enableUndoRefresh"
          ]
        },
        {
          id: "interaction",
          title: "打开方式与抽屉",
          description: "保留浏览器原生的修饰键点击与键盘行为。",
          keys: [
            "topicCardOpenMode",
            "navigationOpenMode",
            "searchOpenMode",
            "notificationOpenMode",
            "drawerCloseOnOverlay",
            "drawerCloseOnEscape"
          ]
        }
      ]
    },
    {
      id: "appearance",
      title: "外观",
      icon: "appearance",
      subcategories: [
        {
          id: "wallpaper",
          title: "壁纸",
          description: "网站随机图片、内置图片与自定义图片三类来源。",
          keys: ["wallpaperMode", "wallpaper", "wallpaperId", "wallpaperUrl", "wallpaperLocalId"]
        },
        {
          id: "effect",
          title: "页面效果",
          description: "壁纸之上的遮罩、模糊与卡片透明度。",
          keys: ["maskOpacity", "blurPx", "cardOpacity"]
        },
        {
          id: "customCss",
          title: "自定义 CSS",
          description: "只允许命中 betterLD 自有命名空间的规则。",
          keys: ["customCssEnabled", "customCss"]
        }
      ]
    },
    {
      id: "shortcuts",
      title: "快捷键",
      icon: "keyboard",
      subcategories: [
        {
          id: "shortcuts",
          title: "按键",
          description: "输入框、编辑器和可编辑元素聚焦时不触发。",
          keys: ["shortcutsEnabled"]
        }
      ]
    },
    {
      id: "advanced",
      title: "高级",
      icon: "advanced",
      subcategories: [
        {
          id: "maintenance",
          title: "同步与缓存",
          description: "浏览器同步只投影设置，不包含本地壁纸正文、搜索历史与 WebDAV 凭据。",
          keys: ["syncEnabled", "wallpaperRemoteCacheDays", "webdavUrl", "webdavUsername", "webdavPassword"]
        },
        {
          id: "data",
          title: "导入与导出",
          description: "导出内容不包含本地壁纸正文、账号信息或页面内容。",
          keys: []
        },
        {
          id: "reset",
          title: "恢复默认",
          description: "恢复默认会立即覆盖当前全部设置。",
          keys: []
        }
      ]
    },
    {
      id: "about",
      title: "关于",
      icon: "about",
      subcategories: [
        {
          id: "about",
          title: "关于",
          description: "版本、运行环境与项目链接。",
          keys: []
        }
      ]
    }
  ]),
  settingsDefaults: Object.freeze({
    ...wallpaperDefaults,
    settingsVersion: 2,
    language: "zh-CN",
    maskOpacity: 0.42,
    blurPx: 18,
    cardOpacity: 0.82,
    themeMode: "auto",
    themeScheduleStart: "18:00",
    themeScheduleEnd: "07:00",
    themeColor: "#6750a4",
    wallpaperThemeColor: true,
    darkModeBaseColor: "#141218",
    useGradientThemeColorBackground: false,
    liquidSegmentIndicatorEnabled: false,
    frostedGlassEnabled: true,
    sidebarCoverBlurEnabled: true,
    userCardCoverMaskEnabled: true,
    userCardCoverMaskOpacity: 0.78,
    surfaceBlurPx: 16,
    shadowMode: "default",
    shadowHeight: 1,
    shadowCurve: [
      { position: 0, opacity: 0.12 },
      { position: 0.5, opacity: 0.08 },
      { position: 1, opacity: 0 }
    ],
    fontMode: "default",
    fontScope: "own",
    fontFamily: "",
    removeChinesePunctuationIndent: false,
    customCssEnabled: false,
    customCss: "",
    wallpaperRemoteCacheDays: 0,
    gridMode: "auto",
    cardMinSize: 280,
    cardSideGutter: 24,
    gridGap: 16,
    gridColumns: {
      base: 1,
      sm: 2,
      md: 3,
      lg: 4,
      xl: 5,
      xxl: 6
    },
    showTopicAvatar: true,
    showTopicAuthor: true,
    showTopicCategory: true,
    showTopicExcerpt: true,
    showTopicTags: true,
    showTopicMeta: true,
    showTopicActivityTime: true,
    showTopicReplies: true,
    showTopicLikes: true,
    showTopicViews: true,
    showTopicUnreadState: true,
    showTopicPinnedState: true,
    showTopicWatchedState: true,
    topicListLayoutMode: "reading",
    replyTreeNameMode: "both",
    topicSortMode: "activity",
    topicCardContextMenuConfig: [
      { key: "openCurrentTab", visible: true, order: 0 },
      { key: "openNewTab", visible: true, order: 1 },
      { key: "copyTopicUrl", visible: true, order: 2 },
      { key: "copyTopicId", visible: true, order: 3 }
    ],
    topicTitleFontSize: "responsive",
    topicAuthorFontSize: "base",
    topicMetaFontSize: "base",
    topicNavigationConfig: [],
    topicNavigationAlignment: "left",
    topicNavigationSticky: true,
    showTopicNavigationCounts: true,
    headerVisible: true,
    headerVisualMode: "native",
    autoHideHeader: false,
    sidebarPosition: "original",
    autoHideSidebar: false,
    showSettingsTrigger: true,
    showThemeToggle: true,
    siteLogoVisible: true,
    siteLogoOutline: false,
    siteLogoGlow: false,
    actionRailEnabled: false,
    actionRailPosition: "right",
    actionRailVisibility: "auto",
    actionRailGlow: true,
    actionRailItemsConfig: [
      { key: "settings", visible: true, order: 0 },
      { key: "layout", visible: true, order: 1 },
      { key: "theme", visible: false, order: 2 }
    ],
    showBackToTopButton: false,
    showRefreshButton: false,
    separateNavigationActions: true,
    enableUndoRefresh: false,
    topicCardOpenMode: "currentTab",
    navigationOpenMode: "currentTab",
    searchOpenMode: "currentTab",
    notificationOpenMode: "page",
    drawerCloseOnOverlay: true,
    drawerCloseOnEscape: true,
    topicFilterEnabled: false,
    topicFilterMode: "hide",
    topicFilterMatchMode: "contains",
    topicFilterMaxAgeDays: 0,
    topicFilterHideLv1: false,
    topicFilterHideLv2: false,
    topicFilterHideLv3: false,
    topicFilterBinEnabled: true,
    topicTitleRules: [],
    topicAuthorRules: [],
    topicCategoryRules: [],
    topicTagRules: [],
    topicWhitelistRules: [],
    searchMode: "native",
    searchHistoryEnabled: false,
    searchHistoryPanelEnabled: false,
    searchRecommendationEnabled: false,
    searchFocusDimming: false,
    searchFocusBlur: false,
    searchResultsPaginationMode: "scroll",
    searchPageWallpaperMode: "inherit",
    searchPageWallpaperId: "",
    searchPageWallpaperUrl: "",
    searchHistory: [],
    touchOptimization: "auto",
    enableHorizontalNavigationScroll: true,
    showHomeButtonInTouchMode: true,
    shortcutsEnabled: false,
    shortcuts: {
      refreshTopics: "R",
      openSettings: "",
      toggleListControls: ""
    },
    syncEnabled: false,
    webdavUrl: "",
    webdavUsername: "",
    webdavPassword: ""
  }),
  settingsLimits: Object.freeze({
    maskOpacity: Object.freeze({ min: 0, max: 0.8, step: 0.01 }),
    blurPx: Object.freeze({ min: 0, max: 32, step: 1 }),
    cardOpacity: Object.freeze({ min: 0.55, max: 0.95, step: 0.01 }),
    surfaceBlurPx: Object.freeze({ min: 0, max: 32, step: 1 }),
    userCardCoverMaskOpacity: Object.freeze({ min: 0, max: 1, step: 0.01 }),
    shadowHeight: Object.freeze({ min: 0, max: 2, step: 0.1 }),
    shadowCurveOpacity: Object.freeze({ min: 0, max: 1, step: 0.01 }),
    cardMinSize: Object.freeze({ min: 240, max: 480, step: 8 }),
    cardSideGutter: Object.freeze({ min: 16, max: 48, step: 4 }),
    gridGap: Object.freeze({ min: 8, max: 32, step: 4 }),
    gridColumn: Object.freeze({ min: 1, max: 12, step: 1 }),
    fontFamily: Object.freeze({ maxLength: 200 }),
    customCss: Object.freeze({ maxLength: 64 * 1024 }),
    ruleKeyword: Object.freeze({ maxLength: 200 }),
    ruleRemark: Object.freeze({ maxLength: 200 }),
    ruleCount: Object.freeze({ max: 64 }),
    topicFilterMaxAgeDays: Object.freeze({ min: 0, max: 3650, step: 1 }),
    webdavUsername: Object.freeze({ maxLength: 200 }),
    webdavPassword: Object.freeze({ maxLength: 200 }),
    webdavUrl: Object.freeze({ maxLength: 2048 }),
    shortcut: Object.freeze({ maxLength: 24 }),
    searchHistory: Object.freeze({ maxItems: 50, maxLength: 200 })
  })
});