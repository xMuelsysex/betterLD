# betterLD 项目流水

## 2026-09-18（再×8）：侧栏亚克力封面左右内缩

- 主人要求侧栏亚克力「不要超过左边的竖栏，右边也缩短同样的距离保持对称」。
- 改法：把亚克力表面（底色/描边/圆角/阴影/blur）从 `nav.sidebar-container` 自身盒子移到 `::before`，
  伪元素 `inset: 0 var(--betterld-sidebar-cover-inset)`（9px）——封面左右各内缩 9px、对齐侧栏内容列，
  **内容位置不变**（只换承载表面的盒子）；`sidebarCoverBlurEnabled=false` 的不透明变体同样落到伪元素。
- 实测：改前封面 `[11, 272]` → 改后 `[20, 254]`（对称内缩 9px），首个侧栏链接仍在 `[19, 241]`；
  两种变体的底色/blur/阴影都正确；`scrollWidth 1982 ≤ innerWidth 1997` 无溢出；截图确认无裁切。
- `npm run check` exit 0、`src/content.css` 花括号 563/563、`git diff --check` 通过。

## 2026-09-18（再再再再再再再续）：话题页 Header 毛玻璃块横向加宽

- 主人要求毛玻璃块再宽一点。**踩到的关键点：这块的宽度由站点五列网格的中间轨道决定**
  （`.d-header .contents` = `261px 27px 1320px 27px 261px`），`width`/`max-width` 甚至行内 `!important`
  都改不动它（逐一实测确认）。可行解是 `box-sizing: content-box` + 左右 `padding` 外扩 + 等量负 `margin` 抵消，
  面板变宽而标题位置不变（实测标题 left 恒为 352）；padding 用 `min()` 夹住两侧可用空间，窄屏不溢出。
- 外扩量是 token `--betterld-title-block-extra-width: 240px`。实测面板 `[211, 0, 1562, 52]`（改前 1320 宽），
  `scrollWidth 1982 ≤ innerWidth 1997` 无横向溢出，截图确认内容未裁切。
- `npm run check` exit 0、`src/content.css` 花括号 562/562、`git diff --check` 通过。

## 2026-09-18（再再再再再再续）：话题页 Header 标题块加毛玻璃

- 主人贴出话题页 `.d-header .extra-info-wrapper`（drop-down 模式下 Header 里的标题/分类/标签块）要求加毛玻璃。
- 改法只有 `src/content.css` 一条规则：该块用 `rgb(var(--betterld-surface-container-rgb) / 0.72)` +
  `blur(var(--betterld-surface-blur)) saturate(135%)` + `--betterld-radius-lg` + 1px 描边 + `--betterld-shadow-level-1`，
  与既有 `headerVisualMode=frosted` 同一套 token；不改站点几何、不新增设置项。
- 真实话题页验证（取焦、滚动进 drop-down）：`background rgba(33,31,38,0.72)`、`backdrop-filter blur(20px) saturate(1.35)`、
  `radius 20px`、`border 1px rgba(147,143,153,0.24)`、rect 仍是 [331,0,1320,52]；截图确认内容无裁切。
- `npm run check` exit 0、`src/content.css` 花括号 562/562、`git diff --check` 通过。

## 2026-09-18（再再再再再续）：首页导航底板恢复「随滚动自动收起」

- 主人贴出首页的 `div.list-controls` 要求恢复自动收起。根因是收起的三个条件只认
  `body.betterld-topic-page` / `body.betterld-categories-page`，而 `betterld-topic-page` 只在
  「主题列表页且非首页」时挂（`topicListPage && !home`）；linux.do 的首页就是「未读」列表，
  于是首页的 `data-betterld-scroll-state` 从来没写过、底板永不收起，`/latest` 等页面一直正常。
- 改法只有两处选择器：`content.js` 的 `listControlsSelector` 与 `content.css` 的
  `[data-betterld-scroll-state="hidden"]` 规则里加入 `body.betterld-home`（字体作用域那条规则本来就是三者并集）。
  状态机、阈值、inert、过渡都没动；主人 `autoHideHeader`/`autoHideSidebar` 均为关，所以只影响底板。
- 真实页面验证（取焦）：首页滚到 1800 → `state=hidden / opacity=0 / translateY(-102px) / pointer-events:none / inert`；
  滚回 400 → `state=visible`，过渡结束 `opacity=1 / rectTop=52`；`/latest` 同样正常、无回归。
- `npm run check` exit 0、`src/content.css` 花括号 561/561、`git diff --check` 通过。

## 2026-09-18（再再再再续）：阅读卡刷新不出来的真根因 = 列表同步被一行无链接行打崩

- 主人指出「M3/原生刷新正常，阅读卡有的时候刷新不出来」，并且「阅读卡刷新不用移动到最下面，仿照原生卡片」。
  这轮定位到**两个真 bug**，都在 `src/content.js`：
- **同步彻底停摆**：`itemSignature` 直接读 `topicInfo(item).id`，而站点重渲染期间会出现**没有主题链接的行**
  （`topicInfo` 返回 null）。只要列表里有这样一行，`syncHomepage` 每次都在 `setTimeout` 回调里抛
  `TypeError: Cannot read properties of null (reading 'id')`（抓到堆栈：itemSignature:3285 → signature:3292 →
  rebuildContainer:3516 → syncHomepage:3615）→ **站点把新帖插进表格，我们的网格再也不重建**，
  一直坏到重载页面（这就是「有的时候刷新不出来」）。修法：null topic 返回空串（这类行本来就被 createCard 跳过），
  不加宽泛 try/catch。
- **阅读卡「被丢到最下面」是滚动锚定的放大**：站点把 N 张新帖插到最前面时，浏览器锚定会把人向下推
  N × 单卡高度 —— 原生行 ~57px、M3 卡 ~200px、阅读卡 ~430px，所以只有阅读卡明显感觉被带到最下面。
  改成：**列表顶部主题变化（新帖插到最前面）就回到页首**，尾部追加（加载更多）不受影响，
  不再依赖「点了刷新」这个意图，晚到的插入也会被带回页首。
- 真实页面验证（阅读卡、标签页取焦）：改标题 → 卡片跟着变；插入一行无链接行后同步仍活着；
  滚到 y=1488 点站点刷新提示 → 站点插 24 条（rows 30 → 54）、**y=0**；删掉列表首行 → y 2054 → 0；
  尾部追加不动滚动。
- **重要环境坑**：预览标签页在后台/被冻结时 MutationObserver 与站点自己的异步渲染都会停摆，
  会让「站点刷新」和「我们的同步」同时看起来是坏的（我因此先误判成站点行为，还在无插件的对照标签页上得到同样的假象）；
  验证前必须 `orca tab switch --page <id> --focus` 并确认 `visibilityState === "visible"`。
- `npm run check` exit 0、`git diff --check` 通过。详见 `.pi/tasks/2026-09-18-refresh-scroll-and-rail/task.md`。

## 2026-09-18（再再再续）：刷新失效的追加取证（插件不放大站点请求）

- 主人反驳「同样的网络环境原版能刷新、上插件就不能刷新」。做了对照测量：
  **插件静置 60s 只产生 2 个请求**（站点的 message-bus 轮询），站点列表请求与 `/t/*.json` 元数据请求都是 0，
  无 429、无弹窗 —— 插件的 DOM 托管没有让站点反复拉列表，也没有重复请求已缓存的元数据。
- **这个站点的刷新端点其实是 `/unseen.json`**（不是 `/latest.json`）：原版点同一条提示 → 200、30 → 60 行、
  视口不动（2262 → 2980），与插件下完全一致 → 「位置不动」是浏览器滚动锚定的固有行为，
  插件此前的差别只是没把视图带回页首（已修）。
- **真正让「刷新失效」的是站点自己的限速弹窗**：它开着时 `.dialog-overlay` 吞掉整页点击。
  循环是：第一次刷新看不出变化（视口被锚定）→ 再点几次 → 触发站点对自身端点的限速 → 弹窗挡住所有点击。
- 修正后的真实页面复核（新环境）：点站点刷新提示 → 卡片 30 → 33、**scrollY 1996 → 0**、无弹窗；
  操作栏刷新按钮开关打开即出现（`settings/layout/refresh`）。
- 环境提示：本机 Orca profile 被反复加载过，CF 质询与站点限速状态都被加热，在 Orca 里做「原版 vs 插件」
  A/B 不干净；另外 Orca runtime 在我这轮里重启过两次（runtimeId 变化），标签页会随之消失。

## 2026-09-18（再再续）：刷新后回到页首 + 操作栏刷新按钮开关不生效

- 主人反馈「主页向下翻之后刷新帖子位置不动，永远在最下面看不到上面刷新的帖子」，同一条消息里还贴了站点弹窗
  「You've performed this action too many times…」。定位出**三件事**，都在真实标签页取证：
- **那条文案是站点自己的限速弹窗**，它当时就开在主人的标签页里：`.dialog-overlay`（`pointer-events: auto`）
  盖住整页，`document.elementFromPoint(刷新条中心)` 返回 `.dialog-overlay` —— 点击根本没落到页面上，
  所谓「刷新了位置没动」有一部分是刷新动作压根没发生。已在真实页面点掉弹窗并确认点击恢复。
  顺手排除我们的嫌疑：挂 fetch 探针滚动，21 次 `/t/{id}.json?include_raw=1` 全部 200、间隔 250–500ms、
  无 429/无 CF 质询、失败卡片 0、弹窗未复现 —— 限速来自站点侧动作，不是 betterLD 的元数据请求。
- **关掉弹窗后仍有的行为**：点站点「查看 N 个新的或更新过的话题」会把列表变长（实测卡片 45 → 53，
  站点表格行同步增长、我们的网格跟着重建），而浏览器滚动锚定把旧内容钉在原地（scrollY 2198 → 6465），
  刷新的帖子留在视口上方。改成：点刷新条时记一个 10s 窗口的意图，**列表重建完成时把视图带回页首**
  （`config.listRefreshScrollTopWindowMs`）；实测点击后提示消失、卡片 45 → 53、scrollY 0。
- **顺带修掉一个真问题**：主人已经打开「显示刷新按钮」却看不到按钮 —— 根因是双重门控
  （`actionRailItemsConfig.refresh.visible` 与 `showRefreshButton` 同时生效）。现在返回顶部与刷新
  只由各自开关决定，从 `actionRailItems`（操作栏项目编辑器）里移出，位置固定在操作栏尾部
  （新增 `actionRailTailOrder`）；实测三种组合（分离 / 合并 / 只开刷新）按钮都按预期出现。
