# 分类页内容对齐与刷新提示层级

## 目标与决策

- 将分类页 `.list-controls` 与帖子内容区使用同一条横向对齐基线。
- 保留“查看新的或更新的话题”横幅在筛选区之后、卡片网格之前，但移除它的独立堆叠层，避免出现在上层覆盖其他内容。
- 规则继续作用于所有主题分类路由，不为单个分类写特例。

## 计划

- 检查真实分类页中 `.list-controls`、`#list-area`、`.show-more.has-topics` 和 `.betterld-topic-grid` 的坐标与层级。
- 修正分类控制区宽度与外边距；将刷新横幅改为普通文档流节点。
- 在国产替代页和同等级公告板块复测卡片、作者名、对齐和横幅无重叠。

## 验证记录

- `https://linux.do/c/domestic/98`：`.list-controls` 与 `#list-area` 均为 `x=512、width=1272px`，对齐通过；30 张卡片，作者显示 `lingke`、`maclejean`、`yedabin`、`HeriX`、`glovey`。
- 国产替代页刷新提示：外层 `.show-more.has-topics` 为 `position: static`、`z-index: auto`，位于 `y=551`；卡片网格从 `y=635` 开始，未重叠。
- `https://linux.do/c/feedback/announcement/49`：27 张卡片，`.list-controls` 与 `#list-area` 同为 `x=512、width=1272px`，作者显示 `neo`、`SMNET` 等真实用户名。
- `npm run check`：通过。
- `git diff --check`：通过。

## 结论

- 分类页控制区已与卡片内容区统一对齐。
- 刷新提示依靠正常文档顺序显示在分类控制区之后、帖子卡片之前，不再使用上层 z-index 覆盖。
- 同级分类页面复用同一套规则，未加入页面特例。
