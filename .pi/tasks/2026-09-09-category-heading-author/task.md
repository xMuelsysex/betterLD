# 同级分类页 Material 3 与作者显示修复

## 目标与决策

- 目标：让所有真实分类页复用同一套 Material 3 分类标题、分类 Logo、breadcrumb、子类别/标签筛选和 select-kit 控件；修复主题卡片作者名在分类列表中显示为默认占位的问题。
- 根因：分类页的 `.list-controls` 只有通用容器覆盖，`.category-heading` 和分类筛选控件仍主要使用 Discourse 原生样式；真实主题列表作者名位于 `.topic-activity__username`，不在当前作者链接选择器中。
- 决策：继续复用现有 Material 3 token 和分类页通用选择器，不为“开发调优”增加页面特例；作者解析优先保留已有 `data-user-card`、`aria-label`、用户链接逻辑，再读取 `.topic-activity__username`。

## 计划

- [x] 检查 `/c/develop/4` 的真实分类标题、筛选器和主题作者 DOM。
- [x] 将 `.category-heading`、Logo、描述、breadcrumb、子类别/标签 select-kit 统一适配 Material 3。
- [x] 将真实 `.topic-activity__username` 接入卡片作者解析。
- [x] 用“开发调优”及同等级的“公告”分类页做真实回归。

## 验证记录

- 真实 `/c/develop/4` DOM：作者文本位于 `.topic-activity__username`，原有链接选择器无法取得用户名；修复后卡片作者显示 `MGX`、`supersonicHenry`、`Dingning`、`626`、`tianyang`。
- 真实 `/c/develop/4` 回归：生成 30 张卡片；分类标题卡计算为 Material 3 `24px` 圆角，分类筛选器为 `40px` 高、`16px` 圆角，`.list-controls` 为 `20px` 圆角；原生主题正文保持隐藏。
- 真实同等级分类 `/c/feedback/announcement/49` 回归：生成 27 张卡片；作者显示 `neo`、`SMNET` 等真实用户名；分类筛选器“运营反馈”“公告”“标签”均计算为 `40px` 高、`16px` 圆角，分类标题和 `.list-controls` 使用统一 Material 3 容器。
- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- `git diff --check`：通过。
- `orca-ide screenshot --json`：真实 `/c/feedback/announcement/49` 页面最终画面已捕获。

## 结论

- 同级分类页已使用通用 Material 3 分类样式，不再只依赖当前“开发调优”页面；作者名已从真实 Discourse 活动节点解析并显示。其余整站未完成 Material 3 范围沿用前一任务记录，未在本轮扩大。
