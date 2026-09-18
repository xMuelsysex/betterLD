# 阅读卡统计图标重做 + 站点「experimental screen」黑角隐藏

## 目标与决策

主人从 `/latest` 真实页面提两件事：

1. 内容区角上有「黑角」（`li.experimental-screen__top-left` 等），不应该有。
2. 阅读卡底部的回复 / 点赞 / 浏览图标重新设计。

### 黑角：站点 experimental screen 边框

- 实测结构：`#main-outlet > ul.experimental-screen > li`，共 5 个 `position: fixed` 装饰块，
  颜色都是站点深色底 `oklch(0.1 0.025 277.869)`（实测约 `rgb(2,3,10)`）：
  四角 `top-left/top-right/bottom-left/bottom-right` 各 20×20（位置 291,52 / 1954,52 / 291,1217 / 1954,1217），
  另有一条 `bottom-bar` 1982×8（y 1237–1245）。
- 四角方块的作用是盖住内容容器（`border-radius: 20px` 的外层 div）圆角外侧的缺口，用页面底色画出「屏幕」观感；
  内容区透明化后，它们与壁纸不匹配，在浅色/带壁纸时就成了黑角，底部横条更是一条整宽的深色条。
- 决策：整组隐藏（`display: none !important`），与既有的「受管页面容器透明化」同一作用域
  （`body:is(.betterld-home, .betterld-topic-page, .betterld-categories-page)`）。不做重着色：它们本体就是页面底色的实心块，透明与隐藏等效。

### 统计图标：改用 Material 轮廓图标，形状只定义一次

- 现状是文本字形 `▢ ♡ ◉`（`setReadingStats` 里的 `icons` 表），字形在 1em 盒子里只占很小一块，小尺寸下发虚。
- 改为 CSS 掩膜图标：`span.betterld-topic-card__reading-stat-icon[data-betterld-stat-icon=...]`，
  形状（24×24 Material 轮廓路径：chat_bubble_outline / favorite_border / visibility）只写在 `src/content.css` 一处，
  `background-color: currentColor` 跟随文字色，盒子用 `width/height: 1em` 由既有 `font-size` 决定大小。
- 这样运行时卡片（content.js 只写 `data-betterld-stat-icon`）与 `reader-card-preview.html` 共用同一份形状，
  不必在两处各写一遍 SVG；预览页只把字形换成同名 data 属性。
- 尺寸：生效规则里的 `font-size` 由 14px 提到 16px（10px 数值文字旁的轮廓图标在 14px 下线条过细）。

### 影响文件

- `src/content.css`（实验屏边框隐藏、统计图标掩膜与尺寸）
- `src/content.js`（`setReadingStats` 写 data 属性，不再写字形）
- `reader-card-preview.html`（6 处图标字形改 data 属性）

## 计划

1. Orca 真实页面记录黑角与字形图标的现状（元素、位置、颜色、逐块均值）。
2. 落源码改动。
3. 真实页面复核：边框隐藏（含首页）、图标渲染与截图观感、独立预览页渲染。
4. `npm run check`。

## 验证记录

环境：`npm run preview:orca -- https://linux.do/latest`（Orca 真实站点 + 本机 preview 注入）。

黑角（`/latest`，1440 高度以下的视口 1997×1245）：

| 目标块 | 隐藏前均值（RGB） | 规则生效后（RGB） |
| --- | --- | --- |
| top-left 20×20 | 53,61,76 | 23,27,33 |
| top-right 20×20 | 73,68,75 | 32,30,32 |
| bottom-left 20×20 | 12,13,16 | 5,5,6 |
| bottom-right 20×20 | 10,10,14 | 4,4,5 |
| bottom-bar 1982×8 | 2,3,9 | 21,19,26 |

- 逐块 A/B 用同一页面状态下的「规则生效 vs 强制 `display:list-item !important`」对比得到；底部横条差异最大（2,3,9 → 21,19,26）。
- 规则生效后：`ul.experimental-screen` 计算 `display: none`，5 个 `li` 的 `getClientRects().length` 全为 0，
  注入样式表里能读到该规则（预览注入自带 cache-bust，不是旧 CSS）。
- 版面复核：`/latest` 顶部左侧裁切图里黑角缺口消失；首页 `/`（body class `betterld-home`）同样 `ulDisplay: none`、`liRects 0`。
- 未能复核：`/c/develop/4` 与 `/tags` 本轮被 Cloudflare 质询挡住（12 次重试未过），只按同一作用域推理；
  该规则与既有的容器透明化规则组使用同一 `body:is(...)` 选择器。

统计图标（`/latest`，30 张卡）：

- `setReadingStats` 后图标节点 45 个（15 张卡已拿到元数据 × 3），`data-betterld-stat-icon` 依次 `comment/heart/views`；
  盒子实测 16×16，`background-color: rgb(202,196,208)`（= `--betterld-on-surface-variant`），
  `mask-image` 已是注入的 data:image/svg+xml（linux.do 的 CSP 没有拦掉 CSS 掩膜图）。
- 截图观感：一条底栏 `💬 0 ♡ 0 👁 12`，气泡/心形/眼睛轮廓清晰，与 10px 数值和右侧 View details 胶囊对齐（`.pi/tasks/2026-09-17-stat-icons-experimental-screen/` 记录本次裁切图来源：`/tmp/icons-row.png`）。
- 独立预览页 `reader-card-preview.html`（file:// 打开）：5 张卡、6 个图标节点，`data-betterld-stat-icon` 为 comment/heart/views，
  盒子 16×16、`mask-image` 已设置 —— 与运行时卡片共用同一份 CSS 形状。
- 静态检查：`npm run check` 通过；`git diff --check` 通过。

## 结论

- `src/content.css`：新增受管页面作用域下的 `ul.experimental-screen { display: none !important }`；
  新增统计图标掩膜块（`.betterld-topic-card__reading-stat-icon` 盒子 + 三个 `data-betterld-stat-icon` 形状），
  并把生效规则的图标尺寸从 14px 提到 16px。
- `src/content.js`：`setReadingStats` 改为写 `data-betterld-stat-icon`，不再插入文本字形，也不再有字形回退表。
- `reader-card-preview.html`：6 处图标字形换成同名 data 属性，形状与运行时卡片同源。
- 未做（主人未要求）：设置页 / 浮动操作栏等处的其它字形图标（⚙、⌂、刷新等）本轮未改；
  分类页与 `/tags` 的实测因 Cloudflare 未完成。
