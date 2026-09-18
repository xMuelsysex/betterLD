# 2026-09-18 B 类能力补齐（8 项）

## 目标与决策

主人要求「新建一个分支来完成 b 类还缺少的」。权威清单是 `docs/bewlycat-capability-gap.md`（B 类 8 项），
本任务把 8 项全部落地，分支 `feat/b-class-capabilities`（从 main 当前工作区切出）。

逐项决策：

1. **B1 页面内列表布局切换按钮** → 浮动操作栏新增 `layout` 项（`actionRailItems`），点击在
   `config.settingsEnums.topicListLayoutMode` 上循环（阅读卡 → Material 3 卡片 → 原生列表），
   直接写 storage，由既有 `storage.onChanged` → `scheduleSync` 链路重排，不新造重排路径。
2. **B2 卡片标签显隐** → 新增 `showTopicTags`，走既有 `root.dataset` + CSS 隐藏约定。
3. **B3 统计与时间细分开关** → 不新增请求：`showTopicMeta` 保留为主开关，新增四个细分项
   （`showTopicActivityTime`/`showTopicReplies`/`showTopicLikes`/`showTopicViews`）。
   元信息行拆成两个子元素（`data-betterld-meta-part`），统计按 `data-betterld-stat` 打标，
   全部由 CSS 按根 dataset 隐藏，设置改动即时生效、无需重载元数据。
4. **B4 已看标记** → 只做本地标记（`showTopicWatchedState` + `storage.local` 的已看主题 id 列表）。
   「稍后再看 / 书签」映射到 `POST /t/{id}/bookmark` 属于服务端写入，与 CONTEXT.md
   「不改变 LinuxDo 服务端数据」冲突，需要主人显式授权，本分支**不做**（见结论）。
5. **B5 搜索历史面板** → 新增 `searchHistoryPanelEnabled`（依赖已有的「保存搜索历史」），
   在搜索输入框聚焦时列出一条浮层：点击回填、单条删除、清空全部。
6. **B6 版本更新提醒** → 关于页新增「检查更新」按钮（默认不请求），经后台 service worker 请求
   GitHub Releases 最新 tag（只有点击时才发生，不做自动轮询、不自动更新）。按既有 WebDAV 架构走后台，
   因为设置窗口会在页面内以 Shadow DOM 复用（页面环境直连不可靠）。
7. **B7 链接打开方式细分** → `navigationOpenMode` / `searchOpenMode` 补 `background` 与两个条件取值
   （`currentTabIfHomepage` / `currentTabIfNotHomepage`），取值解析只在 `linkOpenBehavior` 一处；
   后台标签页能力泛化为 `open-link`（仍只接受 linux.do 链接）。
8. **B8 站点 Logo 样式** → 只做 `#site-logo` 的显隐 / 描边 / 发光三个开关，不重建 Header 结构。

顺带修掉的相邻缺陷（都在改动涉及的同一条链路上）：

- `normalizeOrderedConfig` 缺「老配置没有的新配置项按默认值补齐」→ 已存过 `actionRailItemsConfig`
  的用户永远看不到新加的 `layout` 入口。
- `navigationItemId` 不认识 `/unseen` → 站点的「未读」胶囊既不在导航编辑器里，也没有打开方式处理
  （`config.topicNavigationItems` 里本来就有 `unseen`）；补映射与 `labelMap.unseen`。
- `scripts/orca-preview.js` 的 storage 桩只把两个键写回内存对象 → 任何新增的本地键在整页刷新后被静默丢掉，
  预览会把「已看标记」这类新功能判成不生效；改成整份持久化对象回填。

## 计划

1. `betterld.config.js`：参数、枚举、设置分类 keys、默认值、操作栏项。
2. `src/settings.js`：布尔白名单 + 有序配置补齐。
3. `src/content.js`：dataset、布局按钮、已看记录、元信息/统计打标、搜索历史浮层、打开方式解析、Logo。
4. `src/content.css`：显隐规则、搜索历史浮层、Logo 规则。
5. `src/options.js` / `src/options.html`：新设置行、枚举标签、检查更新按钮与状态。
6. `src/background.js` / `manifest.json`：`check-update` 消息 + api.github.com 权限；`open-link` 泛化。
7. 验证：`npm run check`、CSS 花括号配平、真实 linux.do 页面（Orca preview）逐项复核。
8. 收尾：更新 `docs/bewlycat-capability-gap.md`（B 类清空并记录落地语义）、`CONTEXT.md` 不变量、journal。

## 验证记录

工具与环境：`npm run check` exit 0；`src/content.css` 花括号 561/561、`src/options.css` 185/185；
`git diff --check` 通过。实机复核走 `npm run preview:orca -- --page <tab>`（复用已过 Cloudflare 质询的
linux.do 标签页），断言全部在真实页面 DOM 上取计算值/真实节点，不注入替身节点。

- **B1**：真实 `/latest` 上点操作栏布局按钮，`html[data-betterld-topic-list-layout]` 与
  `[data-betterld-grid]` 的 `data-betterld-card-style` 依次 reading → cards → native → reading，
  30 张卡片随之变成 M3 卡片 / 原生表格行恢复（`tr.topic-list-item` 不再 hidden、grid 数 0），
  storage 里的 `topicListLayoutMode` 同步，按钮 title 跟着当前模式变（「切换卡片样式（当前：…）」），
  并有成功 toast；关掉 `actionRailEnabled` 后按钮随操作栏一起移除。
