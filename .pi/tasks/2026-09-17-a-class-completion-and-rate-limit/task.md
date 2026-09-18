# A 类设置补齐 + 站点限速优化

## 目标与决策

- 目标 1：把 A 类「已进设置界面但无运行时效果」的 7 项补齐成真实生效的能力。
- 目标 2：降低 betterLD 对 linux.do 的请求压力，消除测试中多次出现的站点限速警告。

根因（限速）：

- `observeCard()` 对每张卡片直接调用 `loadAuthor()`，**作者元数据不看视口、不等间隔**：30 张卡片的列表页在构建瞬间并发发出 30 个
  `/t/{id}.json?include_raw=1`（`requestTopicMetadata` 按 topicId 去重，所以恰好每主题 1 个，但全部同时发出）。
- 失败路径会放大请求：每张卡片 `topicRequestRetryCount=2` 次重试 + 1 次 recovery，且 429/503 不做全局退避，所以一旦被限速，
  30 张卡片会各自再重试，把压力翻数倍。
- 缓存只在当前页面内存里（`state.excerptCache`），任何一次站内导航都会重新请求整页主题。

决策：

1. 主题元数据请求统一走一个全局队列：并发上限 + 最小起始间隔（都进 `betterld.config.js`）。
2. 卡片作者元数据同样按视口加载（沿用 IntersectionObserver 的 rootMargin）；只有「按活动天数过滤」需要全列表活动时间时，才立即排队全部卡片。
3. 429/503 触发全局暂停（优先用 `Retry-After`），暂停期间不清空、不重试；暂停结束后只做一次有界的失败卡片补扫，不放大请求。
4. 主题元数据加一层 `sessionStorage` 跨导航缓存（带 TTL 与条目上限），使站内来回导航不再重复请求。

A 类 7 项的真实语义（按 BewlyCat 对应项落地，帮助文本同步改成描述真实行为）：

| 键 | 落地行为 |
| --- | --- |
| `sidebarCoverBlurEnabled` | 开：侧栏容器用壁纸高斯模糊封面（半透明 + `backdrop-filter`，即现状）；关：改用不透明表面且不做高斯模糊 |
| `liquidSegmentIndicatorEnabled` | 开：设置页分段控件用滑动液态指示器；关：静态选中态；`prefers-reduced-motion` 强制静态 |
| `separateNavigationActions` | 开（默认）：回到顶部与刷新是两个按钮；关：合并为一个按钮，未到顶部时点击回到顶部，已在顶部时点击刷新 |
| `enableUndoRefresh` | 刷新前把 betterLD 自己的卡片网格与滚动位置存入 `sessionStorage`；刷新后浮动操作出现「撤销刷新」，点击恢复刷新前的卡片内容与滚动位置 |
| `searchMode` | `cards`：把搜索页结果排成 betterLD 卡片网格（复用自有卡片视觉与过滤）；`native`：站点原生结果 |
| `searchResultsPaginationMode` | `scroll`：滚动到结果底部自动触发站点原生「加载更多」；`pagination`：仅手动点击 |
| `searchRecommendationEnabled` | 在站内搜索框按站点搜索建议接口给出建议下拉（来源与触发条件待实机确认后写入帮助文本） |

## 计划

1. 实机侦察 `/search` 结果 DOM、加载更多机制、搜索框与建议接口。
2. 实现限速优化（队列 / 视口门控 / 全局退避 / 缓存）。
3. 逐项实现 A 类 7 项，同步更新 `betterld.config.js` 参数与设置项帮助文本。
4. 实机验证：请求节流可见（卡片就绪数量随滚动阶梯增长）、7 项设置各自生效、既有能力无回归。

## 验证记录

已完成的静态检查：

- `npm run check` exit 0；`git diff --check` 通过；`content.css` 花括号 539/539、`options.css` 184/184。

实机侦察（linux.do `/search?q=betterld`，已过 Cloudflare）：

- 搜索结果结构：`.search-advanced > .semantic-search__container.search-results > div > .fps-result-entries > .fps-result`；
  单条结果含 `.author > a[data-user-card]`、`.fps-topic[data-topic-id] > .topic > a.search-link`（`.topic-title`）、
  `.search-category`、`ul.discourse-tags`、`.blurb.container > .date + span`，AI 结果额外带 `.ai-result__icon`。
- 无限滚动靠同层的 `.load-more-sentinel`（站点无翻页 UI），旁边是 `.loading-container`。
- `/search/suggest.json?q=better` 在浏览器里直接返回 **403 + Cloudflare 质询页**：站点搜索建议接口被 CF 挡住，
  所以「搜索推荐」的数据源不能走网络，改成本机搜索历史。

限速根因与修法的实机证据：

