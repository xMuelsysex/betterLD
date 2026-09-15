# betterLD 非 Bilibili 专属设置复用设计

- **状态**：设计范围已确定，待分阶段实现
- **日期**：2026-09-12
- **目标项目**：betterLD
- **参考项目**：BewlyCat `main` 分支设置页与设置存储模型
- **本轮交付**：设计文档，不修改运行时代码

## 1. 背景与目标

betterLD 已经将 LinuxDo 的首页、主题列表、分类页和标签页部分内容改造成 Material 3 风格，并提供壁纸、遮罩、背景模糊和卡片透明度设置。BewlyCat 的设置页还包含卡片布局、内容显隐、链接打开、过滤、主题、响应式、快捷键、备份和自定义外观等与 Bilibili 业务无关的能力。

本设计将这些通用能力映射到 LinuxDo 页面，同时保持 betterLD 的核心边界：

1. 继续使用无依赖、无构建步骤的 Manifest V3 静态扩展。
2. 继续保留 Discourse 原有 DOM、链接、路由和权限行为；只对确定的视觉与交互边界做可恢复覆盖。
3. 配置默认值、取值范围和壁纸目录仍由 `betterld.config.js` 统一维护。
4. 用户设置只保存到 `betterld.settings`，本地壁纸继续单独保存到 `betterld.local-wallpaper`。
5. 所有设置都经过同一个规范化和校验入口，避免 options 页、content script 和导入逻辑出现第二套事实来源。
6. 主题自动判定只读取 LinuxDo 的主题状态、计算样式和系统偏好，不写入扩展自己的 `color-scheme`，避免主题反馈回路。

## 2. 不在范围内的能力

以下能力与 Bilibili 页面、Bilibili API、播放器或 Bilibili 账号模型绑定，本设计明确排除：

- Bilibili 推荐模式、Web/App 授权、Cookie 和 Access Key。
- Bilibili 动态页、UP 主关注/置顶、动态类型和动态卡片。
- 视频播放器、弹幕、字幕、倍速、画面比例、自动连播、画中画和播放器快捷键。
- Bilibili 评论 IP、性别、楼主标识、回复树和评论分页。
- B 币券、VIP 经验、创作中心、上传和通知数量 Badge。
- Bilibili 顶栏 Logo、频道、收藏、历史、稍后再看和原站/插件页切换。
- Bilibili 搜索热搜、搜索聚焦角色图、BVID/AV 号和视频链接清理。
- Bilibili 视频封面比例、视频预览、视频卡片操作菜单。

这些能力可以继续作为 BewlyCat 源码审计中的排除项，不进入 betterLD 的设置数据模型。

## 3. 范围总览

标记含义：

- **已存在**：betterLD 已经具备，设计只规定兼容和扩展边界。
- **纳入**：本设计要求实现。
- **条件纳入**：设计纳入，但依赖对应 LinuxDo 页面或 DOM 边界先确认。
- **排除**：Bilibili 专属或与当前产品目标冲突。


| 编号   | 能力                        | 来源设置族             | 状态   | 目标页面        |
| ---- | ------------------------- | ----------------- | ---- | ----------- |
| V-01 | 壁纸来源、每日随机、本地上传、失败回退       | Appearance        | 已存在  | 已管理页面       |
| V-02 | 自动 / 系统 / 手动主题            | Appearance        | 纳入   | 已管理页面       |
| V-03 | 主题色、深色基色、渐变背景             | Appearance        | 纳入   | 已管理页面       |
| V-04 | 毛玻璃开关、表面模糊、阴影             | Appearance        | 纳入   | 已管理页面       |
| V-05 | 字体偏好和安全的自定义 CSS           | Appearance        | 纳入   | 已管理页面       |
| V-06 | 壁纸远程缓存策略                  | Appearance        | 纳入   | 远程壁纸        |
| C-01 | 网格模式、最小卡宽、间距、断点列数         | Video Card        | 纳入   | 主题列表页       |
| C-02 | 作者、头像、分类、摘要、元信息显隐         | Video Card        | 纳入   | 主题卡片        |
| C-03 | 卡片字号、阴影模式、阴影高度和曲线         | Video Card        | 纳入   | 主题卡片        |
| C-04 | 卡片操作菜单、复制链接、复制主题 ID       | Video Card        | 纳入   | 主题卡片        |
| C-05 | 视频封面比例、视频预览、视频布局          | Video Card        | 排除   | Bilibili 专属 |
| N-01 | 主题导航项目显隐、排序、对齐、固定         | Home / Navigation | 纳入   | 首页和主题列表页    |
| N-02 | 原生 Header 透明 / 毛玻璃 / 自动隐藏 | TopBar            | 条件纳入 | 已管理页面       |
| N-03 | 原生 Sidebar 位置、自动隐藏        | Dock / Sidebar    | 条件纳入 | 宽屏已管理页面     |
| N-04 | 浮动设置入口显隐、返回顶部和刷新操作        | Dock / General    | 纳入   | 已管理页面       |
| N-05 | 通用浮动操作栏的位置、自动隐藏、半隐藏和发光    | Dock / General    | 纳入   | 已管理页面       |
| O-01 | 主题卡片当前页、新页、后台页、抽屉         | Link Opening      | 纳入   | 主题卡片        |
| O-02 | 抽屉关闭行为                    | Drawer            | 纳入   | 主题卡片抽屉      |
| F-01 | 标题、作者、分类关键词过滤             | Home / Moments    | 纳入   | 主题列表页       |
| F-02 | 动态类型、UP 主、视频统计过滤          | Home / Moments    | 排除   | Bilibili 专属 |
| S-01 | LinuxDo 搜索历史、推荐、聚焦遮罩      | Search            | 条件纳入 | `/search`   |
| S-02 | 搜索结果卡片、滚动 / 分页、搜索页壁纸      | Search            | 条件纳入 | `/search`   |
| R-01 | 触屏目标、导航横向滚动、窄屏布局          | General           | 纳入   | 窄屏 / 移动端    |
| K-01 | 页面刷新、设置入口、控制栏快捷键          | Shortcuts         | 纳入   | 已管理页面       |
| K-02 | 播放器快捷键                    | Shortcuts         | 排除   | Bilibili 专属 |
| M-01 | JSON 导入、导出、恢复默认           | Maintenance       | 纳入   | 设置页         |
| M-02 | `storage.sync` 设置同步       | Maintenance       | 纳入   | 设置页 / 多设备   |
| M-03 | 版本、运行环境、发布页信息             | About             | 纳入   | 设置页         |
| M-04 | Bilibili 云端数据、账号同步        | Maintenance       | 排除   | Bilibili 专属 |
| I-01 | 设置页语言                     | General           | 纳入   | 设置页         |
| I-02 | 设置搜索和分组导航                 | Settings UI       | 纳入   | 设置页         |


## 4. 当前实现基线

### 4.1 配置与存储

- `betterld.config.js` 已维护：
  - `wallpaperModes`：`none`、`random`、`builtin`、`url`、`local`。
  - `settingsDefaults`：壁纸字段、`maskOpacity`、`blurPx`、`cardOpacity`。
  - `settingsLimits`：遮罩 `0–0.8`、背景模糊 `0–32px`、卡片透明度 `0.55–0.95`。
  - `cardMinSize: 280`、`cardSideGutter: 24`、`gridGap: 16`。
