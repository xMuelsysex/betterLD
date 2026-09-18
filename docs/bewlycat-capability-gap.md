# BewlyCat 能力缺口清单（B / C 类）

- **日期**：2026-09-18
- **对照对象**：BewlyCat `~/.x-repo/github.com/keleus/BewlyCat` @ `4af5471`
- **用途**：记录「BewlyCat 里对 LinuxDo 可用、betterLD 还没做」的能力与「明确不做」的边界，
  避免每次重新审计；新增能力时先看这里再动手。
- **来源**：设置清单由 `src/components/Settings/searchCatalog.ts` 与各 Settings 组件直接枚举，
  文案取自 `src/_locales/cmn-CN.yml`；原始范围设计见
  `.pi/tasks/2026-09-12-bewlycat-reuse-design/design.md`。

## 0. 判定口径

审计把差异分成三类：

- **A 类**：设置项已经在设置界面里，但没有任何运行时效果（"只存不生效"）。
  → 2026-09-17 已全部补齐（7 项：`sidebarCoverBlurEnabled`、`liquidSegmentIndicatorEnabled`、
  `separateNavigationActions`、`enableUndoRefresh`、`searchRecommendationEnabled`、`searchMode`、
  `searchResultsPaginationMode`）。落地语义与实机验证记录见
  `.pi/tasks/2026-09-17-a-class-completion-and-rate-limit/task.md`。
- **B 类**：BewlyCat 有、betterLD 完全没有，且能落到 LinuxDo 的页面/DOM/数据上。
  → 2026-09-18 已全部补齐（8 项），落地语义与验证记录见第 1 节与
  `.pi/tasks/2026-09-18-b-class-completion/task.md`。
- **C 类**：与 Bilibili 页面、API、播放器或账号模型绑定，或 LinuxDo 没有对应数据源，明确不做。

## 1. B 类：已全部落地（8 项，2026-09-18）

逐项落地语义与实机验证记录见 `.pi/tasks/2026-09-18-b-class-completion/task.md`。

| 项 | BewlyCat 参照 | betterLD 落地 |
| --- | --- | --- |
| B1 页面内列表布局切换 | `enable_grid_layout_switcher` | 浮动操作栏新增 `layout` 项（`actionRailItems`），点击按 `settingsEnums.topicListLayoutMode` 循环「阅读卡 → Material 3 卡片 → 原生列表」，只写 `topicListLayoutMode` 这一个权威取值 |
| B2 卡片标签显隐 | `show_video_card_video_tag` | `showTopicTags`（默认开），只隐藏阅读卡上的标签行 |
| B3 统计与活动时间细分 | `show_video_card_publish_time` / `show_video_card_view_count` / `show_video_card_like_count` | `showTopicMeta` 仍是总开关，新增 `showTopicActivityTime` / `showTopicReplies` / `showTopicLikes` / `showTopicViews`；元信息行拆成回复数与活动时间两段（`data-betterld-meta-part`），统计项带 `data-betterld-stat`，全部按根 dataset 由 CSS 显隐，不新增请求 |
| B4 已看标记 | `show_video_watched_badge` | `showTopicWatchedState`（默认开）+ 本机浏览记录（`visitedTopicStorageKey`：访问 `/t/{slug}/{id}` 时记下主题 id），卡片出现「已看」徽标 |
| B5 搜索历史复用 | `enable_search_history` | `searchHistoryPanelEnabled`：站内搜索框聚焦时列出本机历史，点条目回填（页面带搜索表单时直接提交）、单条删除、清空全部 |
| B6 版本更新提醒 | `enable_version_reminder` | 关于页「检查更新」按钮：只在点击时经后台 service worker 取 GitHub Releases 最新 tag 与本地版本号比对，只提示、不自动更新、不轮询 |
| B7 链接打开方式细分 | `top_bar_link_opening_behavior` / `search_bar_link_opening_behavior` | `navigationOpenMode` / `searchOpenMode` 补 `background`、`currentTabIfHomepage`、`currentTabIfNotHomepage`；取值解析只在 `linkOpenBehavior` 一处，后台标签页经后台 service worker 的 `open-link` 消息创建 |
| B8 站点 Logo 样式 | `logo_color` / `enable_logo_glowing_effect` / `logo_visibility` | `siteLogoVisible` / `siteLogoOutline` / `siteLogoGlow`，只作用于 `#site-logo`（在这个站上它就是 `<img class="logo-big" id="site-logo">` 本身） |

**仍未做的一项**：「稍后再看 / 书签」入口（BewlyCat `show_video_card_watch_later`）。
它映射到 Discourse 的 `POST /t/{id}/bookmark`，属于服务端写入，与 `CONTEXT.md`
「插件不改变 LinuxDo 服务端数据」的不变量冲突；要做必须由主人显式要求（与「在服务端屏蔽作者」同一处理方式）。

## 2. C 类：明确不做

| 分组 | 具体能力 | 不做的理由 |
| --- | --- | --- |
| Bilibili 账号与授权 | 推荐模式、Web/App 授权、Cookie、Access Key、去个性化搜索 | 账号模型专属，LinuxDo 无对应概念 |
| Bilibili 动态页 | 动态列表与类型过滤、新动态布局、UP 主关注/置顶/观看清单、直播动态与预览 | 站点没有动态页 |
| 播放器 | 显示模式/宽屏、播放记忆、画面比例、倍速、画中画、自动连播、弹幕与字幕默认态、播放器快捷键 | 站点没有播放器 |
| 评论与互动数据 | 评论 IP/性别/楼主标识/回复树/评论图片、B 币券、VIP 经验、创作中心、通知数量 Badge 类型 | 站点没有这些数据字段 |
| Bilibili 顶栏与页面 | 顶栏 Logo/频道/置顶频道、收藏/历史/稍后再看、原站与插件页切换、热搜、搜索聚焦角色图、BVID/AV 号清洗 | 与 B 站顶栏结构绑定 |
| 视频内容形态 | 封面比例、悬停视频预览、视频时长与控制条、视频卡片操作菜单的 B 站动作 | 站点没有视频卡片 |
| 站点兼容 | 广告拦截、阻止移动端跳转、分享链接参数清洗 | LinuxDo 无对应广告与跟踪参数 |
| 无数据源 | 站点热搜、基于接口的搜索建议 | LinuxDo 不提供热搜；`/search/suggest.json` 实测被 Cloudflare 403 质询挡住（详见 `.pi/tasks/2026-09-17-a-class-completion-and-rate-limit/task.md`） |

## 3. 维护约定

- 新增 BewlyCat 侧参照时，先按本文口径归类；B 类做完一项就把它从这里移走并在
  `.pi/journal.md` 记录落地语义。
- 若 betterLD 主动扩边界（例如允许写服务端书签），要先更新 `CONTEXT.md` 的不变量，再改本文归类。
