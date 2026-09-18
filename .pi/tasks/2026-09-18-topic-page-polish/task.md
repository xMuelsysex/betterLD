# 2026-09-18 话题页三处修正：用户卡片圆角、时间轴滑块黑边、刷新后回到页首

## 目标与决策

主人给了三件事（都是话题页 `/t/topic/2916181` 上看到的）：

1. **用户卡片「四个角好像有两个弧度」**。实测（Orca 真实页面 + CDP 等价的规则枚举）：
   `.user-card` 被站点放在 `.fk-d-menu__inner-content` 里，两层都画了材质面与 1px 描边，
   我们给卡片的圆角是 `--betterld-radius-xl`（24px），给浮层容器的圆角是 `--betterld-radius-lg`（20px），
   容器是父层、卡片比它内缩 0.667px → 每个角上出现两条弧线（对角采样能看到两个亮峰：i=9 与 i=12）。
   决策：卡片的圆角对齐容器、描边只由容器画一次（卡片在外层菜单容器里时去掉自己的 border / 改用同半径），
   卡片自身的底色与模糊保留，避免整卡透明度变化。
2. **时间轴滑块的黑边**。枚举匹配规则 + 逐表禁用隔离后定位到站点主题自己的
   `common_theme_-2_*.css`：`.timeline-container .topic-timeline .timeline-scrollarea .timeline-handle { outline: 3px solid var(--d-content-background) }`，
   深色模式下就是一圈近黑描边。决策：betterLD 直接关掉这条 outline（不动它的底色与圆角）。
3. **页面最底部刷新后停原位、不回到页首**。定位结论：linux.do 上 `history.scrollRestoration` 被站点设成 `manual`
   （浏览器不会恢复），真正把视图拉回底部的是**站点自己**：话题页启动时会跳到上次阅读位置，
   实测 `location.reload()` 后 y 从 3913 变成 3021/2706 并停在那里，URL 也被改写成 `/t/topic/16181/6` 这类带楼层号的地址。
   决策：betterLD 的刷新写一个「刷新后回页首」的意图，由刷新后的页面接管，在
   `refreshScrollTopWindowMs` 时间窗内把位置钉在顶部（已在顶部时不动作），窗口结束后自动失效。

## 计划

1. 真实页面定位三处根因（规则枚举、逐表禁用、像素级对角采样、时间轴截图）。
2. 改动：`src/content.css` 两处规则；`src/content.js` 刷新意图；`betterld.config.js` 两个参数。
3. 真实页面复核：卡片四个角单弧线、滑块无描边、底部刷新落在页首，并确认窗口过后不再被拉回。

## 验证记录

- 用户卡片：真实页面点击头像打开卡片，对角像素采样（Orca 截图 + PIL）修改前在 TR/TL 角各有两个亮峰
  （TR: i=12 `(36,34,40)` 与 i=15 `(62,59,68)`；TL: i=13-14 与 i=16-18），改后只剩一个（TR: i=12 `(64,64,71)` 后恒为卡面色 `(33,31,38)`）。
  卡片计算样式：`border: 0px`、`border-radius: 20px`，外层 `.fk-d-menu__inner-content` 仍是 20px + 0.667px 描边；整卡截图外观与改前一致（底色/模糊未变）。
- 时间轴滑块：站点规则定位到 `common_theme_-2_bf6944a8...css`（`outline: 3px solid var(--d-content-background)`）。
  改后计算样式 `outline-style: none`；6 倍放大截图里滑块是干净胶囊，无黑环。
- 刷新回页首：先复现问题（滚轮到 3913 → `location.reload()` → 停在 3021，URL 变 `/t/topic/2916181/6`）。
  加意图后：在底部点更好的刷新按钮 → 新页面 y=0，意图被接管并清除；窗口内人为把页面再滚到底部会被拉回 y=0，
  窗口（2.5s）过后再滚到底部会停在底部 → 时间窗有界、不会持续抢滚动。`npm run check` exit 0、`git diff --check` 通过、`src/content.css` 花括号 541/541。

## 结论

- 用户卡片（含 group/category 卡片）在站点浮层容器里只保留一层 20px 圆角与一条描边，四个角不再出现第二条弧线。
- 话题时间轴滑块去掉站点主题的 3px 内容色描边。
- betterLD 的刷新（含合并后的「返回顶部或刷新」）会把刷新后的页面钉在页首；意图在 `sessionStorage` 里跨导航传递，
  窗口结束后失效，用户随后自由滚动不会被干预。
- 边界：卡片圆角从 24px 变为与外层一致的 20px（与其它 betterLD 浮层材质面统一）；站点若在刷新后 2.5s 之后才跳转阅读位置，本窗口不会纠正。
