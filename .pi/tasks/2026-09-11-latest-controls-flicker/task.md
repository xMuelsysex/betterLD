# 最新页控制栏闪烁修复

## 目标与决策

- 目标：消除 Orca 真实页面的持续闪烁，同时保留 `.list-controls` 下滚收起、上滚展开。
- 已确认根因：同一页面重复注入 content script 会创建多个 `MutationObserver`、滚动监听和状态机；对照测试中 2 秒产生约 429 条 DOM mutation 并重播入场动画。单次注入在异步摘要加载完成后稳定。
- 决策：content script 在同一页面使用幂等锁；滚动方向使用配置中的累计距离阈值，并只在显隐状态真正变化时写入 DOM；移除动态主题网格、卡片和摘要的入场动画，保留控制栏滚动 transition。

## 计划

- [x] 增加 content script 幂等锁并减少滚动状态写入。
- [x] 刷新 Orca 页面后单次注入当前源码。
- [x] 验证静止期间无持续 DOM mutation，且上下滚动仍正常。

## 验证记录

- `npm run check`：通过，配置、内容脚本和设置脚本均通过 `node --check`。
- `node -e ...` 配置解析：通过。
- `git diff --check`：通过。
- Orca 新建 cache-busting `https://linux.do/latest` 页面并单次注入当前源码：2 秒稳定监测为 8 条 mutation、仅站点 `float-down` 动画、30 张卡片/1 个网格、控制栏 `animation=none` 且滚动 transition 保留。
- 重复执行 preview 后：2 秒为 16 条 mutation、仍仅 1 个站点动画；修复前对照约 429 条 mutation。
- 滚动回归：下滚 `4px` 保持 visible，下滚至 `24px` 后 hidden/inert；反向上滚 `4px` 保持 hidden；回到顶部后等待 `250ms` 恢复 visible、opacity `1`、transform `none`。

## 结论

- 页面闪烁根因已修复；重复注入不再创建第二套观察器/监听器，异步内容更新不再重播卡片入场动画，控制栏滚动收起展开保持可用。
