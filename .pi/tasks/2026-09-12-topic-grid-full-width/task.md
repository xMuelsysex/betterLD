# 主题卡片网格铺满可用宽度

## 目标与决策

- 目标：主题卡片网格按主内容区的实际可用宽度自适应列数，消除当前仅 4 列及右侧大块空白。
- 根因：`.betterld-topic-grid` 已使用 `repeat(auto-fit, minmax(..., 1fr))`，但其 Discourse 父容器 `.container.list-container.--topic-list` 仍有 `max-width: 1320px`；当前 `3532px` 视口下网格实际只有 `1272px`，因此只能排 4 列。
- 决策：仅在 betterLD 主题列表容器中移除该父容器的宽度上限，保留 `cardMinSize: 280px`、`auto-fit`、`24px` 内缩和 `16px` 间距；不改卡片内容、脚本数据流或站点 DOM。

## 计划

- [x] 检查网格父容器和现有响应式规则，确认影响首页与分类/主题列表页的最小选择器。
- [x] 移除主题卡片容器的 `1320px` 上限，让网格填满主内容区。
- [x] 运行宽视口真实回归、检查现有窄屏断点及项目静态检查，更新记录。

## 验证记录

- `npm run check`：通过。
- `git diff --check`：通过。
- Orca cache-busting 预览 `https://linux.do/latest?betterld_preview=orca-1789282170536` 刷新并重新注入当前 CSS：`3532 × 2170` 视口下，主题列表父容器 `max-width: none`、宽度 `3207px`，网格宽度 `3159px`，实际排出 10 列，列轨道约 `296.757px`，卡片数量为 60；修复前父容器 `1320px`、网格 `1272px`，只有 4 列。
- Orca 截图已捕获：卡片从主内容区左侧 `24px` 内缩开始，连续铺满到右侧可用空间，未留下原先的大块空白。
- 窄屏规则静态核验：现有 `@media (max-width: 560px)` 仍将 `.betterld-topic-grid` 设为单列并将内缩调整为 `16px`；本轮未改变窄屏断点或卡片最小尺寸。

## 结论

- 已解除 Discourse 主题列表父容器的 `1320px` 宽度上限，保留 `auto-fit` 自适应列数、`280px` 最小卡宽、`24px` 桌面内缩和 `16px` 间距，网格现在会铺满主内容区。
