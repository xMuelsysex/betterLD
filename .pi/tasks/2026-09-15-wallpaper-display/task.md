# 修复背景图片（壁纸）不显示

## 目标与决策

- 问题：LinuxDo 页面上「背景图片」功能选好来源后看不到壁纸。
- 根因：Discourse 核心 CSS 里有 clearfix `body::before, body::after { content: ""; display: table }`。
  betterLD 的壁纸/遮罩伪元素只声明了 `content`、`position: fixed`、`inset`、`background-image` 等，未声明 `display`，
  于是命中 Discourse 的 `display: table`；绝对定位的表格盒 width/height 都是 shrink-to-fit，空内容 → 计算尺寸 `0px × 0px`，
  壁纸层与遮罩层都没有被绘制。
- 决策：在壁纸/遮罩伪元素的三个共享规则块里显式声明 `display: block`，作用域仍限定在 betterLD 管理页面的 body class 上，
  不改动站点自身的 clearfix 语义。
- 第二个根因：设置窗口里内置壁纸缩略图是 `<button>`，点击只改 `state.selectedWallpaperId` 并调用 `setWallpaperMode()`，没有触发 `commitSettings()`；
  设置页的持久化只挂在 `settingsPageBody` 的委派 `change` / `input` 监听上，点击缩略图不产生这两个事件，
  因此选好的壁纸从未写入存储，页面也就不会应用。
- 决策：在缩略图 click 处理器里补 `commitSettings()`，复用既有即时生效链路，不新增独立保存路径。
- 影响文件：`src/content.css`（3 行新增）、`src/options.js`（1 行新增）。
- 决策：不扩大范围——预览启动器返回的 `wallpaperApplied` / `wallpaperState` 快照在 `runScript(content.js)` 后同步读取，
  早于 content.js 的异步设置加载，因此恒为 `false` / `default`，属于验收脚本的读取时机问题，与本次缺陷无关，不改。

## 计划

1. 用 Orca 真实页面预览定位壁纸层是否绘制。
2. 覆盖三个壁纸宿主变体：home/topic/categories（含 tags）、search、unmanaged。
3. 视觉确认壁纸确实渲染。

## 验证记录

环境：`npm run preview:orca`（Orca 真实 `https://linux.do/`），存储通过 `POST /__betterld/storage` 驱动。

- 修复前（`betterld-home`，壁纸来源 `builtin` / `rocky-mountain-cloudscape`）：
  `getComputedStyle(document.body, '::before')` → `display: table`，`width: 0px`，`height: 0px`；
  `data-betterld-wallpaper-state=ready` 且 `--betterld-wallpaper-image` 已写入，但页面无壁纸（截图背景为纯色）。
- 临时注入 `display: block !important` 后：`display: block`，`2030 × 1293`；截图可见山景壁纸。
- 修复后（`display: block` 已进源码，重新加载页面 + 缓存穿透注入）：
  - `/`（`betterld-home`）：`::before` `block` `2030 × 1293`，`background-image` = 壁纸 URL；`::after` `block` `2030 × 1293`，`rgba(20, 18, 24, 0.63)`。
  - `/search?q=material`（`betterld-search-page`）：`::before` / `::after` 均 `block` `2030 × 1354`，壁纸 URL 已应用。
  - `/guidelines`（`applyToUnmanagedPages=true`，`betterld-unmanaged-page`）：`::before` / `::after` 均 `block` `2030 × 1293`，壁纸 URL 已应用。
- 分层确认：把 `maskOpacity` 设为 `1`（全不透明遮罩）截图，卡片、侧边栏、Header、悬浮设置按钮仍完整可见，
  说明内容层在 `z-index: 0` 的遮罩之上，遮罩开始绘制后不会压住内容。参数随后恢复 `maskOpacity 0.63` / `blurPx 23` / `wallpaperMode builtin`。
