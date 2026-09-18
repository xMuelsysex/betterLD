# 话题排序（最新回复 / 发布时间）

## 目标与决策

主人要求：给话题做排序功能，两种模式 —— 默认按最新回复时间逆序，另一种按帖子发布（或编辑）时间逆序；
在首页和个人空间都要生效。

### 真实页面调研（改动前，Orca 实机）

- 首页/列表页结构：`table.topic-list.--d-topic-cards` + `.topic-list-item[data-topic-id]`，
  最后活动时间只在 `td.topic-activity-data .relative-date[data-time]`（epoch ms），页面里没有创建时间。
- `/latest`、`/?order=created`、`/new`、`/c/develop/4`、`/tag/31-tag/31`、`/hot`、`/top?period=weekly`、
  `/u/neo/activity/topics` 全部接受 `?order=created`，返回主题 id 与 `created_at` 严格递减。
- 个人空间（`/u/{name}/activity/topics`）使用同一个 `table.topic-list` + `.topic-list-item` 结构，
  但没有 `.list-controls`；默认顺序（含置顶优先）是活动时间倒序，`?order=created` 同样生效。
- `/u/{name}/activity`（所有）是 `.user-stream-item` 混合流，`/u/{name}/summary` 的「热门话题」是 Top 榜，
  两者都不是可按时间排序的话题列表，排除。
- Discourse 侧：`TopicQuery::SORTABLE_MAPPING` 只提供 likes/op_likes/views/posts/activity/posters/category/created，
  **没有「最后编辑时间」排序**；`post.rb` 里编辑走 `bypass_bump: true`，编辑首帖不改变 `bumped_at`。
  因此第二种排序只能落到原生的 `created`（主题创建时间）。

### 决策

- 排序由服务端 `order` 参数决定，不做前端重排：
  - 默认模式 = 不加参数（Discourse `bumped_at` 倒序，即 LinuxDo 默认的最新回复）。
  - 时间模式 = `?order=created`（`created_at` 倒序）。
- 前端只负责把设置落到 URL，因此排序是全局正确的（不是只排当前页 30 条），也不产生额外请求。
- 生效范围 = 既有「话题列表页」集合减去热门/最高（它们有自己的排序语义），再加上个人空间
  `/u/{name}/activity/topics`（betterLD 目前不管理该页，故只能靠 `order` 参数生效）。
- 只补参数、不覆盖参数：URL 上已有 `order` 时尊重用户显式选择。
- 设置界面打开期间不重载（避免把用户正在操作的大窗口顶掉），关闭后由 500ms 路由轮询应用。

### 影响文件

- `betterld.config.js`：`topicSortOrders`、`topicSortOrderParam`、`settingsEnums.topicSortMode`、
  `settingsDefaults.topicSortMode`、卡片分类 keys。
- `src/content.js`：`applyTopicSort()` 与页面判定，接入 `applyVisualSettings` 与 `checkRoute`。
- `src/options.js`：`topicSortMode` 字段与中英文枚举/字段标签。

## 计划

1. 记录改动前的页面顺序与 URL 基线。
2. 落配置 + 运行时 + 设置界面。
3. Orca 真实页面复核（见验证记录）。
4. `npm run check` 语法检查。

## 验证记录

环境：`npm run preview:orca -- <url>`（Orca 真实站点 + 本机 preview 注入）。

### 服务端行为（改动前，Orca 直连）

- `/?order=created`、`/latest?order=created`、`/u/neo/activity/topics?order=created` 都在无注入的干净标签页里保持 URL 不变，
  且列表按 `created_at` 倒序：`/latest` 前 6 个 id `2911686,2911685,2911684,2911678,2911677,2911672`（严格递减），
  `/u/neo/activity/topics` 前 4 个 id `2888356,2881865,2853125,2851121`；默认（无参数）同页是 `847468,482293,1543348,1789018`（置顶 + 活动倒序）。
- `/u/{name}/activity/topics` 的前端会向 `/topics/created-by/{user}.json?order=created` 取数据，说明该路由会把 URL 上的 order 透传给接口。

### 注入后（本机 preview）