- 环境坑（重要）：预览只在页面缺 `__betterldPreviewInjected` 时注入，而 content.js 有
  `__betterldContentScriptActive` 守卫 —— **同一文档里再注入一次不生效，会继续跑旧脚本**；
  排查时必须看 `__betterldPreviewInjected.at` 确认文档真的换了。另外 `location.assign` 整页导航会触发
  Cloudflare 质询（1–3 分钟自愈），验证用 `location.reload()`。
- `npm run check` exit 0、`git diff --check` 通过。详见 `.pi/tasks/2026-09-18-refresh-scroll-and-rail/task.md`。

## 2026-09-18（再续）：B 类能力补齐 8 项（新分支 feat/b-class-capabilities）

- 主人要求「新建一个分支来完成 b 类还缺少的」：分支已从 main 当前工作区切出，
  `docs/bewlycat-capability-gap.md` 的 B 类 8 项全部落地，清单里 B 类改成「已全部落地」并逐项写明落地语义。
- 落地要点（每项都只在既有机制上扩，不新造第二条路径）：
  **B1** 浮动操作栏新增 `layout` 项，按 `settingsEnums.topicListLayoutMode` 循环阅读卡/M3 卡片/原生列表，
  只写 `topicListLayoutMode`；**B2** `showTopicTags` 只隐藏阅读卡标签行；
  **B3** `showTopicMeta` 仍是总开关，新增 `showTopicActivityTime`/`showTopicReplies`/`showTopicLikes`/`showTopicViews`，
  元信息行拆成 `data-betterld-meta-part` 两段、统计打 `data-betterld-stat`，全部按根 dataset 由 CSS 显隐（不新增请求）；
  **B4** `showTopicWatchedState` + 本机浏览记录（`visitedTopicStorageKey`，进 `/t/{slug}/{id}` 时记 id）→ 卡片「已看」徽标；
  **B5** `searchHistoryPanelEnabled` 搜索框聚焦浮层（回填/单条删除/清空）；**B6** 关于页「检查更新」经后台取 GitHub Releases 最新 tag；
  **B7** `navigationOpenMode`/`searchOpenMode` 补 `background` + 两个条件取值，解析只在 `linkOpenBehavior` 一处，
  后台标签页能力泛化成 `open-link`（仍只接受 linux.do 链接）；**B8** `#site-logo` 的显隐/描边/发光。
- **B4 差点埋在启动顺序里**：浏览记录是异步读出来的，第一次建卡片时集合还是空的；把「已看」加入
  `itemSignature` 并在读到本地记录后补一次 `scheduleSync()`，同时在 `storage.onChanged` 里接上这个键，
  徽标才会出现（否则只有刷新后偶发出现，属于「设置了不生效」那一类）。
- **预览桩会把新键吃掉**：`scripts/orca-preview.js` 的 storage 桩原来只把 settings 与本地壁纸两个键写回内存对象，
  整页刷新后任何新增本地键都被静默丢弃——「已看标记」因此一度被判成不生效。改成整份持久化对象回填，
  预览才等于 storage.local 的可信替身（顺带解释了上一轮 visited 列表消失的现象）。
- 顺带修的相邻缺陷：`normalizeOrderedConfig` 现在会用默认值补齐老配置缺少的新配置项（否则已存过
  `actionRailItemsConfig` 的用户永远看不到 `layout` 入口）；`navigationItemId` 补 `/unseen` 映射
  （站点「未读」胶囊此前既不在导航编辑器里也没有打开方式处理，而 `topicNavigationItems` 里本来就有 `unseen`）；
  搜索输入集合补上站点自己的 `input.search-term__input`（首页/列表页的欢迎横幅搜索框），
  使历史面板与搜索推荐在这些位置也生效（已验证推荐功能无回归）。
- 两个实现坑：面板里的按钮点完就重渲染换掉，`event.target.closest()` 在换掉之后找不到面板，
  会把刚重绘的面板误关 → 改用 `event.composedPath()`；`compactMeta` 拆段后仍有一处
  `itemSignature` 在调用旧函数名（`node --check` 查不出未定义引用），实机页面直接 0 卡片才暴露出来。
- 真实页面验证（Orca preview + 复用已过质询的标签页）：B1 三态循环与 URL/列表恢复、B2 标签 30→0→29、
  B3 各细分开关的可见数与元信息两段、B4 徽标按 id 命中且随开关隐藏、B5 两处输入框的面板与删除/清空、
  B6 失败路径文案、B7 首页/非首页 × 各取值的新标签页矩阵、B8 真实 `<img id="site-logo">` 的滤镜与显隐、
  设置界面 13 个新行与操作栏「切换卡片样式」行（截图复核无裁切）。`npm run check` exit 0、
  `git diff --check` 通过、CSS 花括号 561/561 与 185/185。详见 `.pi/tasks/2026-09-18-b-class-completion/task.md`。
- 未做：`show_video_card_watch_later` 对应的「稍后再看 / 书签」入口要写服务端（`POST /t/{id}/bookmark`），
  与「插件不改变 LinuxDo 服务端数据」的不变量冲突，需主人显式授权；后台 `check-update`/`open-link`
  两个消息在预览环境无法实机验证（预览不加载 MV3 扩展），只做了静态检查与失败路径验证。

## 2026-09-18（续）：话题页三处修正（卡片圆角 / 时间轴黑边 / 刷新回页首）

- 主人报了三个问题：用户卡片「四个角好像有两个弧度」、话题时间轴滑块有黑边、页面最底部刷新后停在原位不回页首。
- **卡片双弧线是两层同心圆角错开**：站点把 `.user-card` 放进 `.fk-d-menu__inner-content`，两层都画材质面 + 1px 描边，而我们给卡片的是 `--betterld-radius-xl`（24px）、给浮层容器的是 `--betterld-radius-lg`（20px），卡片又比容器内缩 0.667px → 每个角有两条弧线（对角像素采样能看到两个亮峰）。修法：卡片在外层菜单容器里时 `border: 0` + 圆角对齐到容器（20px），底色/模糊保留。
- **时间轴黑边是站点主题的 outline**：逐表禁用隔离 + 抓取 CDN 上的 `common_theme_-2_*.css` 定位到 `.timeline-container .topic-timeline .timeline-scrollarea .timeline-handle { outline: 3px solid var(--d-content-background) }`（深色模式下就是近黑）。betterLD 只关掉这条 outline，不动底色与 10px 圆角。
- **刷新停原位是站点自己的跳转**：linux.do 上 `history.scrollRestoration` 被站点设成 `manual`，浏览器不会恢复；真正拉回底部的是站点话题页的「跳回上次阅读位置」（实测 `location.reload()` 后 y 3913 → 3021，URL 被改写成 `/t/topic/2916181/6`）。所以单纯设 `scrollRestoration` 没用；改为刷新前写一个 sessionStorage 意图，由刷新后的页面接管，在 `refreshScrollTopWindowMs`（2.5s）内把位置钉在顶部、已在顶部时不动作，窗口过后失效；接管与清除在 `checkRoute` 轮询里完成，参数放在 `betterld.config.js`。
- 真实页面复核：卡片对角采样改后只剩单弧线（卡面色恒为 `(33,31,38)`），时间轴滑块 6 倍放大截图无黑环，底部刷新后 y=0 且窗口过后人为滚到底部会停在底部（不会被持续抢滚动）。`npm run check` exit 0、`git diff --check` 通过、`src/content.css` 花括号 541/541。详见 `.pi/tasks/2026-09-18-topic-page-polish/task.md`。

## 2026-09-18：设置面板左侧图标居中 + 选项文字截断修复

- 主人要求：左侧竖列图标对齐、面板里有的选项文字显示不全。两处都只在 `src/options.css`，共 7 处改动，未动 JS/config。
- **图标偏右的根因是列表宽度没算自己的 1px 边框**：`.settings-rail__list` 内容盒只有 38px，而 `.settings-rail__item` 是 `padding: 0 12px` + 20px 图标 → 左 12 / 右 6，折叠方块里图标偏右、激活底色是 38×40 的椭圆。改为列表宽度 `+ 2px`（内容盒正好 40px）、图标内边距 `(40 - 20) / 2`；实测 7 项全部 `gapLeft 10 / gapRight 10`、方块 40×40 正圆。
- **选项文字被截断是「右列可压缩 + 62% 上限」**：`.settings-field__right` 的 `flex: 0 1 auto` 让 flex 按左列说明文字的 max-content 比例压缩控件，`max-width: 62%` 又把 5 段控件卡在 423px（每段 83px）；控件自己 `overflow: hidden` + ellipsis，于是「跟随 LinuxDo」「Material 3 卡片」「最新回复」「仅使用浏览器缓存」等 17 个标签被省略号截掉（`话题排序方式` 的控件在 683px 行里只剩 92px）。改为右列 `flex: 0 0 auto` + `max-width: 100%`、行 `flex-wrap: wrap`、左列 `flex: 1 1 280px`：控件永远保持自身宽度，放不下时整行换行（控件独占一行、贴右），放得下时说明文字换行让位；≤760px 的列方向布局补 `flex: 0 1 auto`，否则 `flex-basis` 会变成高度。
- 验证：所有面板 + 条件字段强制显示后，设置项 0 处截断、0 处行溢出（修前 17 处截断 / 2 处行溢出）；视口 1440→800 逐档无元素越过滚动容器；与「改动前 CSS」逐元素几何 diff（1310 元素）无增删、无变矮，宽度变化只在 rail 与 `.settings-field__*`；顺带修正了开关、滑块、文本框此前被压缩的宽度。`npm run check` exit 0、`git diff --check` 通过、`src/options.css` 花括号 185/185。详见 `.pi/tasks/2026-09-18-settings-rail-align-and-text-clip/task.md`。

## 2026-09-17（续）：A 类设置补齐 + 站点限速优化

- 主人要求把 A 类（已进设置界面但无运行时效果）的 7 项补齐，并优化测试中多次出现的 L 站限速警告。
- **限速根因不是请求太多，而是请求长得不像站点的**：同样一个 `/t/{id}.json?include_raw=1`，
  只带 `Accept: application/json` 时 Cloudflare 返回 **403 + HTML 质询页**（响应头 `cf-mitigated: challenge`），
  换成站点自己的 AJAX 指纹头（`X-Requested-With: XMLHttpRequest` + `Discourse-Present: true`）就得到 `200 application/json`；
  `Discourse-Present: true` 单独也够用，`X-Requested-With` 单独不够。原来的代码只带 Accept，叠上每张卡片的并发与重试，
  直接把整个 profile 送进质询状态（连页面导航也变成“Just a moment...”）。现在 content.js 用共享常量 `discourseAjaxHeaders` 发这两个请求（topic GET 与 notification_level PUT）。
