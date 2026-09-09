# 首页与分类路由 Material 3 适配及整站边界审计

## 目标与决策

- 目标：将真实 LinuxDo 首页、话题分类导航和分类目录纳入 betterLD 现有 Material 3 视觉体系，保留原有链接、创建话题、草稿菜单、筛选与阅读行为；同时盘点整站尚未覆盖的页面边界。
- 选择器：公告使用稳定的 `#global-notice-alert-global-notice`；新话题使用 `.topic-create-button__combo`，覆盖侧栏可见的主按钮与分段菜单按钮；动态刷新提示使用真实 Discourse 结构 `.show-more.has-topics > a.alert.alert-info.clickable`。
- 决策：复用现有 `--betterld-surface-container-rgb`、`--betterld-primary`、`--betterld-on-surface` 和 `--betterld-outline-rgb`，不新增 JavaScript 状态或组件；公告使用 tonal surface banner，创建入口使用 48px 高的 Material 3 分段 filled button，动态刷新提示使用 48px 高的可聚焦 tonal card。

## 计划

- [x] 读取真实 DOM 和原站计算样式。
- [x] 增加公告条的 Material 3 surface、边框、圆角、链接和 focus 样式。
- [x] 增加新话题分段按钮的主题色、尺寸、圆角、hover 和 focus 样式。
- [x] 增加 `.show-more.has-topics > a.alert.alert-info.clickable` 动态刷新提示的主题色、尺寸、圆角、hover、loading 和 focus 样式。
- [x] 将动态刷新提示外层从原站 absolute 定位改回正常文档流，放到帖子网格上方。
- [x] 将首页话题分类导航的 9 个入口统一改为 Material 3 pill navigation，保留 active、hover、focus 与横向溢出行为。
- [x] 在 Orca 真实首页验证浅深主题和页面渲染。

## 验证记录

- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- `git diff --check`：通过。
- Orca 真实 `https://linux.do/` 页面：公告条计算为 `56px` 高、`16px` 圆角、深色背景 `rgba(35, 36, 51, 0.9)`；新话题分段按钮为 `48px` 高、`20px` 圆角，深色主色 `rgb(208, 188, 255)`。
- 浅色状态回归：公告背景 `rgba(247, 245, 252, 0.9)`，新话题主色 `rgb(103, 80, 164)`；文字颜色随主题 token 切换。
- `orca-ide screenshot --json`：真实首页当前视觉状态已捕获，页面保持在顶部供查看。
- 动态提示 DOM 通过官方 Discourse 编译模板和真实页面确认；原生结构为 `.show-more.has-topics > a.alert.alert-info.clickable`。修正选择器后，Orca 页面原生横幅计算为 `48px` 高、`16px` 圆角、Material 3 深色 surface 和主色文字，键盘 focus outline 可见；没有保留额外预览节点。
- 位置回归：横幅外层由 `position: absolute` 改为正常文档流，横幅位于网格前，实际网格从 `y=373` 开始而横幅位于 `y=305`，两者不再重叠。
- 分类导航回归：真实首页 `#navigation-bar` 包含最新、新、未读、热门、排行榜、我的帖子、已读、书签、类别共 9 项；导航容器计算为 `48px` 高、`20px` 圆角，9 个入口计算为 `40px` 高、`16px` 圆角，最新 active 为主题色 filled pill，其余入口保留原链接和数量文本。
- 分类列表回归：扩展主题列表路由覆盖 `/latest`、`/new`、`/unseen`、`/hot`、`/top`、`/posted`、`/read`、`/bookmarks`、`/my/*` 及 `/c/.../l/...`；`/top` 实测 50 张，其余主题列表实测 30 张，原生 `topic-list-body` 使用 `display:none`，表头与 `.list-controls` 保留。`/categories` 实测 21 行 Material 3 分类卡片；多级分类 `/c/resource/cloud-asset/94` 实测 30 张卡片。
- 路由修正：分类正则从单段 slug 扩展为多段 slug，覆盖 `/c/resource/cloud-asset/94`、`/c/square/research/113` 等真实子分类及其 `/l/new`、`/l/unread` 变体；实际从 `/categories` 读取子分类链接后回归通过。
- 真实点击回归：从 `/` 点击 `#navigation-bar a[href="/hot"]`，成功导航到 `/hot` 并生成 30 张卡片；各主题列表页面仅存在 1 个 `.betterld-topic-grid`，刷新横幅与网格无布局重叠。
- 整站边界审计：已改造为背景/明暗 token、公告、动态刷新提示、新话题分段按钮、主题导航、主题列表卡片、分类目录和列表页侧栏停驻；部分改造为 header 透明壳、sticky 侧栏、`.list-controls` 容器和登录后创建入口；未改造为主题详情 `/t/*` 的正文/回复/引用/反应/附件/投票/书签/时间线/编辑菜单、composer/Markdown editor、搜索结果、用户资料/偏好/消息、标签、徽章、关于/准则、聊天、通用按钮/菜单和分页；移动 header/菜单、footer 及权限态详情因真实 DOM 或登录权限限制单列为未确认。实时 Orca 已验证列表、分类、搜索、用户偏好、消息、聊天等路由；详情矩阵使用仓库保存的真实匿名快照，并明确标记候选 selector 不等于实时确认。
- 待改造记录（本轮只记录，不执行）：
  - 部分改造：header 内部 Logo、搜索、通知、头像和下拉菜单；侧栏内部链接、分组、badge 和移动抽屉；`.list-controls` 内 select、过滤器、排序器和 active filter；分类页表头、统计列和订阅操作；已适配页面的 footer 与通用弹层。
  - 未完成：`/t/<slug>/<id>` 主题详情的正文、回复、用户卡片、操作菜单、反应、附件、投票、时间线、相关主题和主题级书签/分享；`.d-editor-container` Markdown 编辑器、上传、预览和回复 composer。
  - 未完成：`/search` 搜索输入、筛选、结果、分页和空状态；`/u/<username>`、`/u/<username>/summary`、`/u/<username>/activity` 用户页面；`/u/<username>/preferences/*` 偏好表单；`/my/messages` 私信；通知面板。
  - 未完成：`/tags`、`/tag/*` 标签目录与标签主题列表；`/badges` 徽章目录与详情；`/about`、`/guidelines` 内容页；`/chat` 频道、消息和 composer。
  - 未完成：通用 button、dropdown、select、modal、dialog、tooltip、toast、checkbox、radio、switch、autocomplete、file picker、分页、继续加载和错误重试状态。
  - 待补验证/适配：移动端 header、侧栏抽屉、详情页、编辑器、搜索筛选、Chat 和 footer；登录用户的编辑、删除、帖子级书签、反应、附件、投票及管理员页面。

## 结论

- global notice、侧栏新话题入口、“查看一个新的或者更新的话题”动态提示和首页 9 项话题分类导航均已纳入 Material 3 适配；动态提示位于帖子网格上方；卡片、壁纸和 sticky 侧栏行为保持不变。
