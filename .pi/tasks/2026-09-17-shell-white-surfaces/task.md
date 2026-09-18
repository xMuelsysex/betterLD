# 壳层页面残留的站点纯白表面改用 betterLD 材质面

## 目标与决策

主人在真实 `/t/topic/2913933` 上点名两处仍是纯白的表面，并要求整站查一遍、见到白底就修：

1. `tr.topic-list-item`（主题详情页「更多话题/建议话题」表里的行卡片）：站点 `--d-topic-cards` 变体给的是 `oklch(1)` 纯白 + `1px solid #d1d1d1` + 8px 圆角 + 12px 内边距。
2. `div.card-content`（鼠标悬浮用户卡片）：站点规则是 `.card-content { background: rgb(var(--secondary-rgb), 0.85) }`，外层 `.user-card { background: var(--secondary) }` 同样是纯白。

决策：沿用已确立的两种 betterLD 材质面写法，不新造第三种观感。

- **站点内容卡片**（原生主题行、徽章卡片、分类页「最新」行、用户页正文底板、分类盒子、标签面板）：`rgb(var(--betterld-surface-rgb) / 0.56)` + `blur(var(--betterld-surface-blur))` + betterLD 描边/圆角/阴影——壁纸透过面板可见。
- **浮层与输入控件**（用户/群组/分类悬浮卡、下拉浮层、模态、底部编辑器、导航行的 类别/标签 下拉、搜索框）：`rgb(var(--betterld-surface-container-rgb) / 0.96 或 0.82)` + betterLD 描边/圆角/阴影——保住可读性，但不再是站点纯白。

顺带把导航行底板 `.list-controls` 的作用域从「话题列表页 + 分类页」放宽到壳层全页：首页此前仍显示站点纯白底板（上一轮有意留给主人决定，现在按主人的「见白即修」处理）。

## 计划

1. 在真实页面用扫描脚本枚举所有不透明白色表面（排除按钮/输入/代码等控件，面积 ≥ 2000px²）。
2. 逐类修：主题行、悬浮卡、浮层（下拉/浮动菜单/模态/编辑器）、徽章卡片、分类页最新行、搜索页容器与搜索框、导航行底板。
3. 每修一批重载页面复扫，直到各页面扫描结果为空。
4. 复核设置窗口与卡片菜单等既有表面不受影响。

## 验证记录

扫描脚本（`/tmp/whitescan.js`，按页执行）判定「纯白/近白且不透明」，逐页结果：

| 页面 | 修复前 | 修复后 |
| --- | --- | --- |
| `/t/topic/2913933` | `tr.topic-list-item` 5 行（550540px²）、`#user-card` 纯白 | 0 |
| `/latest` | 欢迎横幅搜索框（27600px²）、类别/标签下拉 header ×2 | 0 |
| `/badges` | `.badge-card` ×109（5226126px²） | 0 |
| `/categories` | `.latest-topic-list-item` ×25（合计约 1.5M px²） | 0 |
| `/tags` | 0 | 0 |
| `/search` | `.search-container` / `.search-header` / `.search-filters` / `.search-bar` | 0 |
| `/u/stellafortuna/summary` | 0 | 0 |
| `/`（首页） | `.list-controls` 导航底板（100320px²，z2） | 0 |

- 实机取到计算值：建议话题行 `rgba(255,251,254,0.56)` + 20px 圆角；`#user-card` `rgba(243,237,247,0.96)` + 24px 圆角 + 阴影（原 `rgb(255,255,255)` / 8px）；首页 `.list-controls` `rgba(243,237,247,0.82)`。
- 浮层逐个实际打开复核：底部编辑器（`#reply-control.open`，`rgba(243,237,247,0.96)` + 上圆角 20px）、通知级别浮动菜单（`.fk-d-menu__inner-content` 400×282）、分享模态（`.d-modal__container` 600×200，`d-modal__body/__header` 透明）。截图确认观感一致、未被裁切。
- 原生列表模式（`topicListLayoutMode: native`）经页面内存储切换实测：原来纯白的表格行变成 betterLD 材质面（0.56 + 20px 圆角），列表结构/分页行为不变。
- 悬浮用户卡片的内层 `.card-content` 在本机 preview 里始终不渲染内容（容器常驻、hover 后高度 2px，且全程不触发任何网络请求），无法截图实证；改用**层叠探针**验证：在真实 `#user-card` 内插入 `.card-content`/`.card-row` 后读取计算值，得到 `rgba(0, 0, 0, 0)`（透明），证明本站规则 `.card-content { background: rgb(var(--secondary-rgb), 0.85) }` 被覆盖，探针随测随删。外层 `#user-card` 的材质面是实机计算值，已确认。
- `npm run check`、`git diff --check`、CSS 花括号配平 503/503 通过。
- 站点限流：本轮导航+卡片 JSON 请求密集时出现「You've performed this action too many times」站点弹窗与 Cloudflare「请稍候…」，等待 40–90 秒自动恢复，与插件无关。

## 第二轮（主人复核后）

主人继续指出主题标题区的标签胶囊 `a.discourse-tag.box` 仍是站点灰底（`--primary-low` = `rgb(232,232,232)`）。

根因是**我自己的扫描脚本把 `A` 元素排除了**（当成控件跳过），标签胶囊、以及任何用 `<a>` 承载的块级表面因此整类漏检。改成包含 `A`/`BUTTON`/`SUMMARY`（仍排除 `input/select/textarea` 与图片）重扫后，逐页补出：

- `a.discourse-tag.box`（站点标签胶囊，`background-color: var(--primary-low)`）→ 沿用 betterLD 卡片标签写法：`surface-container-rgb / 0.58` + `1px betterld-outline/0.24` + `999px` 圆角 + `on-surface-variant` 文字，hover 换主色。实测：快问快答/人工智能/软件开发 三个胶囊计算值 `rgba(243,237,247,0.58)`、圆角 `999px`。`/tags` 页的 `.tag-box .discourse-tag.box` 已由更高优先级规则置为透明，不受影响。
- `#dialog-holder .dialog-content`（站点自带提示/错误弹窗，`.dialog-content { background: var(--secondary) }`）→ betterLD 浮层材质面。**实机复核**：站点限流弹窗「You've performed this action too many times」当时正在屏幕上，读到 `rgba(243,237,247,0.96)` + 20px 圆角 + betterLD 描边/阴影。
- `.user-main .details`（用户页简介卡 `rgb(248,248,248)`）→ 内容材质面。

复扫（含 `A`、面积 ≥ 800px²）：`/t/*`、`/latest`、`/categories`、`/badges`、`/search`、`/u/*`、首页 全部 0；`/categories` 首次复扫撞上 Cloudflare 质询（页面 `s:false`），重跑后 0。

## 结论

主人点名的两处白底（建议话题行、悬浮用户卡片）以及随后全站扫描出的其余纯白表面全部换成 betterLD 材质面；
首页导航底板也统一到与其他列表页相同的表面。八个页面扫描结果均为 0 个纯白表面，页面的控件（按钮、输入框、标签）保持原有可读填充。
唯一未取得实机截图的是悬浮用户卡片的内层内容（本机 preview 不渲染该内容），已用层叠探针确认覆盖生效。
第二轮补修标签胶囊、站点提示弹窗与用户页简介卡后，含链接在内的复扫在七个页面类型上仍为 0。