- `src/options.html` 当前是原生 HTML 设置页，包含壁纸来源、壁纸目录、远程 URL、本地图片和 3 个视觉滑杆。
- `src/options.js` 当前负责 Chrome callback API 与 Firefox Promise API 的兼容、设置规范化、远程图片探测、本地图片压缩、保存和恢复默认。
- `src/content.js` 当前负责页面主题、壁纸预加载、路由、主题卡片、首帖摘要、作者 JSON 校正、列表控制栏滚动状态和设置入口。
- 当前用户配置键为 `betterld.settings`，本地图片键为 `betterld.local-wallpaper`。

### 4.2 页面和卡片

当前已管理页面包括：

- `/`
- `/latest`、`/new`、`/unread`、`/unseen`、`/hot`、`/top`、`/read`、`/posted`、`/bookmarks`
- `/my/*`
- `/c/<多段 slug>/<id>` 及其列表变体
- `/tag/<slug>[/id][/l/<view>]`
- `/categories`
- `/tags`

主题卡片当前包含：

- 标题
- 首帖纯文本摘要
- 作者
- 作者头像
- 一级分类 Chip
- 主题元信息
- 未读和置顶状态类

作者最终值必须继续来自 `/t/{id}.json` 的 `details.created_by.username`。DOM 中的 `data-user-card` 和 `aria-label` 只负责初始占位，不能回退到最后回复者、头像标题或 `post.username`。

## 5. 设置页信息架构

当设置数量继续增加时，将当前单页表单改为原生 HTML 分组，不引入 Vue、拖拽库或设置组件库。

### 5.1 顶层分组

1. **外观**：主题、壁纸、遮罩、毛玻璃、阴影、字体。
2. **主题卡片**：网格、内容显隐、字号、卡片打开方式。
3. **页面导航**：主题导航、Header、Sidebar、浮动操作。
4. **筛选**：标题、作者、分类规则。
5. **搜索**：仅在 `/search` 能力实现后显示有效设置。
6. **交互**：触屏、横向滚动、抽屉、快捷键。
7. **高级**：自定义 CSS、远程壁纸缓存、实验性页面范围。
8. **备份与同步**：导入、导出、恢复默认、浏览器同步。
9. **关于**：版本、运行环境、项目链接。

### 5.2 设置搜索

- 设置页顶部提供一个原生 `<input type="search">`。
- 每个设置组和设置项带 `data-settings-title`、`data-settings-keywords`。
- 搜索只过滤设置项，不改变设置值，不重新请求页面。
- 搜索结果为空时显示明确空状态，并保留清空按钮。
- 搜索目录由设置项 DOM 元数据生成，不维护第二份可见设置清单。
- 当前设置少于 6 个时可以隐藏搜索和侧栏导航，避免为少量控件增加空壳 UI。

### 5.3 控件规则

- 二值能力使用原生 `checkbox` 或 `switch` 样式。
- 枚举能力使用原生 `select` 或单选组。
- 数值能力使用 `range`，旁边显示当前值和单位。
- 依赖项只在父项启用时显示；禁用父项时子项不参与保存应用。
- 所有控件保留可见 `<label>`、`aria-describedby`、`aria-live` 状态和键盘焦点。
- 破坏性操作使用独立确认，不与普通保存按钮混在一起。

## 6. 统一设置数据模型

以下是逻辑模型。现有壁纸字段保持扁平兼容，新增字段也优先使用稳定、可读的扁平键；结构化数据只用于列配置、导航配置和规则数组。

```js
{
  settingsVersion: 2,
  language: "zh-CN",

  // 现有字段，保持兼容
  wallpaper: "",
  wallpaperMode: "none",
  wallpaperId: "",
  wallpaperUrl: "",
  wallpaperLocalId: "",
  wallpaperRandomDate: "",
  wallpaperRandomUrl: "",
  maskOpacity: 0.42,
  blurPx: 18,
  cardOpacity: 0.82,

  // 外观
  themeMode: "auto",
  themeScheduleStart: "18:00",
  themeScheduleEnd: "07:00",
  themeColor: "#6750a4",
  darkModeBaseColor: "#141218",
  useGradientThemeColorBackground: false,
  liquidSegmentIndicatorEnabled: false,
  frostedGlassEnabled: true,
  sidebarCoverBlurEnabled: true,
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
  applyToUnmanagedPages: false,

  // 主题卡片
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
  showTopicMeta: true,
  showTopicUnreadState: true,
  showTopicPinnedState: true,
  topicListLayoutMode: "cards",
  topicCardContextMenuConfig: [
    { key: "openCurrentTab", visible: true, order: 0 },
    { key: "openNewTab", visible: true, order: 1 },
    { key: "copyTopicUrl", visible: true, order: 2 },
    { key: "copyTopicId", visible: true, order: 3 }
  ],
  topicTitleFontSize: "responsive",
  topicAuthorFontSize: "base",
  topicMetaFontSize: "base",

  // 页面导航和原生壳层
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
  actionRailEnabled: false,
  actionRailPosition: "right",
  actionRailVisibility: "auto",
  actionRailGlow: true,
  actionRailItemsConfig: [
    { key: "settings", visible: true, order: 0 },
    { key: "theme", visible: false, order: 1 },
    { key: "top", visible: false, order: 2 },
    { key: "refresh", visible: false, order: 3 }
  ],
  showBackToTopButton: false,
  showRefreshButton: false,
  separateNavigationActions: true,
  enableUndoRefresh: false,

  // 链接和抽屉
  topicCardOpenMode: "currentTab",
  navigationOpenMode: "currentTab",
  searchOpenMode: "currentTab",
  notificationOpenMode: "page",
  drawerCloseOnOverlay: true,
  drawerCloseOnEscape: true,

  // 主题过滤
  topicFilterEnabled: false,
  topicFilterMode: "hide",
  topicTitleRules: [],
  topicAuthorRules: [],
  topicCategoryRules: [],

  // 搜索页，只有搜索页实现后生效
  searchMode: "native",
  searchHistoryEnabled: false,
  searchRecommendationEnabled: false,
  searchFocusDimming: false,
  searchFocusBlur: false,
  searchResultsPaginationMode: "scroll",
  searchPageWallpaperMode: "inherit",
  searchPageWallpaperId: "",
  searchPageWallpaperUrl: "",

  // 响应式和快捷键
  touchOptimization: "auto",
  enableHorizontalNavigationScroll: true,
  showHomeButtonInTouchMode: true,
  shortcutsEnabled: false,
  shortcuts: {
    refreshTopics: "R",
    openSettings: "",
    toggleListControls: ""
  },

  // 存储
  syncEnabled: false
}
```

### 6.1 默认值和范围


