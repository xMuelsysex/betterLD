# 2026-09-18 刷新后回到页首 + 操作栏刷新按钮开关不生效

## 目标与决策

主人反馈两件事：

1. 主页向下翻之后刷新帖子，位置不动，永远停在最下面看不到上面刷新的帖子。
2. 同一条消息里贴了站点弹窗文案「You've performed this action too many times. Please wait 15 seconds
   before trying again.」。

定位结论（全部在真实页面上取证）：

- **那条文案是站点自己的限速弹窗**（`#dialog-holder` 里的 `dialog-content`，带 确定 按钮）。
  它在用户标签页里一直开着，`.dialog-overlay`（`pointer-events: auto`）盖住整页 →
  所有点击都落不到页面上（实测 `document.elementFromPoint(banner 中心)` 返回 `.dialog-overlay`）。
  也就是说「刷新了但位置没动」有一部分是**点击根本没生效**：站点弹窗没关，刷新动作没发生。
  这不是 betterLD 的请求触发的：同一标签页里挂 fetch 探针，滚动触发 21 次 `/t/{id}.json` 全部 200、
  无 429、无失败卡片、弹窗未复现。站点限速弹窗来自站点侧的动作（例如反复点站点的刷新条）。
- **关掉弹窗后仍然存在的行为**：站点「查看 N 个新的或更新过的话题」点下去会把列表变长
  （实测 45 → 53 张卡片，站点自己的表格行同步增长，我们的网格跟着重建），
  而**浏览器滚动锚定会把旧内容钉在原地**（实测 scrollY 2198 → 6465、位置不动），
  新刷新的帖子留在视口上方 → 用户看不到。决策：点了站点的刷新条之后，列表重建完成时把视图带回页首。
- **顺带发现另一个真问题**：主人已经在设置里打开「显示刷新按钮」，但操作栏里没有出现刷新按钮。
  根因是双重门控：`actionRailItemsConfig` 里 `refresh.visible=false` 与 `showRefreshButton` 同时生效，
  两个开关只要有一个是关的就看不到按钮。决策：返回顶部与刷新**只由各自的开关决定**，
  从 `actionRailItems`（操作栏项目编辑器）里移除这两项，位置固定在操作栏尾部（`actionRailTailOrder`）。

## 计划

1. `src/content.js`：站点刷新条的点击意图 → 列表重建后回到页首；操作栏渲染改成开关单一来源。
2. `betterld.config.js`：`actionRailItems` 去掉 top/refresh、新增 `actionRailTailOrder`、
   新增 `listRefreshScrollTopWindowMs`。
3. `src/options.js`：两个开关的帮助文案写清「出现在浮动操作栏尾部，需先启用浮动操作栏」。
4. 真实页面验证：操作栏三种组合（分离 / 合并 / 只开刷新）、刷新按钮从底部刷新后落在页首、
   站点刷新条点击后回到页首、站点列表变化后网格同步。

## 验证记录

- `npm run check` exit 0；`git diff --check` 通过。
- 操作栏（真实页面，`showRefreshButton: true`）：分离模式 `settings@0 layout@1 top@90 refresh@91`；
  合并模式（`separateNavigationActions: false`）`settings@0 layout@1 topOrRefresh@90`；
  只开刷新（返回顶部关）`settings@0 layout@1 refresh@91`。即开关打开就会出现按钮，不再被操作栏项目里的可见性挡住。
- 刷新按钮（真实页面，从底部点击）：页面重载为新文档（`__betterldPreviewInjected.at` 变化），
  scrollY 0，刷新意图被消费并清除（`betterld.refresh-scroll-top` 为 null）。
- 站点刷新条（真实页面，滚动到底部后点击）：点击前 scrollY 2198、45 张卡片、提示「查看 10 个新的或更新过的话题」；
  点击后提示消失、卡片 45 → 53、**scrollY 0**（回到页首）。另外用「点击意图 + 强制重建（切布局）」单独验证了
  意图→重建→回页首这条链路（scrollY 3395 → 0）。
- 请求健康度：真实页面挂 fetch 探针滚动，21 次 `/t/{id}.json?include_raw=1` 全部 200、
  间隔 250–500ms、无 429/无 CF 质询、`[data-author-state="failed"]` 为 0、站点限速弹窗未复现。
