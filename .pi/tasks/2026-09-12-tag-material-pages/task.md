# 标签页 Material 3 适配

## 目标与决策

- 目标：将 `/tags` 标签目录与 `/tag/*` 标签主题列表纳入现有 Material 3 视觉体系，保持原有筛选、排序、链接和分页/加载行为。
- 根因：当前 `isTopicListPage()` 只覆盖首页、主题导航、`/c/...` 和个人列表，`isCategoriesPage()` 只覆盖 `/categories`；标签路由未进入主题网格或页面状态 class。
- 决策：复用已有类别目录与主题列表的共享渲染、token、侧栏、背景和控制栏样式，不为单个标签增加特例；`/tag/*` 使用主题网格，`/tags` 使用分组标签卡片和排序 pill。

## 计划

- [x] 读取真实标签目录与标签主题页 DOM，确认列表容器、标签卡片和控制栏结构。
- [x] 扩展共享路由/页面状态并补齐标签目录 Material 样式；复用主题网格处理标签主题列表。
- [x] 运行静态检查与 Orca 真实页面回归，更新验证记录和项目流水。

## 验证记录

- `npm run check`：通过，配置、内容脚本和设置脚本均通过 `node --check`。
- `git diff --check`：通过。
- Orca `https://linux.do/tags?betterld_preview=tag-material-v2`：`betterld-tags-page` 与共享 Material 壳层生效；9 个标签分组、1813 个标签项，3 列响应式 Material 卡片，目录外层透明并保留壁纸。
- Orca `https://linux.do/tag/lottery/10?betterld_preview=tag-material-v2`：`betterld-topic-page` 生效，30 张主题卡片、1 个网格、卡片圆角 `24px`、侧栏圆角 `24px`。
- SPA 回归：从 `/tags` 点击第一个标签 `/tag/1514-tag/1514` 后，路由切换到主题页并生成 30 张卡片、1 个网格。

## 结论

- `/tags` 与 `/tag/*` 已纳入 Material 3；标签目录和标签主题列表复用共享主题、壁纸、侧栏、焦点和滚动控制体系，未增加单个标签特例。