| 键                                | 默认值     | 范围 / 允许值                                           | 说明                     |
| -------------------------------- | -------: | -------------------------------------------------- | ---------------------- |
| `themeMode`                      | `auto`  | `auto` / `system` / `light` / `dark` / `scheduled` | 默认先跟随站点，再跟随系统          |
| `surfaceBlurPx`                  | `16`    | `0–32px`，步进 `1`                                    | 与壁纸 `blurPx` 独立        |
| `shadowHeight`                   | `1`     | `0–2`，步进 `0.1`                                     | 卡片阴影垂直强度               |
| `shadowCurve`                    | 3 个点    | 每个点 `position 0–1`、`opacity 0–1`                   | 生成 betterLD 自有卡片阴影     |
| `fontScope`                      | `own`   | `own` / `managed`                                  | 是否覆盖已管理页面正文            |
| `removeChinesePunctuationIndent` | 关闭      | 布尔值                                                | 只作用于 betterLD 自有文本     |
| `liquidSegmentIndicatorEnabled`  | 关闭      | 布尔值                                                | 仅作用于自有设置分段控件           |
| `cardMinSize`                    | `280`   | `240–480px`，步进 `8`                                 | 自适应网格最小轨道宽度            |
| `cardSideGutter`                 | `24`    | `16–48px`，步进 `4`                                   | 当前默认值保持不变              |
| `gridGap`                        | `16`    | `8–32px`，步进 `4`                                    | 当前默认值保持不变              |
| `topicListLayoutMode`            | `cards` | `cards` / `native`                                 | `native` 恢复原始主题列表      |
| `gridColumns.*`                  | 1–6     | `1–12` 的整数                                         | 仅 `gridMode=fixed` 时生效 |
| `topicFilterMode`                | `hide`  | `hide` / `include`                                 | 过滤命中项的处理方式             |
| `actionRailPosition`             | `right` | `left` / `right` / `bottom`                        | 仅启用操作栏时生效              |
| `wallpaperRemoteCacheDays`       | `0`     | `0` / `1` / `7` / `30`                             | `0` 表示不额外持久化远程图片内容     |
| `topicTitleRules` 等              | `[]`    | 每类最多 `64` 条                                        | 纯文本大小写不敏感包含匹配          |
| `fontFamily`                     | `""`    | 最长 `200` 字符                                        | 仅本机或系统已有字体             |
| `customCss`                      | `""`    | 最长 `64 KiB`                                        | 高级设置，默认关闭；只允许受限规则      |
| `topicCardContextMenuConfig`     | 4 项     | 仅允许白名单动作                                           | 只作用于 betterLD 主题卡片     |
| 搜索历史                             | 关闭      | 最多保留 `50` 条                                        | 只保存到本地或用户主动开启同步        |


当前 `maskOpacity`、`blurPx`、`cardOpacity` 的范围继续以 `betterld.config.js.settingsLimits` 为唯一来源，不在 HTML 或导入器中重复定义。

## 7. 功能设计

### 7.1 主题和壁纸

#### 主题模式

- `auto`：优先读取 LinuxDo 明确的 `data-theme`、`data-color-scheme`、class 和计算样式；识别不到时读取系统偏好。
- `system`：忽略站点明暗状态，只读取 `prefers-color-scheme`。
- `light` / `dark`：只改变 betterLD 自有 Token，不改动原站主题属性。
- `scheduled`：按本地时间切换 betterLD Token；跨午夜区间按闭区间处理，例如 `18:00–07:00`。
- 主题变化必须同步更新壁纸遮罩颜色、卡片文字、边框和主色。

#### 主题色

- 首版提供有限预设和原生颜色选择器。
- 预设放在 `betterld.config.js.themeCatalog`，每个预设至少包含浅色 primary、深色 primary 和 on-primary 对比色。
- 自定义颜色只接受 `#RGB` 或 `#RRGGBB`，保存前计算相对亮度并选择黑色或白色 `on-primary`。
- 表面色、错误色和成功色继续使用固定语义 Token；主题色不能覆盖错误和成功语义。
- `useGradientThemeColorBackground` 只作用于 betterLD 自有背景，不改变原站布局。
- `darkModeBaseColor` 只调整深色背景 / surface 的基色，不能降低正文和焦点轮廓对比度。

#### 壁纸

保留当前 5 种来源及行为：

- 内置渐变。
- `LoremPicsum` 每日固定随机图。
- 内置图片目录。
- HTTPS 远程图片。
- 本地上传图片。

新增缓存策略只作用于 HTTPS 远程图片：

- 内置图不需要缓存设置。
- 每日随机图的日期结果始终以当天为准，不能被缓存时长覆盖。
- 远程图片默认只使用浏览器缓存，不把图片正文复制到设置 JSON。
- 用户选择 `1`、`7` 或 `30` 天时，只缓存 URL、探测时间和成功状态，不缓存图片二进制。
- 请求失败继续使用当前明暗主题匹配的安全渐变，并在设置页显示失败状态。

### 7.2 毛玻璃、阴影和页面样式

- `frostedGlassEnabled=false` 时，将所有 betterLD 自有 surface 的 `--betterld-surface-blur` 设为 `0px`，并关闭对应 `backdrop-filter`。
- `surfaceBlurPx` 与现有 `blurPx` 分离：
  - `blurPx`：壁纸背景模糊。
  - `surfaceBlurPx`：卡片、菜单、导航和 Header surface 的背景模糊。
- `shadowMode` 提供 `default`、`none` 和 `custom` 三种模式。
- `shadowHeight` 控制阴影整体高度；`shadowCurve` 使用固定数量的控制点描述从近到远的透明度曲线，规范化时排序、去重并限制范围。
- custom 模式只为 betterLD 自有卡片生成 `box-shadow`，不重写原站阴影。
- `liquidSegmentIndicatorEnabled` 只影响设置页自有分段控件；`prefers-reduced-motion` 时强制使用静态指示器。
- `headerVisualMode`：
  - `native`：保留原站 Header 视觉。
  - `transparent`：仅去除不必要的不透明背景。
  - `frosted`：使用 betterLD surface Token 和独立表面模糊。
  - `solid`：使用不透明 surface，适合性能较弱设备。
- Header 样式覆盖必须限定在真实 LinuxDo Header 选择器，不复制或重建原站导航项目。
- `applyToUnmanagedPages` 默认关闭；开启后只扩展背景、Header、Sidebar 等壳层，不把主题卡片网格注入未确认的页面。

### 7.3 字体和自定义 CSS

#### 字体

- `fontMode=default`：使用系统 UI 字体栈。
- `fontMode=recommended`：使用项目配置中的推荐本机字体栈，不加载远程字体。
- `fontMode=custom`：使用用户输入的系统字体族名称。
- 默认只作用于 betterLD 自有节点；“覆盖整个 LinuxDo 页面”必须作为单独的高级开关，避免改变编辑器和代码字体。
- 禁止远程 `@font-face`、字体 URL 和隐式外部资源加载。

#### 自定义 CSS

- 默认关闭，设置页必须显示“可能破坏 betterLD 自有布局”的警告。
- custom CSS 不是任意页面 CSS，而是受限规则语言：每条规则必须是普通 qualified rule，选择器必须包含 `.betterld-` 或 `[data-betterld-`，禁止选择 `html`、`body`、`:root`、通配符和未带 betterLD 命名空间的原站节点。
- 允许属性只覆盖视觉和排版白名单，例如 `color`、`background`、`border`、`border-radius`、`box-shadow`、`opacity`、`font-size`、`font-family`、`gap`、`padding`、`margin` 和 `transform`；禁止 `display`、`content`、`position`、`z-index`、`color-scheme`、`font-face` 等会改变交互或安全边界的属性。
- 值禁止外部资源和脚本表达式，包括 `url()`、`image-set()`、`@import`、`expression`、`javascript:`、`behavior`、`-moz-binding`、控制字符和 HTML 标签。
- 校验使用 CSSOM：先在 detached document 中解析，遍历 `cssRules`、选择器和声明，确认没有未知 at-rule、未命名空间选择器和不在白名单的属性；字符串扫描只作为额外防线，不能作为唯一解析器。
- 只注入一个幂等的 `<style data-betterld-custom-css>`，并在路由离开管理范围时移除；`applyToUnmanagedPages` 不扩大 custom CSS 选择器范围。
- CSS 解析失败时保留旧样式并显示错误，不清空用户输入。
- 该能力必须在实现阶段增加真实页面回归，重点检查通知、头像、作者卡片、原站表单和焦点轮廓没有被错误隐藏。