- 站点弹窗：`#dialog-holder .dialog-content` 里的限速文案与主人贴的完全一致，
  点 确定 后 holder 与 overlay 一起移除、点击恢复；我们的 CSS 只改它的表面样式（无 pointer-events/display/z-index），
  不会让弹窗卡住。

环境坑（记录以免重试）：预览只在页面缺少 `__betterldPreviewInjected` 时重新注入，而 content.js 自身有
`__betterldContentScriptActive` 守卫——**同一个文档里再注入一次不会生效**，会继续跑旧脚本；
排查时要看 `__betterldPreviewInjected.at` 确认文档真的换了。另外整页 `location.assign` 会触发 Cloudflare
质询（等 1–3 分钟自愈），验证时不要用它，用 `location.reload()`。

## 结论

两条反馈都处理完：站点限速弹窗是点击失效的直接原因（已在真实标签页里关掉，并确认我们的请求没有触发限速）；
刷新条/刷新按钮/重载三条刷新路径现在都落在页首；操作栏的刷新按钮开关不再被第二层可见性门控挡住。

## 追加取证（主人反馈「原版能刷新、上插件就不能刷新」）

在同一 profile 上做了对照测量，结论是**插件不产生额外请求、也不放大站点的请求**：

- **静置 60s（插件生效、阅读卡布局）**：页面总共只有 2 个请求（都是站点的 message-bus 轮询），
  `/unseen.json`/`/latest.json` 站点列表请求 0 次、`/t/{id}.json` 元数据请求 0 次、无 429、无弹窗。
  也就是说插件的 DOM 托管没有让站点反复拉列表（这是最容易出问题的一类放大，实测不存在）。
- **插件自身的元数据请求**：一次列表刷新只按新增卡片数量发请求（30 → 51 张卡片时约 21 个，
  间隔 250–500ms、并发 2），全部 200；已有主题走内存 + `sessionStorage` 缓存（5 分钟）不重复请求。
- **站点的刷新端点**：这个站点的「查看 N 个新的或更新过的话题」实际请求的是 `/unseen.json?topic_ids=…`
  （不是 `/latest.json`），200；原版页面上点同一条提示同样是 200、列表 30 → 60 行、**视口不动**（2262 → 2980），
  和插件下的行为一致 —— 所以「位置不动」不是插件引入的差异，而是浏览器滚动锚定的固有行为，
  插件此前的差别只是**没有**把视图带回页首（现已补上）。
- **限速弹窗**：`#dialog-holder` 里那条 15 秒提示是站点对自身端点的限速；它开着时 `.dialog-overlay`
  会吞掉整页点击（实测 `elementFromPoint` 返回遮罩），于是「刷新」看起来完全失效 —— 这就是主人感受到的
  「上插件就不能刷新」。循环是：第一次刷新因为视口被锚定、看不出变化 → 再点几次 → 触发站点限速 →
  弹窗挡住所有点击。
- 顺带说明：本机 Orca profile 被我的验证反复加载过，CF 质询与站点限速状态都被加热过，
  在 Orca 里做「原版 vs 插件」的 A/B 不干净；要严格对比应在主人自己的浏览器里分别测。

## 追加定位（主人反馈：M3/原生刷新正常，阅读卡「有时候刷新不出来」且刷新后被带到最下面）

**根因（真 bug，已修）**：`itemSignature(item)` 直接读 `topicInfo(item).id`，但站点重渲染过程中会出现
**没有主题链接的行**（`topicInfo` 返回 null）。一旦列表里存在这样一行，`signature()` → `rebuildContainer()`
→ `syncHomepage()` 每次都在 `setTimeout` 回调里抛 `TypeError: Cannot read properties of null (reading 'id')`，
**整份列表同步彻底停摆**：站点把新帖插进它自己的表格，我们的网格再也不重建 → 「刷新不出来」，
而且会一直坏到重载页面为止（「有的时候」）。实测抓到的堆栈：
`itemSignature (content.js:3285) → signature (3292) → rebuildContainer (3516) → syncHomepage (3615)`。
修法是在 `itemSignature` 里对 null topic 返回空串（这类行本来就被 `createCard` 跳过），不做宽泛 try/catch。