- 设置界面（Shadow DOM）里 `topicSortMode` 渲染为分段控件「最新回复 / 发布时间」；中英文标签分别是
  话题排序方式（Topic sort order）/ 最新回复–发布时间（Latest reply–Publish time），帮助文案与字段描述完整渲染。
- 真实鼠标点击「发布时间」（设置窗口内）：选中态切到 created，`chrome.storage.local` 里 `topicSortMode="created"`，
  且**设置窗口打开期间页面不重载**（URL 与注入标记不变）。
- 按 Escape 关闭设置窗口后，页面重载为 `/latest?betterld_preview=…&order=created`，30 张卡片 id 严格递减
  （`2911792,2911789,2911786,2911785,2911784,2911783,2911778,2911777`），且活动时间戳非单调
  （`1789580152486,1789580548108,1789579468724`，即确实不是活动序）；卡片作者状态为 `ready`，同页可正常请求 `/t/{id}.json`。
- 反向（同一设置窗口内真实鼠标点击「最新回复」后按 Escape）：URL 上的被我方写入的 `order=created` 被删除，
  页回到 `/latest?betterld_preview=…`，列表恢复原生顺序（置顶 `847468,482293` 在最前）。
- 逐项边界：
  - `/hot`（设置=created）：URL 保持 `/hot` 不加参数，30 张卡片仍是热门顺序（`847468,482293,2910500,…`），即热门/最高不被接管；
  - `/latest?order=likes`（设置=最新回复）：URL、卡片数均不变，其它 `order` 取值不被删除也不被替换；
  - 个人空间 `/u/neo/activity/topics`（设置=created）：URL 变为 `…?order=created` 并稳定 20s 不震荡；
    该页列表内容（`2888356,2881865,2853125,2851121`，创建时间倒序）已在无注入标签页与注入标签页中各自复核过。
- 稳定性：修复后 preview 启动器整轮只有 3 次注入（修复前 3 分钟内 36 次），页面在 ORDER / NO-ORDER 两种终态下都静止不动。

### 回归（已修）

首版实现把 `applyTopicSort()` 也挂进了 `applyVisualSettings()`，而启动时会先用 `config.settingsDefaults`（`topicSortMode="activity"`）
跑一遍，于是带 `order=created` 的文档一启动就把参数删掉并重载；重载后又由解析出的设置加回参数，形成
**每 5–6 秒一次的无限重载循环**（preview 日志 3 分钟内 36 次注入，`/u/` 页面 URL 在 ORDER/PLAIN 之间反复翻转）。
改为：`applyTopicSort()` 只由 `checkRoute` 轮询调用（放在 href 变化判断之前，这样关闭设置窗口后也能立即落下去），
并用 `state.settingsResolved` 标记（bootstrap 那次带 `{ provisional: true }`）挡掉「设置还没读出来」的阶段。

## 结论

- `betterld.config.js`：新增 `topicSortOrders`（`activity:""` / `created:"created"`）、`topicSortOrderParam: "order"`、
  `settingsEnums.topicSortMode`、`settingsDefaults.topicSortMode = "activity"`，并把 `topicSortMode` 放进
  设置界面「页面 → 主题卡片」的 keys。
- `src/content.js`：新增 `hasOwnTopicRanking()` / `isUserSpaceTopicListPage()` / `isSortableTopicListPage()` /
  `applyTopicSort()`，由 `checkRoute` 每 500ms 评估一次；只接管自己写入的 `created` 取值，只在自己写入的取值上做删除。
- `src/options.js`：新增字段描述与中英文枚举/字段标签。
- `CONTEXT.md`：新增 Topic Sort 术语与不变量。
- 交付形态：设置项「话题排序方式」（最新回复 / 发布时间）在首页、list 类页面与个人空间话题页生效；
  因为 LinuxDo 的顺序来自服务端，切换排序是一次重载，设置窗口打开期间不抢重载。
- 已知边界：① Discourse 没有「最后编辑时间」排序（`SORTABLE_MAPPING` 无此项，编辑首帖也不 bump），
  所以第二种排序落到原生的 `created`；② 热门与最高保留自身排序；③ 页面 URL 上已有 `order` 时尊重该取值。