- **B2**：`showTopicTags=false` → 可见 `.betterld-topic-card__tags` 30 → 0，切回 → 29
  （1 张卡片本来就没有标签，`hidden` 生效）。
- **B3**：`showTopicViews/showTopicLikes=false` → 对应 `[data-betterld-stat]` 可见数 0（其余统计仍在）；
  `showTopicActivityTime=false` → 可见元信息片段 0、分隔符 0；`showTopicReplies=false` 时同理；
  两个都关 → `.betterld-topic-card__meta` 整体隐藏；全部切回后统计 6、元信息 30。
  同时确认元信息文案与改动前一致：本站在列表行上只渲染活动时间（`compactMetaParts` 的 replies 组
  选中的类名 `.topic-list-data.num.posts/.posts/...` 在该站当前版本里已不存在），改动前同样是「2 小时」这种单段文本。
- **B4**：把 2 个卡片 id 写进 `betterld.visited-topics` → 不刷新页面，靠 `storage.onChanged` 触发重建，
  `[data-betterld-badge="watched"]` 出现 2 个且 id 与写入的两个 id 一致；`showTopicWatchedState=false`
  → 可见数 0；清空列表 → 徽标全部消失。另外在真实主题页验证了记录链路：进入 `/t/topic/2916380`
  后该 id 被追加进本机列表（3 条旧记录保留）。
- **B5**：`/search` 页与首页欢迎横幅搜索框（`input.search-term__input`）都能弹出面板：
  2 条历史、`role=listbox`、位置贴在输入框下方且在视口内（首屏 rect 440×129、left 与输入框对齐）；
  点条目 → 输入框回填「甲」并关闭面板（搜索页输入框没有 form，因此只回填不提交）；
  单条删除 → 存储剩 1 条且面板仍在（重绘后仍存活）；删到空 → 面板关闭；
  `confirm` 拒绝时清空不动数据，确认为真时清空并关闭；关掉 `searchHistoryPanelEnabled` 后不再弹出。
  回归：搜索推荐（A 类能力）在扩展后的 `searchInputs()` 上仍工作（占位变「推荐词甲」、空回车回填、关闭后恢复「搜索」）。
- **B6**：关于页「检查更新」按钮与状态行渲染正常（截图复核无裁切），点击后走后台消息链路；
  预览环境没有后台 API，状态按设计显示失败原因「后台消息 API 不可用…」，不伪造成「已是最新」。
- **B7**：真实导航胶囊上逐取值点击（`window.open` 打桩记录、`currentTab` 用当前页链接避免真的跳走）：
  非首页 `/latest` → `currentTabIfHomepage` 开新标签页、`currentTabIfNotHomepage` 不开；
  首页 `/` → `currentTabIfNotHomepage` 开新标签页、`currentTabIfHomepage` 不开；
  `newTab` 开新标签页、`currentTab` 不动、`background` 走后台路径（预览下报「后台标签页打开 API 不可用」）。
  顺带确认站点 SPA 会重渲染导航，验证脚本每次都要重新取节点，否则测到的是游离节点。
- **B8**：真实 `#site-logo` 是 `<img class="logo-big" id="site-logo">`（不是容器），
  描边/发光/组合滤镜的计算值分别落在该元素上，`siteLogoVisible=false` → `display: none`，恢复后 `filter: none`。
- **设置界面**：13 个新设置行全部渲染（主题卡片 6 个、搜索 1 个、Header 与 Sidebar 3 个、打开方式枚举 5 项 ×2），
  操作栏项目编辑器出现「切换卡片样式」行（含排序与显隐），标题 0 处截断；截图复核主题卡片面板、
  关于面板无裁切、可滚动（`settings-scroll` 3250 > 687）；`panelOverflow` 与既有页面一致（不是本次引入）。
- **回归**：`/latest` 30 张卡片正常构建，作者链接按权威用户名出现（滚动进视口后按既有限速队列继续加载，
  无 failed），标签行、分类胶囊、摘要与原有元信息排版与改动前一致。

未能验证的部分（如实记录）：

- `src/background.js` 的 `check-update` 与 `open-link` 两个消息处理：本机只读预览服务不加载 MV3 扩展，
  后台进程无法在预览里跑通，只做了 `node --check` 静态检查与「预览下失败路径可见」的验证。
- Firefox 未实机验证（Orca 只能跑 Chromium），新增 CSS 只用既有 token 与 `:is()`/`drop-shadow()`，
  没有引入浏览器专属特性。

## 结论

B 类 8 项全部落地并逐项在真实 linux.do 页面上验证通过，`docs/bewlycat-capability-gap.md` 已把 B 类改为
「已全部落地」并记录每项落地语义。唯一未做的是「稍后再看 / 书签」入口——它需要写服务端
（`POST /t/{id}/bookmark`），与「插件不改变 LinuxDo 服务端数据」的不变量冲突，
要做需要主人显式授权（与「在服务端屏蔽作者」同一处理方式）。

改动文件：`betterld.config.js`、`src/settings.js`、`src/content.js`、`src/content.css`、`src/options.js`、
`src/options.html`、`src/background.js`、`manifest.json`、`scripts/orca-preview.js`、`CONTEXT.md`、
`docs/bewlycat-capability-gap.md`。

本轮没有提交：分支上还带着上一次会话遗留的未提交改动（设置面板对齐/话题页修正等），
是否要把这两部分拆成提交由主人决定。