### 7.4 主题卡片网格

#### 布局模式

- `gridMode=auto`：使用当前 `auto-fit + minmax(min(100%, ...), 1fr)`。
- `gridMode=fixed`：使用断点列数配置；仍受可用宽度和单列窄屏规则限制。
- `topicListLayoutMode=cards` 使用 betterLD 主题卡片网格；`topicListLayoutMode=native` 跳过卡片转换并恢复原始主题列表，页面壁纸和壳层视觉仍可继续生效。
- `native` 模式不能删除原始列表控制、分页、未读和置顶语义；切换模式时必须先恢复原始 DOM，再按目标模式执行，避免在已转换卡片上二次转换。
- 小于 `560px` 时卡片模式强制单列，保留当前窄屏边界。
- `cardMinSize`、`cardSideGutter` 和 `gridGap` 应从根配置默认值迁移为可编辑用户设置，但配置文件仍保留默认值和范围。

#### 断点列数

- 断点键保持 `base`、`sm`、`md`、`lg`、`xl`、`xxl`。
- 断点数值由根配置维护，用户只编辑每个断点的列数。
- 输入值取整并限制在 `1–12`。
- 断点之间不允许出现小于 `1` 的列数；当前视口宽度没有对应配置时回退到最近较小断点。
- 提供“恢复网格默认值”按钮，只重置网格字段，不重置壁纸和主题。

#### 卡片内容显隐


| 设置                     | 默认  | 行为                                            |
| ---------------------- | ---: | --------------------------------------------- |
| `showTopicAvatar`      | 开   | 隐藏头像后，身份栏仍保持可读宽度                              |
| `showTopicAuthor`      | 开   | 只隐藏作者文本，不改变作者 JSON 请求和缓存                      |
| `showTopicCategory`    | 开   | 隐藏分类 Chip，保留主题链接和分类数据                         |
| `showTopicExcerpt`     | 开   | 关闭后不展示摘要并停止仅摘要观察请求；作者显示或作者过滤仍需要权威元数据时继续请求作者字段 |
| `showTopicMeta`        | 开   | 隐藏活动时间 / 回复数元信息                               |
| `showTopicUnreadState` | 开   | 隐藏未读视觉标识，不改变原站未读语义                            |
| `showTopicPinnedState` | 开   | 隐藏置顶视觉标识，不改变原站置顶排序                            |


卡片内容设置通过 CSS 变量或 `data-*` 状态控制，避免每次开关都重建整张卡片。作者值仍由 JSON 请求回写，显隐不能引入任何身份回退。主题元数据请求拆分为作者字段和首帖摘要字段：关闭摘要只停止摘要消费，不能让作者显示或作者过滤回退到 DOM 最后回复者。

#### 字号

- `responsive`：保留当前标题 `clamp()` 和 container query 行为。
- `small`、`base`、`large` 三档只调整 betterLD 自有卡片；不修改原站字体。
- 标题、作者、元信息分开设置，摘要继续使用可读的正文字号。

#### 阴影曲线、高度和卡片操作菜单

- `shadowMode=custom` 使用 `shadowHeight` 和固定数量的 `shadowCurve` 控制点生成卡片阴影；控制点按 `position` 排序并在 `normalizeSettings()` 中限制范围。
- 设置页提供高度滑杆和 3 个透明度控制点，不引入画布或第三方曲线编辑器；控制点位置固定，避免拖拽状态难以键盘访问。
- 卡片操作菜单使用原生按钮列表，动作白名单为：当前页打开、新标签页打开、后台打开、抽屉打开、复制主题 URL、复制干净 URL、复制主题 ID、打开分类和打开作者主页（存在对应链接时才显示）。
- `topicCardContextMenuConfig` 只控制白名单动作的显隐和顺序；未知动作在规范化时丢弃并报告。
- 菜单支持鼠标、键盘和触屏，关闭后焦点回到触发按钮；复制失败显示明确状态，不伪造剪贴板成功。

### 7.5 主题导航和页面壳层

#### 主题导航

当前 `#navigation-bar` 的项目以稳定 ID 保存：`latest`、`new`、`unread`、`hot`、`top`、`posted`、`read`、`bookmarks`、`categories`。实际 ID 以 DOM 链接和路径为准。

每个项目配置：

```js
{
  id: "latest",
  visible: true,
  order: 0
}
```

规则：

- 至少保留 1 个可见项目；不能通过设置隐藏所有入口。
- 排序只改变视觉顺序或受控 DOM 顺序，保留原始 `href`、数量文本和 active 状态。
- `categories` 作为目录入口，不能因卡片过滤设置而删除路由能力；隐藏只影响导航展示。
- `topicNavigationAlignment` 提供 `left`、`center`，默认 `left`。
- `topicNavigationSticky` 默认开启，必须与现有列表控制栏滚动收起行为协调。
- 数量显示由 `showTopicNavigationCounts` 控制；隐藏数量不能删除可访问名称中的语义信息。
- 导航项目拖拽排序不是首版必需，优先使用上移 / 下移按钮，避免引入拖拽依赖。

#### Header

- 只控制原生 Header 的视觉模式、显隐和自动隐藏，不重建 Logo、搜索、通知或用户菜单。
- `autoHideHeader` 只在页面向下滚动超过配置阈值后隐藏，向上滚动或键盘聚焦 Header 内元素时恢复。
- 自动隐藏不能遮挡焦点元素；隐藏期间 Header 使用 `inert=false`，恢复时保持原有键盘路径。
- 移动端默认不自动隐藏，除非触屏模式明确开启。
- `headerVisualMode` 与 `frostedGlassEnabled` 独立：前者决定 surface 形态，后者决定是否使用背景模糊。

#### Sidebar

- `sidebarPosition=original` 保留当前 LinuxDo 位置。
- `sidebarPosition=right` 仅在真实 DOM 和宽屏布局验证后启用，通过布局逻辑属性调整，不复制侧栏内容。
- `autoHideSidebar` 只适用于宽屏；隐藏后必须保留可发现的悬停 / 聚焦热区和键盘恢复路径。
- 侧栏继续使用当前 `sticky` 与 `--header-offset` 约束，不能因为自动隐藏而出现内容遮挡或超出视口。
- 窄屏直接禁用侧栏位置和自动隐藏设置，使用原站移动抽屉。

#### 浮动入口和操作

- `showSettingsTrigger` 控制当前 `[data-betterld-settings-trigger]`，默认开启。
- 设置入口继续调用 `runtime.openOptionsPage()`，不复制设置表单。
- `showBackToTopButton` 和 `showRefreshButton` 默认关闭；开启后只创建一个 Material 3 浮动操作组，避免与原站按钮重复。
- 返回顶部使用 `window.scrollTo({ top: 0 })`，不改变路由。
- 刷新使用原生 `location.reload()`；`enableUndoRefresh` 仅在实现了刷新前滚动位置和表单状态恢复后开放，首版不启用。

### 7.6 链接打开和抽屉

#### 打开模式

- `currentTab`：保留当前原生 `<a>` 行为。
- `newTab`：以新标签页打开，保留 modifier-click 和键盘行为。
- `background`：由内容脚本发送 `{ type: "open-topic", url, active: false }` 到 MV3 service worker；`src/background.js` 校验发送方和 `https://linux.do/t/<id>` 目标后调用 `tabs.create({ url, active: false })`。API 不可用、消息失败或目标不合法时显示明确错误，不静默改为当前页。
- `newTab` 和 `background` 都必须保留 Ctrl / Cmd、Shift、键盘 Enter 和鼠标中键等原生 modifier-click；只有用户选择扩展打开模式且没有 modifier 时才拦截。
- `drawer`：只适用于主题卡片，打开 betterLD 自有 `<dialog>` 抽屉。

