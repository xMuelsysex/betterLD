# 用户菜单头像通知位置与文字尺寸

## 目标与决策

- 目标：在用户菜单通知卡片中适度放大头像右侧的标题和描述文字，并将 Discourse 通知类型图标放到头像右上方。
- 真实结构：通知项使用 `.notification > a > .icon-avatar.user-avatar`、`.item-label`、`.item-description`；通知类型图标是 `.icon-avatar__icon-wrapper`，属于头像容器内的独立节点。
- 决策：标题调整为 `14px`、描述调整为 `13px`；通知类型图标恢复显示，定位为头像右上方的 `20px` Material badge（`top: -4px; right: -4px`），不改 DOM、路由或 JavaScript 交互。

## 计划

- [x] 检查现有头像、文字和通知 badge 样式，确认最小覆盖点。
- [x] 修改 `src/content.css` 的文字尺寸与通知 badge 位置。
- [x] 运行语法/差异检查和 Orca cache-busting 真实页面回归，更新记录。

## 验证记录

- `npm run check`：通过。
- `git diff --check`：通过。
- Orca cache-busting 预览 `https://linux.do/latest?betterld_preview=orca-1789280585056` 刷新并重新注入当前 CSS：头像为 `40 × 40px`，通知 badge 为 `20 × 20px`，badge 位于头像右上方（`badge.y < avatar.y` 且横向越过头像中心线）；标题计算字号为 `14px`，描述为 `13px`。
- Orca 真实交互回归：默认“所有通知”与切换后的“赞”标签 active 节点均正常，通知列表各有 30 项；切换“赞”后 badge、头像和文字尺寸保持正常；点击 header“通知和帐户”后菜单从 DOM 移除，关闭态无遮挡。
- Orca 截图已捕获，通知类型图标清晰位于头像右上方，右侧文本可读性提升；未修改通知文字、tab、href、未读 badge 或 JavaScript。

## 结论

- 已完成用户菜单头像通知布局调整，改动限定为 `src/content.css`，通知图标保持可见并定位在头像右上角，标题/描述适度放大，原有菜单交互保持不变。