- 第二层是并发与重试放大：修前每张卡片构建时立即 `loadAuthor()`，30 张卡片同时发出 30 个主题请求，失败还各自重试 2 次 + 1 次 recovery。
  现在：作者与摘要都按视口加载（`cardObserver`，rootMargin = `excerptRootMargin`），全部主题请求过全局队列（`topicRequestConcurrency` / `topicRequestMinGapMs`），
  429/503/CF 质询触发全局暂停（优先 `Retry-After`，否则 `topicRequestPauseMs`）并只安排一次失败卡片补扫；再加一层 `sessionStorage` 跨导航缓存（`topicMetadataCacheTtlMs`）。
  实测（`/latest`，30 卡）：首屏 4 个请求（视口内）、滚动后每屏 8 个、起始间隔 319–560ms、`failed: 0`，修前是 30 并发。
  `observeCard()` 仍会在「按活动天数过滤」开启时整列表排队（该过滤需要每张卡片的活动时间）。
- A 类 7 项的落地语义（按 BewlyCat 对应项，帮助文本同步改成描述真实行为）：
  `sidebarCoverBlurEnabled` 开=侧栏壁纸高斯模糊封面（`rgba(33,31,38,0.78)` + `blur(18px)`）/关=不透明表面；
  `liquidSegmentIndicatorEnabled` 设置页分段控件滑动液态指示器（`.settings-window[data-betterld-liquid]` + `.settings-segmented__indicator`，位置由 JS 量 active 项 offset 写入，`showCategory` 与 ResizeObserver 重同步）；
  `separateNavigationActions` 关时合并为单个 `topOrRefresh`（图标随 `data-betterld-scroll-top` 切换，两个动作各自受「配置里可见 + 开关已开」双重门控）；
  `enableUndoRefresh` 刷新前把卡片网格与 `scrollY` 存进 `sessionStorage`，重载后工具栏出现「撤销刷新」（用 `replaceChildren` 只换网格内容，不动 `managedSources` 引用）；
  `searchMode=cards` 只用 CSS 重排站点已返回的 `.fps-result`（不额外请求）；
  `searchResultsPaginationMode=pagination` 把 `.load-more-sentinel` 移到视口外禁用自动加载，改用自带按钮：恢复触点 + 补发一次 `scroll`（站点的加载器挂在 scroll 上），50→100 条实测通过；
  `searchRecommendationEnabled` 用本机搜索历史做占位推荐词，空输入回车在捕获阶段先填入再交给站点提交。
  站点搜索建议接口 `/search/suggest.json` 被 CF 403 挡住，所以没有采用网络数据源。
- 验证要点：`IntersectionObserver` 回调只在标签页被 `orca tab switch --focus` 取焦后才会投递，验证视口门控必须先取焦；
  站点对本 profile 的整页导航频繁弹质询，重载需等 1–3 分钟或点一次复选框自愈。
  `npm run check` exit 0、`git diff --check` 通过、CSS 花括号 539/539 与 184/184。详见 `.pi/tasks/2026-09-17-a-class-completion-and-rate-limit/task.md`。

## 2026-09-17（续）：设置窗口居中 + BewlyCat 可用能力缺口核对

- 主人要求「把设置界面移到中间」，并核对 BewlyCat 里能用但没做的能力。
- 居中根因不是 `place-items` 写错，而是**外层文档规则赢了 shadow 里的 `:host`**：页面内设置窗口的宿主 `.betterld-settings-dialog__surface` 被 `src/content.css` 的 `display: block` 接管后，options.css 的 `:host { display: grid; place-items: center }` 失效，只剩 `justify-items` 起作用——横向被居中、纵向贴顶。实机证据（linux.do/tags，1145×765）：宿主计算 `display: block`，`.settings-window` rect `[37, 0, 1072, 689]`（底部空 76px）；页面里强制 `surface.style.display="grid"` 后变 `[37, 39, …]`；独立设置页（`body` 为 grid）同为 y=39。
- 改法只有一条规则：`content.css` 里把同一个外层选择器写成 `display: flex; align-items: center; justify-content: center;`（保留 width/height/overflow）。窗口尺寸、内部布局与 ≤1279px 的响应式分支都不动。改后实机 rect `[37, 38, 1072, 689]`，双轴居中；7 个主分类逐个点击正常、`#settings-scroll` 可滚到底（2676/687）、关闭后 `open=false`、重开后仍 y=38；独立设置页仍居中（未受影响）。
- 同屏顺带修的缺陷：卡片操作菜单排序编辑器最后一行显示裸键 `ignoreAuthor`（`options.js` 的 `labelMap` 少一条），补成 `content.js` 里的权威中文「在服务端屏蔽作者」，并在真实浏览器页面读取 10 行标签确认。
- BewlyCat 缺口（对照 `~/.x-repo/github.com/keleus/BewlyCat` 的 Settings 组件 + `searchCatalog.ts`）：清单已归并到 `docs/bewlycat-capability-gap.md`（唯一权威源），
  当时分三类：A 类（已进设置界面但无运行时效果，7 项，已于 2026-09-17 补齐）、B 类（可搬运未实现，8 项）、C 类（明确不做）。
- 工具侧改动：`scripts/orca-preview.js` 新增 `--page <tab-id>`，复用已经通过 Cloudflare 质询的现有标签页（新建标签页现在大概率被挑战）。本机 preview 会在整页重载后重新注入新资源，仍是唯一可信的实机验证路径。

## 2026-09-17（再再再再下）：全站覆盖审计——补齐静态页、聊天、自有用户标签、群组页与登录页

- 主人要求「检查一下网站是 linuxdo 的还有没有没做改造的了」。清点方式：按**独立布局**而不是按 URL 清，运行时扫不透明表面 + **静态反查站点样式表**两层判断。
- 静态那层是必需的：本轮审计期间浏览器跟随系统切成深色主题，白底扫描在深色下天然抓不到白色，只有反查 `common_*.css` / `chat_*.css` 里哪些选择器用了 `var(--d-content-background)` 或 `var(--secondary)`（浅色下即白/近白）才能定出真正的白底来源。用这个方法拉出站点整页底板类清单：`.body-page`、`.container.badges`、`.container.group`、`.container.groups-index`、`.container.tags-index`、`.directory`、`#header-list-area`、`#list-area`、`.list-controls`、`#main-outlet.not-found-container`、`#main-outlet>.regular`、`.private_message`、`.reviewable`、`.search-container`、`.show-badge`、`.user-main`。
- 本轮补的缺口：静态文档页 `.body-page`（`/faq`、`/guidelines`、`/tos`、`/privacy`、`/about`）、404 页 `#main-outlet.not-found-container`、徽章详情 `.show-badge`、登录页 `.login-fullpage`（探针验证）→ 内容材质面；聊天 `/chat` 的 `.full-page-chat` / `.chat-message-container`×50 / 导航栏 / 置顶条 / 频道状态 / 分隔文字 → 透明化 + 输入区控制面（不透明表面 63 → 5）；AI 机器人输入区；linux.do 自有用户页标签（作品集 / 邀请 / 关注 / 结算）把 `.user-content` 当整页底板 → `.user-content` 统一透明、`.follow-stream-item` 归内容材质面；群组页 `.container.group` 内的 `section.user-content` 与组内下拉；高级搜索 `.search-advanced-filters` 面板与筛选输入。
- 顺带收窄作用域：`.select-kit` 那 6 条规则的选择器组从 `:is(.category-navigation, .category-breadcrumb)` 换成 `#main-outlet`（组页、搜索页等处的下拉一并纳入，侧栏主题下拉仍在 `#main-outlet` 之外不受影响）。
- 有意保留：`/upcoming-events` 的日历是第三方 FullCalendar 组件；帖子正文的 blockquote / 代码块属内容排版；`/admin`、`/review` 需更高权限无法验证；站点未启用的 `/directory`、`/invite`（均 404）不写规则。
- 回归：`/latest` 面包屑下拉 `rgba(28,27,32,0.56)` 仍生效、侧栏主题下拉仍透明、30 张卡片正常；`/u/lost_myself/summary` 与 `/tags` 复扫干净。`npm run check` exit 0。详见 `.pi/tasks/2026-09-17-site-coverage-audit/task.md`。

## 2026-09-17（再再再下）：剩余界面改造——用户页二级导航、私信、偏好设置、用户流与站点按钮

- 主人指令「改造一下剩下的用户界面」按会话上下文理解为：把只做了壳层与白底归一、内容区仍是原生 Discourse 的界面统一到 betterLD 语言。范围：用户页两级导航条、私信页、偏好设置页、用户流列表（草稿/活动）、站点列表表头与默认按钮。
- 导航胶囊**复用同一套规则而不是复制**：把主题列表导航那 6 条规则（容器/`li`/`a`/hover/active/focus）的选择器组从 `#navigation-bar.nav.nav-pills` 扩成 `:is(#navigation-bar.nav.nav-pills, .user-navigation .nav-pills, .messages-nav)`，`@supports not` 兜底块、`forced-colors` 块、减少动效块同步扩同组（共 21 处）。主题导航专属的横向滚动/居中/触屏设置规则保持原作用域——那些设置文案本就写明只作用于主题导航。
- 新增：`.topic-list-header th` 只改字体与分隔线（不动 `th` padding，避免表格列错位）；`.user-stream .user-stream-item` 归入站点内容材质面；站点按钮 `.btn-default`（材质面）/`.btn-primary`（主色，hover 按 `html[data-betterld-mode]` 分别向白/黑微调）/`.btn-danger`（错误色描边）统一形态，只改背景/描边/圆角/文字色，**不改几何尺寸**，因此 `.btn-icon` 图标按钮、`.btn-flat`/`.btn-transparent` 平铺变体不受影响。
- 踩到的坑（记录以免重试）：`tr.topic-list-item` 在 `display: table-row` + `border-collapse: collapse` 下 `border-radius` 不生效（计算值 20px、视觉是方角）。用运行时探针试过 `border-collapse: separate; border-spacing: 0 8px` + 去 cell 边框，行依旧方角、行距反而被拉大，观感更差，**不采纳**；表格型列表保持「半透明行 + 表头分隔线」。
- 实机复核：偏好设置页（导航条 `rgba(33,31,38,0.82)`/20px 圆角、胶囊 16px、`连接` 主色、`删除` 危险色）、私信页、草稿页、主题页底部按钮、`/latest` 卡片网格（无回归）；`/about`、`/upcoming-events` 审计无白底。白底复扫（含 `a/button/summary`）在主题页、私信页、草稿页均为 0。
- 环境限制：收尾时 `/my/preferences/account` 与 `/u/lost_myself/preferences/account` 均 404（同会话 `/about` 仍是已登录），偏好设置页因此没有自动化扫描数字，只有改造后的实机截图与改造前的 surfacescan。整站风控依旧：连续导航会被 Cloudflare 拦成「请稍候…」，等 1–2 分钟自愈。
- `npm run check` exit 0、`git diff --check` 通过、CSS 括号配平 514/514。详见 `.pi/tasks/2026-09-17-remaining-interfaces/task.md`。