**阅读卡「被带到最下面」的机制**：浏览器滚动锚定会把你正在看的内容钉住，站点把 N 张新帖插到最前面时，
你被向下推 N × 单卡高度 —— 原生行约 57px、M3 卡约 200px、**阅读卡约 430px**，
所以只有阅读卡会明显感觉「被丢到最下面」。改成：**列表顶部主题发生变化时（站点把新帖插到最前面）就把视图带回页首**，
尾部追加（滚动加载更多）不改顶部、不受影响；另外点站点刷新提示后的 10s 窗口内重建也回页首。
不再依赖「点了刷新」这个意图，晚到的插入同样会被带回页首。

### 验证记录（真实页面，阅读卡布局，标签页取焦）

- **同步崩溃修复**：正常改标题 → 卡片标题跟着变（同步活着）；插入一行**没有任何主题链接的行**（模拟重渲染中间态）
  → 签名照常更新、后续改标题仍然重建卡片 ✓（修前同样操作会让同步永久停摆）。
- **站点刷新 + 回页首**：滚动到 60%（y=1488）→ 点站点刷新提示 → 站点插入 24 条（rows 30 → 54）、
  网格 54 张卡片、**y=0** ✓；再次滚动到 2381 后点提示时站点没有新帖可插（横幅计数是客户端旧值），
  此时不重建也不动视图 ✓（不会乱跳）。
- **顶部变化规则**：删掉站点列表第一行 → 重建后顶部 id 变化 → y 从 2054 回到 0 ✓；尾部追加不影响滚动 ✓。
- **环境坑（很重要）**：预览标签页在后台/被冻结时，MutationObserver 与站点自己的异步渲染都会停摆，
  会让「站点刷新」和「我们的同步」同时表现成坏掉（我因此先误判成站点行为）；验证前必须
  `orca tab switch --page <id> --focus` 取焦，并确认 `document.visibilityState === "visible"`。
  另外 content.js 有 `__betterldContentScriptActive` 守卫，同一文档重复注入不会生效，必须整页刷新。

## 追加修复：首页导航底板（.list-controls）不再随滚动收起

主人贴的是首页（`/`）的 `div.list-controls`（sticky、86px 高），要求恢复「向下滚动自动收起」。

**根因**：收起的三个条件里，选择器与 CSS 都只认 `body.betterld-topic-page` / `body.betterld-categories-page`，
而 `betterld-topic-page` 只在「是主题列表页且不是首页」时挂（`topicListPage && !home`）。
首页在 linux.do 上就是「未读」列表（导航里 `未读` 处于 active、href=`/unseen`），
所以首页的 `data-betterld-scroll-state` 从来没被写过 → 底板永远不收。`/latest` 等页面一直是正常的。

**改法**（两处，只扩选择器，不改状态机）：把 `body.betterld-home` 纳入
`content.js` 的 `listControlsSelector` 与 `content.css` 里 `[data-betterld-scroll-state="hidden"]` 的规则；
`content.css` 里字体作用域那条规则本来就是这个三者并集，写法与既有约定一致。
主人的 `autoHideHeader` / `autoHideSidebar` 都是关的，因此这次改动只影响底板本身。

### 验证（真实页面，取焦）

- 首页 `/`：顶部 `state=visible / opacity=1 / rectTop=235`；分步向下滚到 1800 →
  `state=hidden / opacity=0 / translateY(-102px) / pointer-events:none / inert=true / rectTop=-50`（收起）；
  向上滚回 400 → `state=visible`，过渡结束后 `opacity=1 / rectTop=52`（展开）。
- `/latest`（原本就正常）：顶部 visible、向下滚 hidden/opacity 0、向上滚回 visible —— 无回归。
- `npm run check` exit 0、`src/content.css` 花括号 561/561。

## 追加：话题页 Header 标题块加毛玻璃

主人贴出话题页 `.d-header .extra-info-wrapper`（站点在 drop-down 模式下把标题/分类/标签放进 Header 的块，1320×52），要求加毛玻璃。

**改法**（`src/content.css` 一条规则，紧跟在 header 视觉模式规则之后）：
`body.betterld-shell .d-header .extra-info-wrapper` 用 `rgb(var(--betterld-surface-container-rgb) / 0.72)` 作底、
`blur(var(--betterld-surface-blur)) saturate(135%)` 作毛玻璃、`--betterld-radius-lg` 圆角、
`1px rgb(var(--betterld-outline-rgb) / 0.24)` 描边与 `--betterld-shadow-level-1` 阴影 —— 与既有
`headerVisualMode=frosted` 用的是同一套材质 token。不改站点几何（不加 padding/宽度），不新增设置项。

