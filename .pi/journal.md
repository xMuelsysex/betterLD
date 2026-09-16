# betterLD 项目流水

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