## 2026-09-17（再再下）：壳层页面残留的站点纯白表面全部改用 betterLD 材质面

- 主人实机点名两处仍是纯白的表面：主题详情页「更多话题」表里的 `tr.topic-list-item`（站点 `--d-topic-cards` 变体：`oklch(1)` 白底 + 8px 圆角 + 1px `#d1d1d1` 边框 + 12px 内边距），以及鼠标悬浮用户卡片（`.card-content { background: rgb(var(--secondary-rgb), 0.85) }` + 外层 `.user-card { background: var(--secondary) }`）。要求整站查一遍、见白即修。
- 先用扫描脚本（面积 ≥ 2000px²、排除按钮/输入/代码等控件、判定纯白与近白）逐页枚举，结果：`/t/*` 5 行 + 悬浮卡；`/latest` 欢迎横幅搜索框与 类别/标签 下拉 header；`/badges` 109 张 `.badge-card`（5.2M px²）；`/categories` 25 行 `.latest-topic-list-item`；`/search` 容器与搜索框四层；首页 `.list-controls` 导航底板；`/tags`、`/u/*` 本来就干净。
- 统一到两种既有写法，不新造观感：**站点内容卡片**（主题行、徽章卡、最新行、分类盒子、标签面板、用户页正文）用 `surface-rgb / 0.56` + `blur(var(--betterld-surface-blur))` + betterLD 描边/圆角/阴影；**浮层与输入控件**（`.user-card/.group-card/.category-card`、`.select-kit-body`、`.fk-d-menu__inner-content`、`.d-modal__container`、`#reply-control`、搜索框、类别/标签下拉 header）用 `surface-container-rgb / 0.96（搜索框 0.82）`。导航行 `.list-controls` 的作用域从「话题列表页+分类页」放宽到壳层全页——首页那块纯白底板是上一轮有意留给主人决定的，本轮按「见白即修」处理。
- 浮层不是只看计算值：逐个真实打开复核过——底部编辑器（`#reply-control.open`）、通知级别浮动菜单（`.fk-d-menu__inner-content` 400×282）、分享模态（`.d-modal__container` 600×200，body/header 透明），截图无裁切；原生列表模式（`topicListLayoutMode: native`）切过去实测，原本纯白的表格行变成 0.56 材质面，行结构不变。
- 悬浮用户卡片踩到的坑：本机 preview 里 hover 后 `#user-card` 容器常驻但内容始终不渲染（高度 2px，全程无任何网络请求，CDP 真实 hover 与合成事件都试过），无法截图实证。改用**层叠探针**：在真实 `#user-card` 里插入 `.card-content`/`.card-row` 读计算值，得到 `rgba(0,0,0,0)`，证明站点那条 `rgb(var(--secondary-rgb), 0.85)` 被覆盖，探针随测随删。外层材质面（`rgba(243,237,247,0.96)` + 24px 圆角 + 阴影）是实机计算值。
- 主人复核后又点出主题标题区的标签胶囊 `a.discourse-tag.box`（站点 `--primary-low` 灰底 `rgb(232,232,232)`）。根因是**扫描脚本把 `A` 当成控件跳过了**，所有用 `<a>` 承载的块级表面整类漏检——扫描口径要包含 `a/button/summary`，只排除真正的输入控件与图片。重扫补出三项：站点标签胶囊（改成 betterLD 卡片标签写法：`surface-container-rgb / 0.58` + `999px` 圆角 + betterLD 描边，实测三个胶囊计算值符合）、`#dialog-holder .dialog-content`（站点提示/错误弹窗，实测限流弹窗 `rgba(243,237,247,0.96)` + 20px 圆角）、`.user-main .details`（用户页简介卡 `rgb(248,248,248)` → 内容材质面）。
- 收尾复扫（含 `A`、面积 ≥ 800px²）：`/t/*`、`/latest`、`/categories`、`/badges`、`/search`、`/u/*`、首页 全部 0 个纯白表面（`/categories` 首次撞 Cloudflare 质询，重跑后为 0）。`npm run check`、`git diff --check`、CSS 括号配平通过。详见 `.pi/tasks/2026-09-17-shell-white-surfaces/task.md`。

## 2026-09-17（再下）：壁纸背景覆盖全部页面，壳层视觉收敛为单一 betterld-shell

- 主人反馈「背景图片不能只覆盖主页，别的界面也要有」。查下来根因不是配置，而是作用域：壁纸 + 遮罩 + Header/Sidebar 这套壳层视觉在 `src/content.css` 里被复刻了三份，分别挂 `body:is(.betterld-home, .betterld-topic-page, .betterld-categories-page)`、`body.betterld-unmanaged-page`（设置项 `applyToUnmanagedPages`，默认关，且显式排除了 `/t/`、`/u/`）、`body.betterld-search-page`。于是主题详情页、用户页、`/badges` 这类页面在任何设置下都没有壁纸，连伪元素都没有。
- 改法：新增 `betterld-shell` 类，在 `updateRouteState()` 里无条件挂到 `document.body`（content script 只在 linux.do 跑），218 处旧的三页类选择器整体换成 `body.betterld-shell`，三份重复壳层合并成一份；页面级类保留，继续只驱动卡片、导航胶囊、分类盒子等页面级能力。`fontScope: "managed"`（「已管理页面正文」）语义未变，仍留在原三个页面类上，不随壳层扩大。
- `applyToUnmanagedPages` 在壳层全站默认生效后没有任何独立行为，连同 `betterld-unmanaged-page` 一起删掉（config 默认值与分组 keys、settings.js 布尔白名单、options.js 控件与英文标签）。旧存储里的键不需要迁移：`normalizeSettings()` 从 defaults 重建对象，未知键自动丢。
- 光有壁纸不够：站点自己的路由层底板会把壁纸盖住。最终容器透明化清单是 `#main-container`、`#main-outlet-wrapper`、`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`、`.topic-list-container`（统一 `position: relative; z-index: 1; background: transparent`）。路由容器在不同页面是 `.regular`（主题页）、`.container.badges`（徽章页，还在 `section` 里）、`.container`（用户页）——只按直接子元素选会漏掉徽章页，因此补了深度 2 的 `> * > .container`。
- 用户页正文底板 `.user-main` / `#user-content` 没有直接透明化：透明后统计与热门列表的小字直接压在壁纸上，对比度明显变差（截图对照过）。改成与 `.category-heading` 同一套 betterLD 半透明材质面（`surface-rgb / 0.56` + `blur(var(--betterld-surface-blur))` + 圆角 24px + 阴影），壁纸透过面板可见、正文可读。
- Orca 真实页面逐页复核（每次改完源码重载页面拿新资源）：`/t/topic/847468/498`、`/latest`（30 卡 + 卡片菜单 190×392/10 项/z40 未被裁切）、`/u/stellafortuna/summary`、`/categories`、`/tags`、`/search`、`/badges` 全部 `body.betterld-shell` + `::before` 为 `display: block; position: fixed`，壁纸变量有值；设置窗口在用户页打开正常，Shadow DOM 里已无 `unmanaged`（页面行为组只剩 3 项）。`npm run check`、`git diff --check`、CSS 花括号配平 490/490 通过。
- 环境摩擦（沿用既知结论）：整页导航开太多会被 Cloudflare 拦成「请稍候…」，等约 40–60 秒自动放行；截图必须先 `orca tab switch --page <id> --focus`，否则 `Page.captureScreenshot` 超时。详见 `.pi/tasks/2026-09-17-wallpaper-all-pages/task.md`。

## 2026-09-17（下）：隐藏站点实验屏黑角 + 阅读卡统计图标改 Material 轮廓图标

- 黑角来路：`#main-outlet > ul.experimental-screen` 里 5 个 `position: fixed` 装饰块（四角 20×20 + 底部横条 1982×8），颜色是站点深色底 `oklch(0.1 0.025 277.869)`（≈ `rgb(2,3,10)`）。四角方块是盖住内容容器圆角缺口的「屏幕」底色块，容器透明化后就变成黑角，底部横条更显眼。与既有的容器透明化规则组同作用域（`body:is(...)`）整组 `display: none !important`。
- 逐块 A/B（同一页面状态，规则生效 vs 强制 `display:list-item !important`）：底部横条 2,3,9 → 21,19,26；四角也各自变亮；规则生效时 `ul` 计算 `display:none` 且 5 个 `li` 的 `getClientRects()` 全为 0。首页 `/`（`betterld-home`）同样隐藏；分类页与 `/tags` 本轮被 Cloudflare 挡住未实测。
- 统计图标：原来是文本字形 `▢ ♡ ◉`，小尺寸下发虚。改为 CSS 掩膜图标（24×24 Material 轮廓路径：chat_bubble_outline / favorite_border / visibility），形状只写在 `src/content.css` 一处，`background-color: currentColor` 跟文字色，盒子 `width/height: 1em` 由既有 `font-size` 控制（生效值由 14px 提到 16px）；`setReadingStats` 只写 `data-betterld-stat-icon`，不再插字形也不再有回退表。
- 形状只定义一次的好处：`reader-card-preview.html` 的 6 处图标只需把字形换成同名 data 属性就能拿到同样的图标（已实测 file:// 打开：图标 6 个、16×16、mask 已设置）。linux.do 的 CSP 不拦 CSS 掩膜 data URI，`mask-image` 实测生效。
- 本机 preview 注入的样式/脚本带 cache-bust，本轮每次改完源码重载页面即拿到新资源。`npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-17-stat-icons-experimental-screen/task.md`。

## 2026-09-17：话题排序（最新回复 / 发布时间），首页与个人空间生效