### 验证（真实话题页 /t/topic/2919589，取焦）

滚动触发 drop-down 模式后实测该块：`background: rgba(33,31,38,0.72)`、`backdrop-filter: blur(20px) saturate(1.35)`、
`border-radius: 20px`、`border: 1px rgba(147,143,153,0.24)`、`box-shadow: rgba(0,0,0,0.28) 0 4px 12px`，
rect 仍为 [331, 0, 1320, 52]（几何未变）；截图确认标题/分类/标签都在毛玻璃面板内、无裁切。
`npm run check` exit 0、`src/content.css` 花括号 562/562、`git diff --check` 通过。

## 追加：话题页 Header 标题块横向加宽

主人要求毛玻璃块「横向再扩大一点」。**关键发现：该块的宽度不受 `width` 控制** ——
站点把 `.d-header .contents` 排成五列网格 `261px 27px 1320px 27px 261px`，
标题块占中间那条 1320px 轨道，`width`/`max-width`（甚至行内 `!important`）都改不动它（实测无效）。
可行做法是 **`box-sizing: content-box` + 左右 `padding`（外扩）+ 等量负 `margin`（抵消）**：
面板边框盒变宽、内容位置完全不变（实测标题 left 恒为 352）。
padding 同时用 `min()` 夹住两侧可用空间（`(100vw - --d-max-width - 24px) / 2`），窄屏不会溢出视口。

外扩总量是 token `--betterld-title-block-extra-width: 240px`（content.css 的 `:root`）。

### 验证（真实话题页，取焦、滚进 drop-down）

- 面板 rect `[211, 0, 1562, 52]`（改前 `[331, 0, 1320, 52]`，宽了 242px）；标题 `left` 仍是 352（未位移）。
- `box-sizing: content-box`、`padding-inline: 120px`、`margin-inline: -120px`、毛玻璃/圆角/描边/阴影保持。
- 无横向溢出：`documentElement.scrollWidth 1982 ≤ innerWidth 1997`。
- 截图确认面板变宽、标题与分类/标签仍在面板内且未裁切。
- `npm run check` exit 0、`src/content.css` 花括号 562/562、`git diff --check` 通过。

## 追加：侧栏亚克力封面左右内缩（保持对称）

主人要求「左侧的亚克力效果不要超过左边的竖栏，右边也缩短同样的距离以保持对称」。

**改法**：把亚克力表面（底色 / 1px 描边 / 24px 圆角 / 阴影 / backdrop blur）从 `nav.sidebar-container`
自身盒子上移到 `::before` 伪元素，伪元素 `inset: 0 var(--betterld-sidebar-cover-inset)`（9px）——
即封面横向左右各内缩 9px，对齐侧栏内容列（`.sidebar-sections` 的内容盒 20..274），
而**侧栏内容（图标/文字/按钮）位置完全不变**（只换了承载表面的盒子，不改布局）。
`sidebarCoverBlurEnabled=false` 的不透明表面同样落到伪元素上；伪元素 `z-index: -1` + `pointer-events: none`。

内缩量是 token `--betterld-sidebar-cover-inset: 9px`（content.css 的 `:root`）。

### 验证（真实话题页，取焦）

- 改前：封面 = nav 自身盒子 `[11, 272]`；改后：`nav` 背景透明、封面伪元素 `inset: 0 9px`，
  实际表面 `[20, 254]`（左右各缩 9px，对称）；首个侧栏链接仍在 `[19, 241]`、内容未位移。
- 伪元素：`background rgba(33,31,38,0.78)`、`backdrop-filter blur(18px) saturate(1.35)`、`radius 24px`、
  `border 1px rgba(147,143,153,0.24)`、`z-index -1`、`pointer-events none`。
- 两种封面变体：`sidebarCoverBlurEnabled=true` → 半透明 + blur；`false` → `rgba(43,41,48,0.98)` + 无 blur + level-2 阴影（都保持 9px 内缩）。
- 无横向溢出：`scrollWidth 1982 ≤ innerWidth 1997`；截图确认封面内缩、内容未裁切。
- `npm run check` exit 0、`src/content.css` 花括号 563/563、`git diff --check` 通过。