当前默认必须保持 `currentTab`，确保向后兼容。

#### 抽屉内容

- 首版抽屉展示卡片已有的标题、分类、作者、元信息和首帖摘要。
- 摘要优先复用 `excerptCache`，不重复请求同一个 `/t/{id}.json`。
- 抽屉提供“在当前页打开”明确链接，完整回复、编辑器、附件和权限操作仍进入原始主题详情页。
- 使用原生 `<dialog>` 或等价的可访问弹层：
  - `drawerCloseOnOverlay` 默认开启。
  - `drawerCloseOnEscape` 默认开启。
  - 关闭后焦点回到触发卡片。
  - `Escape`、关闭按钮和移动端返回路径均可用。
- 抽屉加载失败显示摘要不可用状态和原始主题链接，不伪造成功内容。

### 7.7 LinuxDo 主题过滤

#### 规则

- `topicFilterEnabled` 默认关闭。
- 标题、作者、分类分别维护规则数组，规则结构为：

```js
{
  keyword: "关键词",
  remark: "可选备注"
}
```

- 使用纯文本、大小写不敏感、包含匹配；首版不支持正则，避免复杂度和 ReDoS 风险。
- `topicFilterMode` 统一决定“命中隐藏”或“仅显示命中”，默认是 `hide`；标题和分类可以直接使用 DOM 文本预过滤。
- 作者规则必须使用 `/t/{id}.json` 的 `details.created_by.username` 作为输入；作者显示或作者过滤开启时，主题元数据加载器即使关闭摘要也必须请求作者字段。
- 主题数据层可以一次请求并缓存 `{ author, excerpt }`，但 `applyTopicAuthor()` 与 `applyTopicExcerpt()` 独立消费字段；关闭摘要不能让作者逻辑退回到头像、最后回复者或 `post.username`。
- 空关键词拒绝保存；前后空格在保存时清理；重复规则合并。
- 过滤只作用于 betterLD 生成的卡片，不改变 Discourse 原始 DOM 的排序、分页和服务端查询。
- 被过滤的卡片不进入摘要 `IntersectionObserver`，避免无意义的 `/t/{id}.json` 请求。
- 全部主题被过滤时显示 betterLD 空状态，并提供关闭过滤按钮；动态刷新提示仍位于网格前。
- 列表更新、路由切换和 SPA 导航后重新应用过滤，不能产生重复卡片或丢失原始列表恢复能力。

#### 导入导出

- 标题、作者和分类规则支持独立 JSON 导入导出，也支持随完整设置一起导出。
- 导入逐条校验，非法条目被拒绝并显示数量；不接受静默丢弃后显示成功。

### 7.8 搜索页通用设置

当前 `/search` 未进入 betterLD 卡片改造范围，因此以下设置为条件纳入；实现前必须采集真实 LinuxDo 搜索 DOM 和 API 行为。

- `searchMode`：
  - `native`：保留原始搜索结果。
  - `cards`：将确认过的主题结果转换为 betterLD 卡片。
- `searchHistoryEnabled`：只保存用户实际提交的搜索词；默认关闭。
- `searchRecommendationEnabled`：只在确认搜索建议来源和 DOM 后启用；默认关闭。
- `searchFocusDimming`：聚焦搜索框时只对 betterLD 自有背景增加遮罩，不遮盖键盘焦点。
- `searchFocusBlur`：独立于全局壁纸模糊，默认关闭并显示性能提示。
- `searchResultsPaginationMode`：`scroll` 或 `pagination`，只能在真实结果分页机制确认后启用。
- `searchPageWallpaperMode`：`inherit`、`builtin` 或 `url`；默认继承全局壁纸，固定模式只保存 `searchPageWallpaperId` 或 HTTPS `searchPageWallpaperUrl`。
- 搜索页的搜索词历史只存提交值，不存完整 URL、用户信息或结果内容；清空历史是独立操作。
- 搜索页面设置不能引用 Bilibili 热搜、角色图、BVID/AV 号或 Bilibili 专属搜索 API。

### 7.9 触屏、窄屏和横向导航

- `touchOptimization=auto`：根据指针和视口能力启用触屏尺寸，不依赖 User-Agent。
- `touchOptimization=on`：按钮、导航和卡片操作目标至少 `44 × 44px`。
- `touchOptimization=off`：使用桌面密度，但不低于可访问性最小触控目标。
- `enableHorizontalNavigationScroll` 默认开启，只作用于主题导航和设置页标签，不让主题卡片横向溢出。
- 触屏模式隐藏 Header / Sidebar 自动隐藏和右侧重排选项，避免无法发现的操作。
- `prefers-reduced-motion: reduce` 时关闭卡片位移、Header 滑入和抽屉过渡。
- `forced-colors: active` 时使用系统颜色，保留边界、焦点和 active 状态。

### 7.10 快捷键

- `shortcutsEnabled` 默认关闭，避免与 LinuxDo、浏览器和编辑器冲突。
- 首版只设计 3 个通用动作：
  - `refreshTopics`：刷新当前主题列表。
  - `openSettings`：打开设置页。
  - `toggleListControls`：显示 / 隐藏列表控制栏。
- 快捷键只在焦点不属于 `input`、`textarea`、`select`、`[contenteditable]` 时触发。
- 设置页提供录入、取消、恢复默认和冲突检测。
- 同一扩展快捷键不能重复；与站点官方快捷键的冲突只提示，不拦截编辑器内输入。
- 快捷键动作必须有可见按钮等价路径，不能把功能只放在键盘上。

### 7.11 语言、备份、同步和关于

#### 语言

- `language` 首版提供 `zh-CN` 和 `en-US`。
- UI 文案放在无依赖静态字典中，默认中文。
- 语言切换只改变设置页和 betterLD 自有状态文本，不改写 LinuxDo 原站文案。
- 未翻译文案回退到中文，并在开发检查中报告缺失键。

#### 完整设置导出

- 导出 JSON 包含 `schema`、`settingsVersion`、导出时间和已识别设置字段。
- 不默认导出本地壁纸二进制、浏览器账号信息、页面内容或主题摘要缓存。
- 导出文件名为 `betterld-settings-YYYYMMDD-HHmmss.json`。
- 导出成功必须显示文件大小和字段数量。

#### 设置导入

- 只接受 JSON 对象，不接受数组、脚本或 HTML。
- 识别当前 schema 的字段；未知字段忽略并计数。
- 标量字段检查类型和范围；枚举字段检查允许值；数组字段逐条检查结构。
- 导入采用“部分合并”，未出现在文件中的当前设置保持不变。
- 当前版本无法识别的高版本字段显示警告，但仍可导入已识别字段。
- 归一化失败时不写入任何设置，保留当前表单和本地状态。
- 本地壁纸不随配置导入；如果导入文件指定 `wallpaperMode=local` 但当前没有对应本地资源，则改为安全渐变并显示原因。

#### 恢复默认

- 默认恢复只恢复配置字段，保留本地壁纸资源，避免普通恢复操作造成数据丢失。
- 另提供“删除本地壁纸”按钮，必须独立确认。
- 恢复默认后立即通过当前 storage 事件应用到已打开页面。
- 重置过程中写入失败时保留旧值并显示错误，不显示成功提示。

