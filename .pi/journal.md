# betterLD 项目流水

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