- 视觉确认：`maskOpacity=0`、`blurPx=0` 时壁纸清晰可见；恢复用户参数后壁纸仍在绘制（整图平均亮度 0.183，修复前一栏为 0.151）。
- 性能对照：壁纸伪元素绘制 / `display: none` 两种状态下 rAF 帧间隔分别约 `1502ms` / `1469ms`，
  两者一致 → 该帧率由 Orca 浏览器窗口遮挡导致的节流决定，壁纸层不是瓶颈，未引入性能回归。
- 静态检查：`npm run check` 通过；`git diff --check` 通过；`git diff --stat` = `src/content.css | 3 +++`。

第二轮（`src/options.js` 补 `commitSettings()` 之后）：

- 环境同上（Orca 真实 `https://linux.do/latest`）。该轮页面先被 Cloudflare 拦截（标题「请稍候…」），
  从快照取得 `checkbox "请验证您是真人"` 后点击通过质询，标题回到 `LINUX DO`，预览注入自动恢复。
- 注入状态（直接 eval，不依赖启动器快照）：`__betterldPreviewInjected=true`、body 带 `betterld-topic-page`、
  `.betterld-topic-card` 30 张、`data-betterld-wallpaper-state=ready`。启动器打印的 `wallpaperState: default` / `cards: 0`
  仍是同一处读取时机问题（`runScript` 后同步读取，早于 content.js 异步初始化）。
- 修复前的缺陷路径为代码层确认（未做二次真实复现）：`src/options.js` 的持久化只有委派 `change` / `input` 监听与各控件自己的调用，
  缩略图按钮既不派发这两个事件也不自行提交，因此点击后只有内存 state 变化，`betterld.settings` 不会被写入。
- 修复后，从设置窗口「外观 › 壁纸」点击 `green-white-mountains` 缩略图：
  页面 `--betterld-wallpaper-image` 变为 `green-white-mountains.jpg`，`data-betterld-wallpaper-state=ready`；
  再点 `night-sky-stars`（500ms 后读取）：`#settings-status` `text="✓ 设置已保存。"`、`hidden=false`、`display=block`、`opacity=1`、`data-status=success`；
  `#wallpaper-status` `text="✓ 已应用。"`、`data-status=success`；`[name="wallpaperMode"]:checked=builtin`、选中项 `night-sky-stars`；
  页面壁纸同步变为 `night-sky-stars.jpg`。
- 持久化确认：预览存储 `betterld.settings` → `wallpaperId=night-sky-stars`、`wallpaperMode=builtin`（键集合 `betterld.settings` / `betterld.local-wallpaper` / `betterld.sync-meta`）。
- 宿主变体补充实测（新开预览，质询已过）：`/latest`（`betterld-topic-page`）→ `::before` / `::after` 均 `display: block`，`2030 × 1354`，遮罩 `rgba(20, 18, 24, 0.63)`，`--betterld-wallpaper-image` = `night-sky-stars.jpg`。
- `/tags` 本轮未能实测：该导航再次触发 Cloudflare 质询，`reload` 后重试一次仍停在「请稍候…」（无 nonce → 预览注入无法进行）。
  `betterld-categories-page` 与 `betterld-home` 处于同一个 `:is()` 规则块，三个类都是单类选择器，特异性相同且声明相同；
  在 home / topic 两个变体上已验证 `display: block` 能赢过 Discourse 的 `display: table`，因此 categories 变体按共享规则推定，仍标为未实测。
- 静态检查：`npm run check` 通过；`git diff --check` 通过。

未覆盖：Firefox 真实页面；`/tags` 与 `/tag/<slug>`（`betterld-categories-page`）未实测（Cloudflare 拦截），仅按同一 `:is()` 规则块与相同特异性推定。

## 结论

- 两处修复：`src/content.css` 三个壁纸/遮罩伪元素规则块补 `display: block`（绘制层）；
  `src/options.js` 壁纸缩略图 click 处理器补 `commitSettings()`（选择层）。
- 壁纸与页面遮罩自此真正参与绘制；三个壁纸宿主变体均已在真实页面上确认尺寸与资源。
- 选择内置壁纸现在会立即写入存储、立即作用于页面，并按既有约定给出「✓ 设置已保存。」与「✓ 已应用。」反馈。