#### 浏览器同步

- 使用已授权的 `storage.sync`，不新增远程服务和账号系统；`syncEnabled=false` 默认关闭。
- 定义唯一的 `toSyncSettings(settings)` 投影：同步主题、外观、卡片、导航、过滤、快捷键和允许同步的 custom CSS；排除 `wallpaperLocalId`、本地壁纸正文、`wallpaperRandomDate`、`wallpaperRandomUrl`、页面摘要缓存和搜索历史。
- 当当前壁纸模式为 `local` 时，sync 投影写入 `wallpaperMode=none` 和 `localWallpaperOmitted=true`；本机 local 状态仍保留，另一设备显示安全渐变并提示缺少本地资源。
- 关闭同步时只使用 `storage.local`；开启同步时先读取本机和同步配置：同步配置为空则复制本机配置，已有同步配置则显示“使用本机 / 使用同步”一次性选择，不能静默覆盖任一侧。
- 同步启用后，设置页和 content script 都通过 `getActiveSettings()` 读取当前选定 storage area；`storage.onChanged` 同时检查 `local` 和 `sync` 的 `areaName`，只应用活动区域。
- 写入前对归一化后的 sync 投影做稳定 JSON 比较；目标值未变化时不写入，避免 local ↔ sync 回写循环。跨设备冲突遵循浏览器 `storage.sync` 的最后变更值，页面应用每次变更并显示来源。
- 开启前使用 `storage.sync.getBytesInUse()` 或等价 API 检查配额；自定义 CSS、规则和设置总大小超过配额时拒绝开启并提示本地仍可用。
- `storage.sync` 读写失败时保留 `storage.local` 当前配置，显示明确的“同步不可用”状态；不静默切换并覆盖数据。

#### 关于

- 显示 `runtime.getManifest().version`、Manifest V3、支持浏览器和当前存储方式。
- 提供项目主页和问题反馈链接，使用新标签页打开。
- 不自动执行远程版本检查；如未来加入，必须是用户主动触发并明确说明网络请求地址和失败状态。

## 8. 运行时架构

### 8.1 共享配置和规范化

当前 `src/content.js` 和 `src/options.js` 各自包含相似的规范化逻辑。实现本设计时先抽取一个无依赖共享脚本，例如 `src/settings.js`：

```text
betterld.config.js
    ↓
src/settings.js
    ├── normalizeSettings(raw)
    ├── normalizeImportedSettings(raw, current)
    ├── validateRuleArray(raw)
    ├── validateCustomCss(raw)
    └── settingsDefaults / settingsLimits 的只读访问
```

加载方式：

- Manifest content script：`betterld.config.js` → `src/settings.js` → `src/content.js`。
- Options HTML：`betterld.config.js` → `src/settings.js` → `src/options.js`。
- MV3 service worker：`src/background.js` 只负责经过校验的后台打开标签页消息，不读取页面内容；Manifest 增加最小必要的 `background.service_worker` 配置和经浏览器验证后所需的 `tabs` 权限。

`src/settings.js` 只暴露 `globalThis.BETTERLD_SETTINGS`，不引入 ES Module、打包器或运行时依赖。

### 8.2 存储事件流

```text
options draft
   ↓ submit / explicit action
normalizeSettings
   ↓
storage.local.set({ "betterld.settings": settings })
   ↓ browser storage.onChanged
content.js normalizeSettings
   ↓
applyTheme → applyVisualSettings → applyShellSettings
   ↓
CSS variables + data attributes + managed DOM state
```

要求：

- 表单输入只修改 draft；保存按钮才持久化，实时预览只修改设置页本地预览。
- 页面收到 storage 变化后一次性规范化并应用，避免每个控件分别触发 DOM 扫描。
- 壁纸请求、摘要请求和抽屉请求都使用递增 request ID，旧请求不能覆盖新设置。
- 现有 `storage.onChanged` 的实时壁纸、遮罩、背景模糊和卡片透明度行为必须继续通过。
- `getActiveSettings()` 根据 `syncEnabled` 选择 `local` 或 `sync`；同步事件只在活动区域发生变化时应用，切换区域时执行一次完整归一化和视觉刷新。

### 8.2.1 主题元数据和请求消费解耦

- 统一主题加载器返回 `{ author, excerpt }`，并在 `excerptCache` 中按主题 ID 缓存已成功字段。
- `applyTopicAuthor()` 只处理权威作者字段；`applyTopicExcerpt()` 只处理摘要字段；两个函数可以分别被卡片展示、过滤和抽屉调用。
- 当 `showTopicExcerpt=false` 且没有抽屉需求时，不创建摘要观察消费；当 `showTopicAuthor=true` 或作者规则启用时，仍加载作者字段。
- JSON、CF 或临时网络失败继续使用有限重试和最终占位；任何失败都不能回退到 `.topic-activity__username`、头像 `title`、`post.username` 或最后回复者。

### 8.3 CSS 变量

新增用户设置优先映射到 CSS 变量，不为每个设置增加独立选择器：

```css
--betterld-background-blur
--betterld-surface-blur
--betterld-mask-opacity
--betterld-card-opacity
--betterld-card-min-size
--betterld-card-side-gutter
--betterld-grid-gap
--betterld-shadow-level
--betterld-primary
--betterld-on-primary
--betterld-font-family
```

卡片内容使用页面状态属性：

```html
<html data-betterld-card-author="hidden">
<html data-betterld-card-avatar="hidden">
<html data-betterld-card-excerpt="hidden">
```

这样设置变化不需要重建现有卡片；页面路由恢复时仍由统一同步流程清理这些属性。

### 8.4 路由和 DOM 恢复

- 视觉 Token 可以在已确认的页面壳层复用。
- 主题卡片、导航排序、过滤和抽屉只在对应 route predicate 成功后执行。
- 任何 DOM 替换必须有对应的恢复路径；离开管理页面时恢复源表格、原始导航顺序和原始隐藏状态。
- `MutationObserver` 只观察必要属性和子树；设置变化不能创建第二个 observer。
- 页面级幂等锁继续保留，重复注入不能叠加 observer、scroll listener、浮动按钮或 custom style。

## 9. 数据与安全边界

### 9.1 外部输入

- 所有 URL 只接受 HTTPS；本地图片只接受 `image/*`，并执行尺寸、大小和 MIME 校验。
- 主题色只接受白名单格式；CSS 颜色和 CSS 文本不能直接拼入未校验的 style 属性。
- 规则文本先 trim、限制长度、去重；不执行用户输入。
- custom CSS 通过 detached document 的 CSSOM 解析、qualified-rule 和命名空间选择器检查、声明属性白名单检查后才注入；禁止依靠单一正则判断 CSS 是否安全。
- 导入 JSON 使用对象结构校验和字段白名单；未知字段不进入运行时状态。
- 页面 DOM 文本一律通过 `textContent` 写入，不使用 `innerHTML`。

### 9.2 隐私

- 本地壁纸不上传到 LinuxDo。
- 搜索历史、过滤规则、自定义 CSS 和设置默认保存在 `storage.local`，同步必须由用户主动开启。
- 远程壁纸和用户主动配置的外部链接属于明确的网络请求，设置页需要给出说明。
- 不新增分析、遥测、账号或云端配置服务。

### 9.3 性能