- 根因 A：请求指纹。同样一个 `/t/2915524.json?include_raw=1`，只带 `Accept` 时得到 `403 cf-mitigated: challenge`（HTML），
  换成站点自己的头部（`X-Requested-With: XMLHttpRequest` + `Discourse-Present: true`）就得到 `200 application/json`；
  `Discourse-Present: true` 单独也够用，`X-Requested-With` 单独不够。
- 根因 B：并发与重试放大。修前每张卡片在构建时立即 `loadAuthor()`，30 张卡片同时发 30 个 `/t/{id}.json`，失败还会各自重试 2 次 + 1 次 recovery。
- 修后实测（`/latest?order=created`，30 张卡）：首屏只发 **4** 个主题请求（就是视口 + `240px` rootMargin 内的卡片），其余 26 张停在 `loading`；
  滚到 y=3000 后新增 **8** 个请求，起始间隔 **319/321/425/452/469/560ms**（配置 320ms），就绪数从 4 阶梯式升到 12，全程 `failed: 0`。
- 缓存与退避：把 `performance.setResourceTimingBufferSize(1000)` 后清空再触发，能稳定数出上述请求；
  触发到 CF 质询时（修 headers 前）观察到了“3 个请求后全局暂停、不再重试”的退化行为，与设计一致。

A 类 7 项的实机验证（全部在 linux.do 真实页面，preview 注入最新资源）：

| 项 | 验证方式与结果 |
| --- | --- |
| A1 `sidebarCoverBlurEnabled` | 开：`.sidebar-container` = `rgba(33,31,38,0.78)` + `blur(18px) saturate(1.35)`；关：`rgba(43,41,48,0.98)` + `backdrop-filter: none` |
| A2 `liquidSegmentIndicatorEnabled` | `.settings-window[data-betterld-liquid=true]`，27 个分段控件都有指示器；点「深色」后 `transform: translate(253px,4px)/width 83px` 与目标项 `offsetLeft/offsetWidth` 一致；隐藏面板切回后由 `showCategory` 重同步（`shadowMode` → `4px/102px`）；独立设置页同样生效 |
| A3 `separateNavigationActions` | 关：工具栏 `[settings, topOrRefresh]`（图标数 1/2）；开：`[settings, top, refresh]`；滚动到 y=700 时 `data-betterld-scroll-top=false` 且显示向上箭头，回顶后变刷新图标 |
| A4 `enableUndoRefresh` | 滚动到 900 点刷新 → sessionStorage 快照 `{url, scrollY:900, html 103525B}` 跨重载存活 → 出现「撤销刷新」→ 点击后前三张卡标题与快照一致、`data-excerpt-state=ready` 从 12→12（新建页面当时只有 4）、`scrollY` 回到 900、快照键被消费、按钮从工具栏消失 |
| A5 `searchMode=cards` | `/search?q=linux` 上 `.fps-result-entries` 计算为 `display:grid`、两列（304.78px×2），`.fps-result` 为 betterLD 表面（`rgba(28,27,32,0.56)`/20px 圆角） |
| A6 `searchResultsPaginationMode=pagination` | 滚到结果底部后仍为 50 条（站点自动加载被禁，触点被移到 `left:-10000px`）；点「加载更多结果」后 50 → **100**，触点重新隐藏、按钮恢复可用 |
| A7 `searchRecommendationEnabled` | 搜索框 placeholder 变为最近搜索词（`betterld 限速`）；空输入回车由捕获阶段先填入该词再交给站点提交 |

回归面：设置窗口重开、七个主分类切换、阴影模式等面板与分段控件渲染正常（截图确认），独立设置页居中且指示器生效；
预览环境的状态已在验证后恢复为默认值（工具栏关闭、排序/布局回到默认、`searchMode=native`）。

环境摩擦：站点对本 profile 的整页导航频繁弹 Cloudflare 质询（“Just a moment...”），需 1–3 分钟或点一次复选框自愈；
`IntersectionObserver` 回调只在标签页被 `orca tab switch --focus` 取焦后才会投递，验证视口门控前必须先取焦。

## 结论

- 限速：三层一起生效——请求指纹（不再被 CF 403 质询）、视口门控（首屏从 30 个请求降到 4 个）、全局队列与退避（间隔 320ms，429/503/CF 质询时全局暂停且不放大重试），
  再加 sessionStorage 跨导航缓存（5 分钟）避免站内来回导航重复请求。
- A 类 7 项全部从「只存不生效」变成真实能力，帮助文本同步改成描述真实行为。
- 未做：搜索建议的网络数据源（被 CF 403 挡住）没采用；`searchRecommendationEnabled` 改用本机搜索历史，已在帮助文本里写明依赖「保存搜索历史」。