- 需求：给话题加排序，两种模式——默认的「最新回复时间逆序」与「发布（或编辑）时间逆序」，首页与个人空间都要生效。
- 先查服务端能力：Discourse 的 `TopicQuery::SORTABLE_MAPPING` 只有 likes/op_likes/views/posts/activity/posters/category/created，**没有「最后编辑时间」**；`post.rb` 里编辑走 `bypass_bump`，编辑首帖也不改 `bumped_at`。因此第二种排序只能落到原生的 `?order=created`（`created_at` 倒序），默认不加参数即 `bumped_at` 倒序。
- 实测 `?order=created` 在 `/`、`/latest`、`/new`、`/c/*`、`/tag/*`、`/hot`、`/top`、`/u/{name}/activity/topics` 全部生效（id 严格递减）；个人空间页面会把 order 透传给 `/topics/created-by/{user}.json`。
- 实现不走前端重排（那只能排当前页 30 条、还要额外 30 次 `/t/{id}.json`），而是让设置映射成服务端 `order` 参数：`topicSortOrders` 只定义一次（`activity:""` / `created:"created"`），`applyTopicSort()` 在 `checkRoute` 轮询里评估——自己写入的取值会补齐，切回默认时只删自己写过的那一个，URL 上其它 `order`（如用户自己选的 `order=likes`）一律不动。个人空间 `/u/{name}/activity/topics` 不在 betterLD 既有页面集合里，单独加进可排序集合；热门与最高保留自身排序语义，不接管。
- 踩到的坑（已修，值得记住）：首版把 `applyTopicSort()` 同时挂在 `applyVisualSettings()` 上，而 bootstrap 会先用 `config.settingsDefaults`（activity）跑一遍，于是带 `order=created` 的文档一启动就删参数并重载，重载后又被解析出的设置加回来——**每 5–6 秒一次的无限重载循环**（preview 日志 3 分钟 36 次注入）。现在只在 `checkRoute` 轮询里调用（放在 href 判断之前，关设置窗口后也能立即落下），并用 `state.settingsResolved`＋bootstrap 的 `{ provisional: true }` 挡住「设置没读出来」阶段；修复后整轮只有 3 次注入。
- Orca 真实页面复核：设置项渲染为「最新回复 / 发布时间」分段控件（中英文标签都在），真实鼠标点击后 storage 落盘、设置窗口打开期间不重载，关窗后 `/latest?order=created` 且 30 张卡片 id 严格递减、活动时间戳非单调；切回最新回复后参数被删除、原生顺序（含置顶）回归；`/hot` 不被接管；`/latest?order=likes` 不被改写；个人空间 URL 变为 `?order=created` 并稳定。真实页面请求量要克制：反复 fetch `.json` 会触发 Cloudflare 风控，连页面导航都会变成「请稍候…」。
- 交付形态是设置项（设置 → 页面 → 主题卡片 → 话题排序方式），没有另加页面内控件：排序由服务端决定，切换必然是一次列表重载，因此设置窗口打开期间不主动重载。`npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-17-topic-sort/task.md`。

## 2026-09-16：主题列表灰底透明化 + 作者用户名可点击进入用户主页