- 毛玻璃和背景模糊提供关闭路径，设置页显示性能影响提示。
- 摘要仍按 IntersectionObserver 懒加载；关闭摘要显隐时不创建摘要消费请求，但作者显示或作者过滤仍可加载权威作者元数据。
- 标题和分类过滤先在 DOM 主题信息上执行；作者过滤在作者元数据返回后执行，过滤掉的卡片不再加载摘要字段。
- 自定义 CSS、主题色、网格参数变化只更新 CSS 状态，不重新抓取主题列表。
- search history 默认关闭，避免向每次键盘输入写入 storage。

### 9.4 可访问性

- 所有设置控件有可见标签和当前值。
- 单选项使用真正的 `radio` 语义，卡片壁纸选择保留 `aria-pressed`。
- 卡片链接、抽屉按钮、浮动入口和过滤空状态可键盘操作。
- `focus-visible` 轮廓不能被主题色或 custom CSS 默认移除。
- 隐藏 Header / Sidebar / list controls 时，不能把当前焦点元素设为不可见或 `inert`。
- reduced motion、forced colors、窄屏和高对比度状态必须有专门回归。

## 10. 分阶段实施顺序

### Phase 0：共享基础和兼容

- 抽取 `src/settings.js` 的共享规范化、导入校验、规则校验、主题元数据字段消费和设置搜索元数据。
- 增加 `settingsVersion`，兼容当前无版本设置和旧 `wallpaper` URL 字段。
- 将当前根配置中的网格默认值纳入规范化，但默认视觉保持不变。
- 建立设置页分组、搜索元数据、中文 / 英文静态字典和统一状态提示。
- 明确 active storage area 和 `toSyncSettings()` 投影接口，但先不打开同步默认值。

验收：现有壁纸 5 种来源、每日随机、URL 校验、本地图片、主题同步、3 个滑杆、恢复默认行为不回退。

### Phase 1：主题卡片设置

- `topicListLayoutMode` 的 `cards/native`、网格 `auto/fixed`、最小宽度、间距、内缩和断点列数。
- 作者、头像、分类、摘要、元信息、未读、置顶显隐。
- 卡片标题、作者、元信息字号。
- 默认阴影 / 无阴影和表面模糊开关；主题元数据作者与摘要消费拆分。

验收：桌面宽屏、窄屏、SPA 路由、列表刷新、重复注入和作者 JSON 失败均保持正确。

### Phase 2：导航、壳层和链接

- 主题导航显隐、排序、对齐、数量显示和固定。
- `showSettingsTrigger` 和通用 action rail 的位置、自动隐藏、半隐藏、项目顺序、主题切换和发光。
- Header 视觉模式和自动隐藏。
- Sidebar 位置 / 自动隐藏先在真实 DOM 确认后实现。
- 主题卡片打开方式、后台标签页消息链、复制链接操作菜单和摘要抽屉。

验收：键盘焦点、原始链接、modifier-click、路由恢复、抽屉焦点回收、移动端不遮挡。

### Phase 3：过滤、快捷键和备份

- 标题、作者、分类规则和空状态。
- 3 个通用快捷键及冲突检测。
- 完整设置 JSON 导入 / 导出、规则独立导入 / 导出、恢复默认。
- 明确保留或删除本地壁纸的行为。

验收：非法导入不写入、部分导入不覆盖未提供字段、过滤不产生摘要请求、快捷键不影响输入框。

### Phase 4：响应式、字体和高级外观

- 触屏模式、横向导航、Header / Sidebar 窄屏策略。
- 主题色、深色基色、渐变背景、字体和中文标点缩进选项。
- custom CSS 的 CSSOM 受限语法、固定控制点阴影曲线和阴影高度。
- 远程壁纸缓存策略、设置页液态分段指示器和 reduced-motion 降级。

验收：Chrome / Firefox 桌面端真实页面、reduced motion、forced colors、低性能关闭毛玻璃、外部资源拦截。

### Phase 5：搜索页和同步

- 采集并确认 LinuxDo `/search` DOM、分页、筛选、空状态和权限差异。
- 实现通用搜索设置和搜索结果模式。
- 增加 `storage.sync` opt-in、配额检查和同步状态。
- 增加版本和运行环境页面。

验收：搜索路由不影响已管理页面；同步只包含允许字段；网络失败和配额不足可见且不丢本地设置。

## 11. 验收标准

### 功能验收

- [ ] 现有 5 种壁纸来源、每日固定随机、HTTPS URL、本地上传和安全渐变回退全部保持通过。
- [ ] 主题模式 `auto` 仍以 LinuxDo 主题和系统偏好为默认来源，不出现扩展主题反馈循环。
- [ ] 主题卡片网格在宽屏中按可用宽度自适应，在 `560px` 以下保持单列。
- [ ] 网格配置变化可以实时应用，不重载页面、不产生重复网格。
- [ ] `cards/native` 切换可以恢复原始主题列表，且不丢失分页、未读、置顶和原始链接语义。
- [ ] 卡片字段显隐不会改变作者来源、摘要重试和原站链接行为；作者显示 / 过滤与摘要消费相互独立。
- [ ] 作者字段始终以 `/t/{id}.json` `details.created_by.username` 为权威值。
- [ ] 主题导航至少保留一个入口，排序和显隐不改变原始 `href`。
- [ ] Header / Sidebar 自动隐藏时不遮挡焦点、不丢失键盘路径。
- [ ] 卡片当前页、新页、后台页和抽屉模式行为明确；API 失败不能静默伪造成功。
- [ ] 后台打开通过 `src/background.js` 校验目标和发送方，失败时保留当前页并显示错误。
- [ ] 卡片操作菜单只显示白名单动作，复制失败和缺少作者 / 分类链接均有明确状态。
- [ ] 标题、作者、分类过滤在路由切换、列表刷新和动态 DOM 更新后仍稳定。
- [ ] 搜索设置只在真实 `/search` 能力实现后生效，不影响其他页面。
- [ ] 快捷键默认关闭，开启后不拦截输入控件和编辑器内容。
- [ ] 导入、导出、恢复默认和同步均有成功 / 失败状态，失败不丢当前值。
- [ ] 同步开启前有本机 / 同步配置选择；local-only 字段、搜索历史和缓存不进入 sync；跨设备变更只应用活动 storage area。

### 安全和隐私验收

- [ ] HTTP、无效 URL、非法颜色、非法规则、超大本地图和超大 CSS 均被拒绝。
- [ ] 导入文件只处理白名单字段，不执行文件内容。
- [ ] custom CSS 通过 CSSOM 规则、选择器命名空间和属性白名单校验，不允许外部 `@import`、`url()`、字体和脚本型声明。
- [ ] 本地壁纸、摘要缓存和搜索历史不会进入 `storage.sync`；local 壁纸在其他设备只显示安全渐变并有提示。
- [ ] 不新增账号、遥测、云端设置和无用户动作的版本网络检查。

### 浏览器和页面验收

- [ ] `npm run check` 通过。
- [ ] `manifest.json` 和 `package.json` JSON 解析通过。
- [ ] Chrome for Testing 真实加载通过。
- [ ] Firefox 临时 XPI / WebDriver 真实加载通过，并兼容 callback / Promise 存储 API。
- [ ] Orca 或本机 preview service 使用 cache-busting 加载最新源码后，验证首页、`/latest`、分类页、`/tags`、`/tag/*` 和设置页。
- [ ] 桌面宽屏、`560px` 以下窄屏、浅色、深色、系统偏好、reduced motion 和 forced colors 均有针对性检查。
- [ ] 真实页面验证前确认 preview service 使用当前源码，不使用浏览器缓存中的旧 `content.js` 或 `content.css`。

