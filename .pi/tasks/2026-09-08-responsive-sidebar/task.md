# 响应式网格与侧栏停驻

## 目标与决策

- 目标：让首页卡片网格按实际可用宽度自适应列数与卡片尺寸，并让现有 LinuxDo 侧栏在页面滚动时停驻；本轮不实现后续侧栏视觉改造。
- 根因：固定 `175px` 两侧内缩在当前 `2029px` 视口的 `1320px` 内容容器中只留下约 `922px` 网格空间，实际只能排 3 列；`.sidebar-wrapper` 使用 `relative`，随文档滚动。
- 决策：将现有配置参数 `cardSideGutter` 调整为 `24px`，网格使用 `auto-fit` 与可收缩的 `minmax(min(100%, ...), 1fr)`；侧栏使用原站 `--header-offset` 的 `sticky` 定位，并限制在视口 header 下方的高度。

## 计划

- [x] 修改网格内缩和列轨道规则。
- [x] 修改侧栏停驻规则。
- [x] 在 Orca 真实 LinuxDo 页面验证列数、卡片尺寸和滚动位置。
- [x] 运行项目规定的语法与 diff 检查。

## 验证记录

- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- `git diff --check`：通过。
- Orca 真实 `https://linux.do/` 页面使用当前源码运行：`2029 × 1256` 视口下生成 30 张卡片，网格变为 4 列，单卡约 `294 × 294 px`，内缩为 `24px`，壁纸成功加载。
- Orca 真实页面滚动回归：滚动至 `600px` 后 `.sidebar-wrapper` 的 viewport `top` 仍为 `52px`，计算定位为 `sticky`；测试后页面恢复顶部。

## 结论

- 已完成本轮响应式网格和侧栏停驻；后续侧栏魔改保持未实现，等待单独需求。