- 「灰底」定位到站点色 token `oklch(0.217785 0.0000108703 23.5956)`：它不在可读的 CSSOM 里（Discourse 样式表在 `cdn.ldstatic.com`，跨源读 `cssRules` 直接 `SecurityError`），只能按计算值反查。全元素扫描得到的可见实例是 `#list-area`（主题列表底板）、分类页的 `#header-list-area` 与 3 个 `.category-box-inner`；首页还多出 `.list-controls`（导航胶囊底板）与欢迎横幅搜索框。
- `#list-area`、`#header-list-area` 加入 content.css 已有的「受管页面容器透明化」规则组（与 `#main-outlet`、`#main-container`、`.topic-list-container` 同一处），分类盒子改用与 `.category-heading` 同一套 betterLD 材质面（`surface-rgb/0.56` + blur + 圆角），内层 `.category-box-inner` 置透明。验证后 `/c/develop/4` 与 `/tag/31-tag/31` 已无任何可见灰底，`/`、`/latest`、`/new`、`/tags` 也一致。
- 作者元素从纯 `<span>` 改为 `<a>`，href 由新增的 `userProfileHref()` 用**权威用户名**拼出（`betterld.config.js` 新增 `userProfilePath: "/u/"`）；用户名形态用 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` 判定，加载中/失败占位与显示名一律不建 href（失败方向是「不建链」，不会指向错误用户）；30 张卡片 ready 与 `[href]` 计数都是 30/30。
- cards 模式下作者链接必然嵌在卡片级 `<a>` 内（CONTEXT.md 的 Card Navigation 不变量要求整张卡片保留原帖链接与浏览器原生操作），因此作者链接在 click 上 `stopPropagation()`（不 `preventDefault`），复用菜单触发器已有做法。真实鼠标点击验证：reading 与 cards 两种模式、currentTab 与 drawer 两种打开方式下点作者都落在 `/u/{username}`（再跳 `/u/{username}/summary`），抽屉未被劫持；对照组点卡片本体仍正常打开抽屉。
- 有意不动（同色但语义不同，留给主人决定）：首页 `.list-controls`（导航胶囊的灰色底板，纳入那条规则会连带把宽度/内边距/外边距带到首页，属于布局变更）与欢迎横幅里的搜索输入框（表单控件需要自带填充底）。
- 「整张卡片一个链接 + 内部二级链接」在 HTML 上是嵌套 `<a>`：该 DOM 由 `createElement` 构建，不经解析器，浏览器按最近可激活祖先执行导航（实测内层链接获胜）。Firefox 未实机验证（Orca 只能跑 Chromium）。
- `npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-16-list-area-author-link/task.md`。

## 2026-09-15：集成服务端屏蔽、等级/旧帖过滤、高亮、垃圾桶与 WebDAV 规则备份

- 服务端 ignore 的接口不从猜：拉社区已验证脚本源码确认是 `PUT /u/{username}/notification_level.json`（表单体 `notification_level=ignore` + `expiring_at` + `acting_user_id`，`X-CSRF-Token` 取自 `meta[name=csrf-token]`），过期时间作为参数放到 `betterld.config.js`。入口是卡片菜单里的显式动作，默认不显示、执行前确认，不做自动批量。
- 旧帖天数过滤用 `/t/{id}.json` 的 `last_posted_at/bumped_at/created_at`（跟作者请求共用），不解析页面上本地化的相对时间；元数据未到位时按 pending 处理。等级取自分类 slug 的 `-lvN` 类名、回退到分类名后缀。命中行为新增 `highlight`：标题内命中词包 `<mark>`、标签/分类 chip 打 `data-filter-hit`。
- 垃圾桶在右下角列出本页被隐藏的主题，可单条/全部还原；还原是页面级覆盖，并会在**规则集变化时自动清除**——否则点过一次「全部还原」之后过滤器会静默失效。关闭垃圾桶时命中项回到「构建阶段不生成卡片」的旧优化。
- WebDAV 规则备份新增 `src/webdav.js`（地址白名单 + Basic + GET/PUT）+ 后台 `webdav` 消息 + `optional_host_permissions`，首次使用按 origin 申请权限；密码不进同步投影与导出文件，导出提示写明不含密码。远程规则 URL 本轮未做，留给主人决定取舍。
- Orca 真实页面验证：等级过滤（Lv1 隐藏 8 / Lv2 隐藏 1，不符预期 0）、`/top?period=all` 旧帖 30 天隐藏 11（与预期完全一致）、高亮模式标题命中 1 张且只有它有 `<mark>`、垃圾桶 9→8→0 且计数同步、菜单出现服务端屏蔽项且作者未就绪与 404 两种错误提示正常、导出抓包确认密码未泄露。WebDAV 传输层在 Node 下对本机回环替身服务器跑通 PUT/GET/认证/错误分支。
- 未覆盖：服务端屏蔽的 200 成功路径（会改动主人账号，未执行）、扩展后台 + 权限申请的真实链路（Orca 内置浏览器不能挂载未打包 MV3）、Firefox。`npm run check`（已含 background/webdav）、`git diff --check` 通过。详见 `.pi/tasks/2026-09-15-filter-integration-round2/task.md`。

## 2026-09-15：主题过滤升级（标签轴 / 匹配模式 / 白名单 / 淡化）

- 先调研 GitHub 与 GreasyFork 上面向 linux.do 的插件与脚本（共 17 个过滤类项目）：社区既定基准是「标题 / 作者 / 分类 / **标签**」四轴，其中 9 个支持标签轴；另有整词与正则匹配、独立白名单、淡化中间态、追加式规则导入。betterLD 原先只有前三轴 + 纯子串匹配 + 隐藏/只显示两种行为。
- 本轮把过滤补齐到基准：新增 `topicTagRules` 与 `topicWhitelistRules`（白名单优先级最高，命中即不过滤）、`topicFilterMatchMode`（contains / whole / regex）、`topicFilterMode` 增加 `dim`；规则导入由全量覆盖改为追加 + 关键词去重；非法正则在保存时被拒绝并给出字段级错误。
- 规则组 key 原来散落在 settings.js / options.js 六处，现收敛到 `betterld.config.js` 的 `topicRuleGroups`，三端从同一处派生；`CONTEXT.md` 新增 Topic Filter 术语与不变量。
- Orca 真实 `/new`（30 张卡）逐项复核：标签轴隐藏 16/30；`whole` 下的「智能」命中 0 张而 `contains` 下命中 16 张（语义差异对照）；`regex ^人工` 命中 10 张；白名单使隐藏数由 16 降为 15；`dim` 下 16 张淡化、0 张隐藏且计算 `opacity: 0.4`（截图灰度统计也确认绘制变暗）；`include` 只留 16 张。设置界面渲染 5 组规则编辑器与新控件，非法正则 `C++((` 被拒、合法 `^【` 通过，规则导入在 confirm 两个分支行为正确且重复关键词未被二次追加。
- 首轮矩阵暴露 `include` 模式被改动条件写坏（30 张全可见），已改为白名单 / include / dim / hide 四分支显式状态机并复测。`npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-15-topic-filter-github-integration/task.md`。
- 明确不集成：自动浏览 / 自动点赞 / 刷已读（会改服务端数据与其他用户可见状态，与 betterLD 不改变服务端数据的既有不变量冲突）与调用 Discourse API 的服务端 ignore（写到账号上，待主人明确要求）。

## 2026-09-15：刷新提示条铺满内容区

- 外层 `.show-more.has-topics` 本来就已是全内容宽，但内层可点击的 `a.alert.alert-info.clickable` 没有宽度约束，收缩成居中窄胶囊（`x=607 w=199`）；给内层补 `flex: 1 1 auto; width: 100%`。
- Orca 真实 `/latest` 复核：提示条由 `x=607 w=199` 变为 `x=315 w=783`，与卡片网格左右边缘完全对齐（`leftDiff=0`、`widthDiff=0`）；截图确认横跨内容区。`npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-15-refresh-notice-full-width/task.md`。

## 2026-09-15：审计设置界面全部控件的提交行为

- 静态枚举后发现：设置项本身靠 `settingsPageBody` 的委派 `change`（input/textarea/select）与 `input`（仅 range，220ms 防抖）落盘，分段控件会派发冒泡 `change`、开关是原生 checkbox，都走同一条路径；真正漏提交的是自绘控件与结构化编辑器。
- 修复 3 处同族缺陷：规则行「删除」只改 DOM 不提交、选择本地图片后不落盘、移除本地图片不落盘（后两处旧文案还写着「保存后生效/移除」，与已取消保存按钮的架构矛盾）。文件 input 的 `change` 会冒泡到委派监听，在异步准备完成前先提交旧状态，因此把它排除出委派提交，改由各自处理器在准备完成后提交。
- 补齐 `docs/adr/0001-settings-immediate-apply.md` 与 `CONTEXT.md` 要求但代码里缺失的确认：导入设置、导入规则、清空搜索历史（原先只有恢复默认有）。
- 顺带修一处设置界面缺陷：`validateCustomCss` 遍历 `rule.style` 拿到的是 CSSOM 展开后的长属性，`margin`/`padding`/`border`/`border-radius` 等简写永远匹配不上白名单，合法简写被误拒（实测报 `不允许的 CSS 属性：border-top-left-radius`）；改为按作者书写的声明属性名校验。
- Orca 真实 `/latest` 逐类控件验证：switch / segmented / range / color / time / text / textarea / radio+url / 有序编辑器 / 规则编辑器 / 壁纸缩略图 / 本地壁纸选择与移除全部即时落盘；白名单仍能拒绝非法属性、at-rule 与非命名空间选择器。
- 破坏性操作用临时覆盖 `globalThis.confirm` 验证两个分支：清空历史、恢复默认、导入设置、导入规则在 false 分支保持不变、true 分支生效；真实点击「清空搜索历史」时页面被模态对话框阻塞（`orca eval` 超时、`dialog accept` 无响应），确认对话框确实弹出。详见 `.pi/tasks/2026-09-15-settings-controls-audit/task.md`。

## 2026-09-15：修复背景图片（壁纸）不显示

- 根因：Discourse 核心 CSS 的 clearfix `body::before, body::after { content: ""; display: table }`。betterLD 的壁纸/遮罩伪元素没声明 `display`，被这个 `display: table` 变成 shrink-to-fit 空表格盒，计算尺寸 `0px × 0px`，壁纸层和遮罩层从此都没被绘制（`data-betterld-wallpaper-state` 早已是 `ready`、`--betterld-wallpaper-image` 也已写入）。
- 修复：`src/content.css` 三个壁纸/遮罩共享规则块补 `display: block`（home/topic/categories+tags、search、unmanaged），共 3 行，作用域仍限定在 betterLD 管理页面。
- 第二个根因（同一功能、同一轮）：设置窗口的内置壁纸缩略图是 `<button>`，点击只改内存 state，不派发 `change`/`input`，因而不触发设置页的委派提交；修复为在缩略图 click 处理器里补 `commitSettings()`（`src/options.js` 共 1 行），复用既有即时生效链路。
- 第二轮 Orca 真实 `/latest` 复核（先点过 Cloudflare 质询）：`.betterld-topic-card` 30 张、`data-betterld-wallpaper-state=ready`；点 `green-white-mountains` → 页面 `--betterld-wallpaper-image` 立即变为该图；点 `night-sky-stars` 500ms 后 `#settings-status` 为 `✓ 设置已保存。`（`hidden=false`、`display=block`、`opacity=1`、`success`）、`#wallpaper-status` 为 `✓ 已应用。`，且 `betterld.settings` 已持久化为 `wallpaperId=night-sky-stars` / `wallpaperMode=builtin`。
- 宿主变体补充：`/latest`（`betterld-topic-page`）`::before` / `::after` 均 `block`、`2030 × 1354`、遮罩 `rgba(20,18,24,0.63)`。`/tags` 本轮被 Cloudflare 反复拦截（`reload` 后仍停在「请稍候…」），未实测，仅按同一 `:is()` 规则块与相同特异性推定。
- Orca 真实页面复核（`builtin` / `rocky-mountain-cloudscape`）：`/` → `::before` `block` `2030 × 1293` + 壁纸 URL，`::after` `block` `2030 × 1293` `rgba(20,18,24,0.63)`；`/search` → 均 `block` `2030 × 1354`；`/guidelines`（`applyToUnmanagedPages`）→ 均 `block` `2030 × 1293`。`maskOpacity=1` 全不透明遮罩下内容层仍完整可见，参数随后恢复 `0.63` / `blurPx 23` / `builtin`。
- 性能对照：壁纸绘制与 `display: none` 两态 rAF 帧间隔一致（约 `1502ms` / `1469ms`），帧率由 Orca 窗口遮挡节流决定，不是壁纸层开销。`npm run check`、`git diff --check` 通过。详见 `.pi/tasks/2026-09-15-wallpaper-display/task.md`。

## 2026-09-15：阅读卡比例改为 1/√2

- `src/content.css` 与 `src/reader-card-preview.css` 的阅读卡 `aspect-ratio` 由 `0.8 / 1` 改为 `0.7071 / 1`（宽高比 1/√2）。
- 独立预览（1440px 视口，本地静态服务）：卡片 `438 × 619`，比例 `0.7071`，无横向溢出，ready / loading / failed / empty 四种状态均正常。
- Orca 真实 `/latest`：30 张阅读卡 `305 × 431`，比例 `0.7071`，5 列网格（每列 `304.66px`），无横向溢出。

## 2026-09-15：修复设置窗口主分类栏点击后不自动缩回

- 根因：rail 的展开条件包含 `:focus-within`，点击按钮后焦点留在 rail 内，指针移开也不会缩回；先改成 `:has(:focus-visible)`，但 Orca 真实点击路径下该按钮仍为 `focus-visible: true`，问题依旧复现。
- 现在只保留 `:hover` 展开（与 BewlyCat 的 `.settings-primary-navigation:hover` 一致），窄屏折叠规则同步；rail 按钮补 `title` 保留名称可读性。
- Orca 真实页面复测：hover 展开 `216px`，点击「页面」后移开指针缩回 `56px`（`hovered:false`、`active:pages`、面板与 heading 正常切换）。`npm run check`、`git diff --check` 通过。

## 2026-09-15：设置界面按 BewlyCat 重做为双层导航大窗口

- 以 `keleus/BewlyCat`（本地只读镜像 `~/.x-repo/github.com/keleus/BewlyCat`）为权威参考重做设置界面：页面内 `90% × 90%`（max `1000 × 900`）大窗口、悬浮在窗口左外侧的主分类 rail（折叠 `56px` / hover 展开 `206px`、圆角 `28 → 32px`）+ 内容区 `180px` 子分类导航，采用「标题 + 描述 / 右侧控件」设置行与 1px 分隔线、`fill-alt` 圆角分组卡与 edge-glow 阴影。
- `betterld.config.js` 新增 `settingsCategories`（7 主分类 / 18 子分类，含 keys 归属）与 `settingsCommitDelayMs`、`settingsSearchResultLimit`、`settingsSearchHighlightMs`；`src/options.html/css/js` 全部重写 UI 层（开关 44×24、segmented、slider、搜索 popover 跳转高亮、事件委托即时生效 + toast），数据层（设置规范化、`storage.sync` 投影、导入导出、规则校验、壁纸引擎、结构化编辑器）保持不变。
- 按用户决定移除保存按钮：改动即时写入并作用于页面；恢复默认、导入、清空历史保留独立确认。深浅模式跟随 betterLD 当前模式（`:host([data-betterld-theme])` + `light-dark()`），主色取页面主题色与对比前景。
- Orca 真实 `/latest` 回归：窗口 `1000 × 900`，rail 7 项 / 子导航 4 项 / 字段 87 / segmented 25 / switch 38 / slider 11；7 个主分类逐一切换均正确；`frostedGlassEnabled` → `--betterld-surface-blur` `16px → 0px → 16px`、`topicListLayoutMode` `reading → cards`（30 张卡片重建）、`cardMinSize` `280 → 320` 且 output 同步；搜索「壁纸」→ 8 条结果 → 跳转「页面 › 搜索」并高亮；rail hover `56 → 211px`；关闭按钮与全部结构化编辑器正常。`npm run check`、`git diff --check` 通过；未覆盖恢复默认的原生 confirm 与 `≤760px` 窄屏实测。详见 `.pi/tasks/2026-09-15-settings-window-bewlycat/task.md`。

## 2026-09-15：三点菜单去圆形底并拉长阅读卡比例

- `src/content.css` 的 `.betterld-topic-card__menu-trigger` 去掉边框、圆形底、圆角与 backdrop-filter，改为透明无边框按钮，只保留 `⋯` 字形和 `36 × 36` 可点击区域；hover/focus-visible 仍变色并保留焦点轮廓。
- 阅读卡比例改为竖长卡片（`1.42:1` → `1.2` → `0.7` → 最终 `0.8:1`，`src/content.css` 与 `src/reader-card-preview.css` 同步），多出的高度由 `flex: 1 1 auto` 的正文区吸收，不改动紧凑排版与窄屏 `250px` 固定高度。
- Orca 真实页面复核（`1.2` 阶段）：卡片 `304.6 × 253.9px`；触发器背景透明、无边框/圆角/阴影，展开菜单仍可命中 9 个菜单项。最终 `0.8` 比例下 1440px 独立预览卡片 `437.7 × 547.1px`、正文区 `375px`、无裁切与横向溢出，生产规则已在浏览器加载的 `src/content.css` 中确认。`npm run check`、`git diff --check` 通过。

## 2026-09-15：修复紧凑阅读卡的菜单、设置和元数据显示

- 阅读卡展开菜单现在将打开卡片提升至 `z-index: 20`、解除卡片 `overflow` 裁切，面板使用 `z-index: 40`；设置 dialog surface 改为 `overflow: auto`，可滚动查看完整设置。
- 标题和正文预览统一调整为 `14px`；主题元数据请求改用 `cache: "no-store"`，并在有限重试耗尽后按配置执行一次恢复重试，避免 Cloudflare 错误响应被 HTTP cache 固化。
- Orca 真实 LinuxDo 回归确认 30 张阅读卡作者状态全部 `ready`，菜单面板实际可命中，设置 surface `scrollHeight=8571` / `clientHeight=828` 可滚动；独立预览在 1280px、390px 无横向溢出，5 种状态和 console 检查通过。`npm run check`、`node --check scripts/orca-preview.js`、`git diff --check` 通过。

## 2026-09-14：增加可切换的 Markdown 阅读卡

- 新增 `reading` 主题卡布局并设为新安装默认值，保留 `cards` / `native` 兼容路径；设置页沿用 `topicListLayoutMode` 枚举自动生成选项。
- 共享 `src/markdown.js` 渲染核心 Markdown，生产卡片从 `/t/{id}.json?include_raw=1` 读取原始正文、权威作者、可用统计与参与者；空字段隐藏、空正文标记为 `empty`，链接协议与 HTML 节点经过安全过滤。
- 新增 `reader-card-preview.html` 独立预览，覆盖 ready、loading、failed、empty 和长 Markdown；桌面卡片约 `1.42:1`，网格下限收缩为 `270px`，预览卡约 `327 × 230px`，窄屏固定 `250px` 高度。
- 按视觉反馈同步紧凑化内边距、标题/元信息字号、头像、标签、正文区和底部操作，缩小后仍保留 Markdown 状态与 `View details`。
- `npm run check`、配置/Manifest 解析、`node --check scripts/orca-preview.js`、`git diff --check` 和本地浏览器/临时 Discourse DOM 烟测通过；1440px / 390px 预览均无横向溢出。真实 LinuxDo 网络回归未在本轮重复执行。详见 `.pi/tasks/2026-09-14-reading-card/task.md`。

## 2026-09-14：将设置页嵌入原网页并改为 Material 3

- 设置入口现在在当前 LinuxDo 页面打开原生 `<dialog>`，不再新建设置 Tab；Shadow DOM 载入并复用现有 `src/options.html`、`src/options.css`、`src/options.js`，外层提供 BewlyCat 风格遮罩、圆角 surface、关闭和焦点恢复。
- 页面 CSP 会阻止 localhost/extension iframe，因此改为 DOMParser + scoped CSS + Shadow root；Orca preview 的 localhost nonce 注入额外桥接页面执行的 `options.js`，生产扩展仍通过 `runtime.getURL()` 读取 web-accessible 资源。
- Orca cache-busting `/latest` 回归确认 `iframe=0`、完整 `#settings-form`、dialog 圆角 `28px`、设置卡片圆角 `24px`；真实保存 `maskOpacity=0.63` 后原页面 CSS 同步为 `0.63`，关闭并重复打开通过。`npm run check`、3 个 Node 语法检查和 `git diff --check` 通过；详见 `.pi/tasks/2026-09-14-orca-options-page/task.md`。

## 2026-09-14：修复 Orca 预览设置页无法打开

- 根因是 preview mock 的 `runtime.openOptionsPage()` 只记录点击，不创建设置页面；现在由本机 preview service 调用 Orca `tab create` 打开现有 `src/options.html`。
- 设置页通过预览 bridge 将 `storage.local` 读写转发到当前 LinuxDo Tab，保持原设置入口、单一配置语义和实时 CSS 更新；不复制设置表单。
- Orca 回归确认设置 Tab 标题为 `betterLD 设置`、表单和存储 bridge 可用；保存 `maskOpacity=0.63` 后原页面存储值与 CSS 同步为 `0.63`。`npm run check`、`node --check scripts/orca-preview.js`、`git diff --check` 通过；详见 `.pi/tasks/2026-09-14-orca-options-page/task.md`。

## 2026-09-13：完成 BewlyCat 非 Bilibili 通用能力实现

- 按设计文档落地共享设置规范化、可操作设置页、主题卡片生命周期、导航壳层、action rail、链接打开模式、摘要抽屉、标题/作者/分类过滤、快捷键、响应式触屏、主题与字体、自定义 CSSOM、远程壁纸元数据缓存、搜索设置、语言、导入导出、storage.sync 白名单投影和关于页；Bilibili 专属业务保持排除。
- 运行时保持无依赖 Manifest V3，主题卡片覆盖原始 DOM 可逆恢复；作者只消费 `/t/{id}.json` 的 `details.created_by.username`，远端同步不包含本地壁纸正文、摘要缓存或搜索历史，关于链接指向 `xMuelsysex/betterLD`。
- 通过 `npm run check`、`node --check src/background.js`、Manifest/设置模型解析、`git diff --check`、规范化/CSSOM/sync smoke，以及浏览器设置页语言回切、sync/local 事件、content active-sync/卡片过滤 fixture；详细记录见 `.pi/tasks/2026-09-12-bewlycat-reuse-implementation/task.md`。

## 2026-09-12：完成 BewlyCat 非 Bilibili 设置复用设计

- 新增 `.pi/tasks/2026-09-12-bewlycat-reuse-design/design.md`，将 BewlyCat 中非 Bilibili 专属的外观、卡片、导航壳层、链接抽屉、过滤、搜索、响应式、快捷键、语言、备份同步和关于能力映射到 betterLD。
- 设计保持无依赖 MV3、现有壁纸 / 主题 / 作者权威数据约束和原站 DOM 可恢复边界；补充共享规范化、`storage.sync` 白名单投影、MV3 后台打开消息链、受限 CSSOM、自定义阴影曲线与原始 1/2/3 审计项追踪。
- 文档级 Node 设置模型解析、重复顶层键检查、`git diff --check` 通过；本轮只修改设计和项目留痕，未修改运行时代码。

## 2026-09-12：解除主题卡片网格宽度上限

- 根因是 Discourse `.container.list-container.--topic-list` 的 `1320px` `max-width`，使已有 `auto-fit` 网格只能使用 `1272px` 并排 4 列；`src/content.css` 现在对 betterLD 主题列表解除该上限，保留 `280px` 最小卡宽、`24px` 内缩和 `16px` 间距。
- Orca cache-busting `/latest` 回归确认主内容宽度 `3207px`、网格宽度 `3159px`、实际 10 列且卡片约 `297px`，右侧空白已被轨道填充；窄屏单列断点保持不变。`npm run check`、`git diff --check` 通过。

## 2026-09-12：调整用户菜单头像通知与文字布局

- `src/content.css` 将通知类型 `.icon-avatar__icon-wrapper` 定位为头像右上方的 `20px` Material badge（`top: -4px; right: -4px`），并将通知标题/描述调整为 `14px/13px`。
- Orca cache-busting `/latest` 回归确认 badge 位于头像右上方，30 个头像为 `40 × 40px`；“赞”标签切换与菜单关闭正常。`npm run check`、`git diff --check` 通过。

## 2026-09-12：移除用户菜单通知头像右上角叠层

- 真实 DOM 确认右上角元素是 Discourse `.icon-avatar__icon-wrapper` 通知类型图标；原生偏移位置叠加在 `40 × 40px` 头像上，导致视觉上像被裁切的异常元素。
- `src/content.css` 隐藏该装饰节点，保留头像图片、通知文字、未读 badge、tab 和路由交互；Orca cache-busting 回归确认 30 个头像均为 `40 × 40px`，切换“赞”和关闭菜单正常。`npm run check`、`git diff --check` 通过。

## 2026-09-12：用户菜单 Material 3 改造

- `src/content.css` 针对真实 `div.user-menu.revamped.menu-panel` 增加 Material 3 surface、右侧竖向 tab rail、active/hover/focus、未读 badge、通知卡片、底部操作 pill、窄屏、fallback、forced-colors 和 reduced-motion 样式；不改动站点 DOM、路由或菜单交互。
- Orca cache-busting `/latest` 回归：面板 `24px` 圆角、右侧 `56px` rail、标签 `40px` active pill、通知项 `16px` 卡片；切换“赞”标签后 active 状态与内容更新正常。`npm run check`、`git diff --check` 通过。

## 2026-09-12：增加 Orca 预览启动器与刷新恢复

- 新增 `scripts/orca-preview.js` 并接入 `npm run preview:orca`：启动无依赖、禁缓存的本地源码服务，打开真实 LinuxDo 页面并通过页面 nonce 注入当前 `config/content/CSS`。
- 启动器持续监控页面注入标记；刷新或整页导航导致页面上下文重置后自动重新注入，预览 storage 写入 LinuxDo `localStorage` 以跨刷新保留设置状态。
- Orca 实测首页注入与刷新恢复均通过：刷新后仍为 `injected=true`、30 张卡片、原表格隐藏、浮动设置按钮存在；整页导航 `/latest` 后自动恢复。`npm run check`、`node --check scripts/orca-preview.js`、`git diff --check` 通过。

## 2026-09-12：修复 CF/API 失败后的主题作者占位

- 真实首页中部分卡片因 `/t/{id}.json` 在 CF 挑战期间失败而永久停留在 `LinuxDo 用户`；`.topic-activity__username` 仍明确是最后回复者，不能作为作者。
- `src/content.js` 现在只从 JSON `details.created_by.username` 回写作者，移除 `post.username`、头像 title、链接路径和最后回复者回退；请求支持有限重试，最终失败显示 `作者信息暂不可用`。
- Orca 真实首页刷新并重新注入当前源码：首屏 16 张 ready 卡片与 JSON 创建者 `16/16` 一致，无错误用户名；`npm run check`、`git diff --check` 通过。

## 2026-09-12：增加网页右侧浮动设置入口

- `src/content.js` 增加幂等 `[data-betterld-settings-trigger]`，固定在网页右侧中部，点击复用 `runtime.openOptionsPage()` 打开现有设置页；不复制壁纸配置和存储逻辑。
- `src/content.css` 增加 Material 3 主色 pill 按钮、齿轮图标、hover/active/focus、reduced-motion 和窄屏图标态。
- Orca 真实 `/latest` 回归：按钮 1 个、`80 × 48px`、`right: 20px`、垂直居中；点击成功调用设置入口；`npm run check`、`git diff --check` 通过。

## 2026-09-12：完善标签目录与标签主题页 Material 3

- 扩展 `src/content.js` 路由：`/tag/<slug>[/id][/l/<view>]` 复用主题卡片网格，`/tags` 新增目录页面状态；从标签目录点击标签的 SPA 导航也能正确重建网格。
- `src/content.css` 新增标签目录 Material 3：透明页面壳层、排序 pill、分组标签卡片、计数、hover/focus、响应式 3 列布局；主题页复用已有卡片、壁纸、侧栏和控制栏。
- Orca 真实回归：`/tags` 9 个分组、1813 个标签项；`/tag/lottery/10` 30 张主题卡片；从 `/tags` 点击第一个标签后仍生成 30 张卡片；`npm run check`、`git diff --check` 通过。

## 2026-09-12：修复主题卡片用户名错配

- 根因是 `.topic-activity__username` 表示最后回复者，原作者解析把它当成主题创建者；真实 `/latest` 样本中 `Neo/luckyou`、`recardo/fengtang` 均出现错配。
- `src/content.js` 现在只从创建者区域的 `data-user-card` / `aria-label` 读取初始身份，并复用已有 `/t/{id}.json` 请求，将 `details.created_by.username` 写回卡片；缺失时使用通用占位，不依赖头像或最后回复者；首页、最新页和分类页不增加页面特例。
- Orca 真实首页、`/latest`、`/c/develop/4` 各抽查 10 个话题，均与 JSON 创建者 username 一致；`npm run check`、`git diff --check` 通过。

## 2026-09-11：修复最新页持续闪烁

- 根因是预览/重复注入同一 content script 后叠加多个 `MutationObserver`、滚动监听和入场动画；`src/content.js` 增加页面级幂等锁，滚动状态改为累计 `8px` 后切换且只在状态变化时写 DOM。
- 移除动态主题网格、卡片和摘要的入场动画，保留 `.list-controls` 的滚动 transition；`betterld.config.js` 集中维护滚动阈值。
- Orca cache-busting 真实 `/latest` 回归：静止 2 秒仅 8 条 mutation，重复 preview 仅 16 条；修复前对照约 429 条；上下滚动和顶部恢复均通过。`npm run check`、配置解析、`git diff --check` 通过。

## 2026-09-11：最新页控制栏滚动收起展开

- `src/content.js` 为主题列表页和分类列表页的 `.list-controls` 增加统一滚动方向状态：向下滚动收起，向上滚动展开，路由切换和节点重建后恢复可见状态；隐藏时使用 `inert` 保持键盘可用性边界。
- `src/content.css` 增加 `transform`、`opacity` 和 `box-shadow` 过渡；Orca 真实 `https://linux.do/latest` cache-busting 回归确认下滚 `600px` 后隐藏、上滚 `300px` 后展开，sticky 顶部为 `52px`，减弱动画规则存在且页面已恢复顶部。
- `npm run check`、`git diff --check` 通过；未引入依赖。

## 2026-09-09：修复分类页内容对齐与刷新提示层级

- 分类页 `.list-controls` 受站点 `#main-outlet` 高 specificity 规则约束，原先宽度为 1320px，而帖子内容区为 1272px；现统一到同一内容基线，真实国产替代页与公告板块均为 `x=512、width=1272px`。
- `.show-more.has-topics` 与内层刷新提示改为普通文档流、`z-index: auto`，保留筛选区之后、卡片之前的顺序，不再出现在上层覆盖其他内容。
- `/c/domestic/98` 的 30 张卡片和 `/c/feedback/announcement/49` 的 27 张卡片回归通过，作者名正常显示；`npm run check`、`git diff --check` 和截图均通过。

## 2026-09-09：修复同级分类页样式与主题作者显示

- 分类页不再只处理“开发调优”视觉：对所有 `.betterld-topic-page` 的 `.category-heading`、Logo、描述、breadcrumb、子类别/标签筛选和 select-kit 统一加入 Material 3 容器、圆角、边框、hover 与 focus 状态。
- 真实 `/c/develop/4` 和同等级 `/c/feedback/announcement/49` 回归通过；分别生成 30、27 张卡片，筛选器为 40px 高、16px 圆角，作者正确显示 `MGX`、`supersonicHenry`、`neo`、`SMNET` 等真实用户名。
- 作者名根因是 Discourse 分类列表把用户名放在 `.topic-activity__username`，而不是头像链接的 `data-user-card`；已接入作者解析链。`npm run check`、`git diff --check` 和 Orca 截图通过。

## 2026-09-09：记录整站 Material 3 待改造范围

- 保留后续工作清单，不在本轮继续扩展功能：部分改造包括 header 内部控件、侧栏内部项目、列表 `.list-controls` 过滤/排序、分类统计/订阅、footer 和通用弹层；未完成包括主题详情 `/t/*`、回复与 Markdown editor、搜索、用户资料/偏好、私信、通知、标签、徽章、关于/准则、Chat、通用表单控件、分页/继续加载、移动端壳层。
- 需要权限或额外样本的交互单独标记：登录用户编辑/删除、帖子级书签/反应、附件、投票、composer，以及管理员页面；不把当前未取得的权限样本误记为已改造。
- 具体 selector、路由和证据见 `.pi/tasks/2026-09-08-material3-notice-topic/task.md` 的“整站边界审计”和“待改造记录”。

## 2026-09-08：分类导航内容扩展与整站 Material 3 边界审计

- 将 `isTopicListPage()` 扩展到真实导航的 `/latest`、`/new`、`/unseen`、`/hot`、`/top`、`/posted`、`/read`、`/bookmarks`、`/my/*` 和分类 `/c/.../l/...` 路由；列表内容统一生成 Material 3 主题卡片，保留原生表头、筛选与链接。
- 修复 `.topic-list-body` 的高优先级 flex 占位，避免原生列表隐藏后把卡片推到页面底部；`/categories` 单独使用分类卡片行。
- 分类正则支持多级 slug，真实 `/c/resource/cloud-asset/94` 及 `/l/new`、`/l/unread` 变体回归通过；首页实际点击 `/hot` 成功。
- 整站审计确认：详情 `/t/*`、搜索、用户/偏好/消息、标签、徽章、聊天、通用菜单/按钮、分页、移动壳层和 footer 仍未完整纳入 Material 3；header、侧栏、列表筛选属于部分覆盖；登录态 composer、编辑、反应、附件、投票、帖子级书签等交互需要权限样本复测。

## 2026-09-08：首页话题分类导航适配 Material 3

- 首页 `#navigation-bar` 的最新、新、未读、热门、排行榜、我的帖子、已读、书签、类别共 9 个入口统一使用 Material 3 pill navigation；最新保留 active filled 状态，其余入口保留链接与数量文本。
- Orca 真实 `https://linux.do/` 页面计算样式通过：导航容器 `48px` 高、`20px` 圆角，单项 `40px` 高、`16px` 圆角；动态刷新横幅仍在帖子网格上方。`npm run check`、`git diff --check` 和截图捕获通过。

## 2026-09-08：将动态新话题刷新提示移到帖子上方

- 原生 `.show-more.has-topics` 默认使用 `position: absolute`，会与 betterLD 帖子网格重叠；改为正常文档流、全宽容器并居中提示链接，使网格从横幅之后开始渲染。
- Orca 真实 LinuxDo 页面回归：横幅位于 `y=305`、高 `48px`，帖子网格从 `y=373` 开始；`npm run check`、`git diff --check` 和截图通过。

## 2026-09-08：修正动态新话题刷新提示真实选择器

- 上一轮误用了不存在的 `.show-mores.alert.alert-info.clickable` 选择器，只样式化了临时预览节点；真实 Discourse 结构是 `.show-more.has-topics > a.alert.alert-info.clickable`，导致原生横幅仍保持原样。
- 改为命中原生横幅并覆盖原站高优先级背景、边框、圆角和尺寸；Orca 真实 `https://linux.do/` 页面原生节点计算为 `48px` 高、`16px` 圆角，focus outline 可见；未保留额外预览节点。`npm run check`、`git diff --check` 通过。

## 2026-09-08：首页公告与新话题入口适配 Material 3

- 将 `#global-notice-alert-global-notice` 改为使用 betterLD surface token 的 56px tonal banner，补充边框、16px 圆角、链接 hover/focus 和背景模糊。
- 将 `.topic-create-button__combo` 改为 48px 高、20px 圆角的 Material 3 分段 filled button，保留新建话题和草稿菜单操作。
- Orca 真实 LinuxDo 页面浅深主题回归和截图捕获通过；`npm run check`、`git diff --check` 通过。

## 2026-09-08：修正首页网格自适应与侧栏滚动

- 将首页网格两侧内缩从固定 `175px` 调整为 `24px`，使用 `auto-fit` 和可收缩 `minmax`，避免宽视口仍被限制为 3 列。
- 将 `.sidebar-wrapper` 改为基于原站 `--header-offset` 的 `sticky` 定位，页面滚动时保持在 header 下方；本轮暂不进行侧栏视觉魔改。
- `npm run check`、`git diff --check` 和 Orca 真实 LinuxDo 页面回归通过：`2029 × 1256` 视口为 4 列、单卡约 `294 × 294px`，滚动 `600px` 后侧栏仍保持 `top=52px`。

## 2026-09-08：完成 BewlyCat 壁纸来源与真实首页接入

- 在 `betterld.config.js` 集中维护完整 BewlyCat 壁纸目录、网站随机图的每日 seed、自定义图片模式和本地上传压缩参数。
- 设置页支持内置渐变、网站随机图、8 张内置图、HTTPS URL 和本地上传；本地图片压缩后写入扩展本地存储，失败时回退渐变。
- content script 按来源预加载背景，自动优先跟随 LinuxDo 主题、再跟随系统偏好；修复真实 Discourse 首页头像链接只含图片时作者名为空的问题。
- 真实 `https://linux.do/` 页面和 Firefox 153 + geckodriver 0.36.0 临时 XPI 验收通过：30 张卡片、背景来源、浅深主题切换、SPA 路由离开/返回恢复均正常；`npm run check` 通过。
- 独立 review 后补上随机壁纸的跨日轮询刷新，并让设置页随机预览与当天 seed / 已保存结果一致；同时修复内置目录索引误传和重新打开时选中态丢失；跨日回归、设置页预览 URL、8 张目录缩略图和选中态回归通过。

## 2026-09-08：完成首版首页卡片与视觉设置

- 完成无依赖 Manifest V3 扩展：首页主题行转换为约 `350 × 350 px`、按可用空间自动填充的卡片网格，保留帖子链接、作者 ID、头像和压缩元信息，分区显示 Material 3 Chip。
- 首帖正文通过同源 `/t/{id}.json` 按视口懒加载，HTML 清洗为纯文本并按卡片预览区域截断；请求失败显示占位状态。
- 完成 SPA 路由监听、动态主题行同步、原列表恢复、背景图预加载、遮罩、模糊、卡片透明度和原生设置页。
- `chrome.storage.local` 同时兼容 Chrome callback 与 Firefox Promise 调用；设置页包含 HTTPS 背景 URL 校验、范围归一化和恢复默认。
- 验证：`npm run check`、配置 JSON 解析、Chrome for Testing 151 真实目录扩展加载、Firefox `geckodriver 0.36.0` 临时 XPI 加载、LinuxDo 形态 HTTPS fixture 注入、宽窄视口卡片尺寸、首帖摘要、设置保存恢复均通过。
- 自动填充与边距验证：网格使用 `auto-fill + minmax(280px, 1fr)`；桌面端每侧预留 `175 px` 半卡宽，CFT `1440 px` 视口排为 3 列、卡片约 `342 × 342 px`，左右留白符合要求；当前目录尚未初始化 Git 仓库。Chrome branded 150 的 `--load-extension` 被浏览器自身忽略，真实 Chrome 加载验证使用本机 Chrome for Testing 151 完成，Firefox 实际 XPI 验证已补齐。