## 12. 主要风险和取舍


| 风险                           | 处理                                                           |
| ---------------------------- | ------------------------------------------------------------ |
| 用户设置数量增长导致 options 页复杂       | 使用原生分组、依赖项渐进展示和设置搜索；不引入 Vue 设置框架                             |
| 网格固定列数在超宽屏或窄屏溢出              | 保留 `auto-fit` 默认路径、`min(100%, ...)`、窄屏单列和列数上限                |
| Header / Sidebar 自动隐藏破坏原站交互  | 仅针对真实 selector 实现；聚焦恢复；移动端默认关闭                               |
| 卡片显隐造成作者或摘要逻辑分叉              | 只改变 DOM/CSS 可见性，作者和摘要数据流仍由统一函数负责                             |
| custom CSS 产生外部请求或破坏布局       | 默认关闭；使用 CSSOM、选择器命名空间和属性白名单；禁止外部资源；先做真实页面回归                  |
| `storage.sync` 配额或切换冲突导致设置丢失 | 使用 `toSyncSettings()` 白名单、开启前配额检查、本机 / 同步选择和 local 保留；不做静默覆盖 |
| 作者显示与摘要懒加载相互影响               | 统一元数据加载器返回字段，作者和摘要由独立消费函数控制；作者永不从非权威 DOM 回退                  |
| 搜索页 DOM / API 尚未确认           | 作为条件纳入，先做真实页面取样，不用 Bilibili selector 猜测                      |
| 过度移植 BewlyCat 的组件架构          | 只复用设置语义和交互模式，保持原生 HTML、CSS、JavaScript                        |
| 普通恢复默认造成本地图片丢失               | 默认恢复配置但保留资源，删除资源使用独立确认                                       |


## 13. 交付边界

本设计完成后，下一轮实现应从 Phase 0 开始，先统一规范化和设置数据模型，再按 Phase 1–5 逐步交付。每个阶段只修改与该阶段行为直接相关的文件，并按对应验收项执行最小验证；未确认的 LinuxDo 页面不通过复制 BewlyCat 选择器或业务逻辑“猜测实现”。

## 14. 原始 1/2/3 审计项追踪

下表将前一轮复用审计中的非 Bilibili 专属项逐项落到本设计；Bilibili 专属项在第 2 节集中排除。

### 14.1 原第 1 节：已存在设置与基础能力


| 原审计项                        | 本设计落点                        |
| --------------------------- | ---------------------------- |
| 壁纸来源：渐变、网站随机、内置图、远程 URL、本地图 | V-01、7.1；保持现有 5 种模式          |
| 每日固定随机结果                    | V-01、7.1；日期结果不受缓存时长覆盖        |
| HTTPS URL 与本地上传校验           | V-01、9.1、11；保留边界校验           |
| 壁纸失败安全渐变回退                  | V-01、7.1；按主题匹配回退             |
| 遮罩透明度、背景模糊、卡片透明度            | V-01、7.2、6.1；继续使用根配置 limits  |
| 自动主题、系统主题和手动主题              | V-02、7.1；不写扩展 `color-scheme` |


### 14.2 原第 2 节：高价值通用改造项


| 原审计项                       | 本设计落点                              |
| -------------------------- | ---------------------------------- |
| 自动 / 固定网格、最小卡宽、间距、断点列数     | C-01、7.4；新增 `cards/native` 页面模式    |
| 卡片作者、头像、分类、摘要、元信息显隐        | C-02、7.4；作者和摘要消费解耦                 |
| 卡片标题、作者、元信息字号              | C-03、7.4                           |
| 阴影开关、阴影高度和曲线               | C-03、7.2、7.4；`default/none/custom` |
| 卡片操作菜单、当前页 / 新页 / 后台页 / 抽屉 | C-04、O-01、7.4、7.6                  |
| 标题、作者、分类关键词过滤              | F-01、7.7；作者只用主题 JSON               |
| JSON 导入、导出、恢复默认            | M-01、7.11                          |
| 浏览器同步、版本和关于信息              | M-02、M-03、7.11                     |
| 卡片与导航的链接打开模式               | O-01、7.6                           |


### 14.3 原第 3 节：通用外观、页面壳层和交互项


| 原审计项                       | 本设计落点                                 |
| -------------------------- | ------------------------------------- |
| 毛玻璃开关与强度                   | V-04、7.2；表面模糊与壁纸模糊分离                  |
| 主题色、深色基色、渐变主题背景            | V-03、7.1                              |
| 阴影、页面样式适配、侧栏遮罩模糊           | V-04、N-03、7.2、7.5                     |
| 自定义字体、中文标点缩进、自定义 CSS       | V-05、7.3、7.9、9.1                      |
| 设置页语言、搜索、分组和液态分段指示器        | I-01、I-02、7.3、7.11                    |
| 触屏优化、窄屏布局、导航横向滚动           | R-01、7.9                              |
| Header 视觉、显隐、自动隐藏          | N-02、7.5                              |
| Sidebar 位置、自动隐藏            | N-03、7.5；真实 DOM 确认后开放                 |
| 通用浮动操作栏、半隐藏、位置、发光、返回顶部、刷新  | N-04、N-05、7.5                         |
| 主题导航显隐、排序、对齐、固定、数量         | N-01、7.5                              |
| 搜索历史、推荐、聚焦遮罩 / 模糊、分页、搜索页壁纸 | S-01、S-02、7.8；LinuxDo `/search` 确认后实现 |
| 抽屉关闭行为                     | O-02、7.6                              |
| 页面刷新、设置入口和快捷键冲突检测          | K-01、7.10                             |


## 15. 参考资料和源码锚点

### BewlyCat

- 外观：`src/components/Settings/Appearance/Appearance.vue`
- 通用设置：`src/components/Settings/PluginComponentsAndPages/General/General.vue`
- 主题卡片布局：`src/components/Settings/PluginComponentsAndPages/VideoCard/VideoCard.vue`
- 卡片内容显隐：`src/components/Settings/PluginComponentsAndPages/VideoCard/VideoCardContentEditor.vue`
- 卡片菜单：`src/components/Settings/PluginComponentsAndPages/VideoCard/VideoCardContextMenuEditor.vue`
- 链接打开：`src/components/Settings/Navigation/LinkOpening.vue`
- 顶栏视觉：`src/components/Settings/PluginComponentsAndPages/TopBar/TopBarVisualConfig.vue`
- Dock / Sidebar：`src/components/Settings/PluginComponentsAndPages/DockAndSidebar/DockAndSidebar.vue`
- 搜索：`src/components/Settings/PluginComponentsAndPages/SearchPage/SearchPage.vue`
- 快捷键：`src/components/Settings/Shortcuts/Shortcuts.vue`
- 维护：`src/components/Settings/Advanced/Maintenance.vue`

### betterLD

- 根配置：`betterld.config.js`
- 设置页：`src/options.html`、`src/options.js`、`src/options.css`
- 页面逻辑：`src/content.js`
  - `normalizeSettings()`
  - `applyVisualSettings()`
  - `applyColorMode()`
  - `createCard()`
  - `fetchExcerpt()`
  - `topicContainers()`
  - `ensureSettingsTrigger()`
  - `storage.onChanged`
- 页面样式：`src/content.css`
  - Material 3 Token
  - 壁纸和遮罩
  - `.betterld-topic-grid`
  - `.betterld-topic-card`
- 扩展约束：`manifest.json`、`package.json`



务必完善设置界面，现在的设置界面都点不进去，在里面加上可供用户更改的选项。

