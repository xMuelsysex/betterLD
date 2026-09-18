# linux.do 全站改造覆盖审计

## 目标与决策

主人指令：「检查一下网站是 linuxdo 的还有没有没做改造的了」。做法：把站点的界面按「独立布局」而不是按 URL 逐个清点，
对每个布局判断扩展是否已给它 betterLD 形态；判断依据分两层：

1. **运行时**：在真实页面扫描不透明表面（面积 ≥ 3000px²），以及元素计算值。
2. **静态**：用站点自己的样式表（`common_*.css`、`chat_*.css`）反查各元素的 `background` 来源——
   重点是 `var(--d-content-background)`（整页底板）与 `var(--secondary)`（面板）这两类，它们在浅色主题下就是白/近白。
   这一层是必要的：本轮审计期间浏览器跟随系统切到了深色主题，运行时的「白底扫描」在深色下天然抓不到白色，只有静态反查才能确定浅色下的白底。

## 计划

1. 列出站点可达布局：从侧栏、用户菜单、用户页标签、群组页、站点样式表里的整页底板类反推。
2. 对每个布局判断覆盖状态，缺的补上规则。
3. 每补一批用真实页面复核（计算值 + 截图），并回归既有页面。

## 验证记录

### 本轮补的（均实机复核）

| 界面 | 缺口（站点原始写法） | 处理 | 复核 |
| --- | --- | --- | --- |
| `/faq`、`/guidelines`、`/tos`、`/privacy`、`/about`（静态文档页） | `.body-page { background: var(--d-content-background) }` | 内容材质面 | 计算值 `rgba(28,27,32,0.56)` + 20px 圆角（`/guidelines`、`/tos`） |
| 404 页 | `#main-outlet.not-found-container` 同源底板 | 内容材质面 | 计算值同上（访问不存在路径） |
| 徽章详情 | `.show-badge` 同源底板 | 内容材质面 | 计算值同上（`/badges/1/-`） |
| 聊天 `/chat`（频道页） | `.full-page-chat`、`.chat-message-container` ×50、`.c-navbar-container`、`.chat-pinned-bar`、`.chat-channel-status`、`.chat-message-separator__text` | 容器与消息行透明化、输入区用控制面 | 不透明表面 63 → 5（剩下的都是 betterLD 自带 UI 与站点侧栏），截图确认壁纸透出、可读 |
| AI 机器人 `/discourse-ai/ai-bot/conversations` | `.ai-bot-conversations__input-wrapper` | 透明 + 控制面 | 不透明表面 5 → 4，截图确认 |
| 用户页自有标签 作品集 `/activity/portfolio`、邀请 `/invited`、关注 `/follow`、结算 `/billing` | `.user-content`（linux.do 插件把它们当整页底板）与 `.follow-stream-item` 行 | `.user-content` 统一透明、`.follow-stream-item` 归内容材质面 | 四个标签复扫后只剩 betterLD UI 与站点公告 |
| 群组页 `/g`、`/g/{name}` | `section.user-content` 底板、组内 `select-kit-header` | 同上 + `.select-kit` 规则从「分类导航/面包屑」扩到 `#main-outlet` 作用域 | `/g/g-adsfree` 复扫 8 → 6（余下为 betterLD UI 与站点公告） |
| 高级搜索 `/search?expanded=true` | `.search-advanced-filters` 面板与筛选输入 | 面板透明、`input/select/.select-kit-header` 用控制面 | 计算值：面板透明、输入 `rgba(33,31,38,0.82)` |
| 登录页 `.login-fullpage` | 同源整页底板 | 内容材质面 | 登录态下无法实访，用**层叠探针**在真实 DOM 里插入同名元素读到 `rgba(28,27,32,0.56)` |

### 有意保留（不是缺漏）

- `/upcoming-events` 的日历是第三方 FullCalendar 组件，保留自身观感，只受壳层影响。
- 帖子正文里的 `blockquote`、代码块等内容元素保留站点排版（属于内容，不属于界面壳层）。
- `/admin`、`/review` 等管理页需要更高权限，本账号无法验证。
- 站点未启用的路由 `/directory`、`/invite`（均 404），因此不写规则，避免投机代码。

### 回归

- `/latest`：`.category-breadcrumb .select-kit-header` = `rgba(28,27,32,0.56)`（选择器换成 `#main-outlet` 作用域后仍生效）、侧栏主题下拉仍是透明（扩展自有规则未被覆盖）、30 张卡片正常。
- 站点限流：本轮导航密集，多次出现 Cloudflare「请稍候…／Just a moment...」，等待 1–2 分钟自愈。

## 结论

站点可达界面按布局清点后，除管理页与第三方日历组件外，全部纳入 betterLD 形态；
本轮新增：静态文档页/404/徽章详情/登录页整页底板、聊天与 AI 机器人容器与消息行、linux.do 自有用户标签与群组页底板、高级搜索筛选区。
