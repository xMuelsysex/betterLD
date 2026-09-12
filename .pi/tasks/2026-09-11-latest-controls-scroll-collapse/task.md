# 最新页控制栏滚动收起展开

## 目标与决策

- 目标：让真实 LinuxDo 最新页的 `div.list-controls` 在页面向下滚动时自动收起，向上滚动时自动展开，并保留平滑动画。
- 约束：复用现有 `content.js` 路由与 `content.css` 样式体系；保持 sticky 定位、键盘可用性和 `prefers-reduced-motion` 行为；不改变 Discourse 原有导航功能。
- 决策：用内容脚本统一维护滚动方向状态，用 `data-betterld-scroll-state` 驱动 CSS；隐藏时设置 `inert`，防止不可见筛选控件被键盘聚焦。适用于主题列表页和分类列表页的同一 `.list-controls` 组件。

## 计划

- [x] 定位 `.list-controls` 的 JS/CSS 入口和调用关系。
- [x] 实现滚动方向状态与收起/展开动画。
- [x] 在 Orca 真实 `https://linux.do/latest` 页面验证上下滚动及减弱动画。

## 验证记录

- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- `git diff --check`：通过。
- Orca 真实 `https://linux.do/latest` 使用 query cache-busting 注入当前源码：向下滚动 `600px` 后控制栏为 `hidden`、`inert=true`、`opacity=0`、`translateY(-102px)`；向上滚动 `300px` 后恢复 `visible`、`inert=false`、`opacity=1`、sticky `top=52px`。
- Orca 计算过渡为 `transform, opacity, box-shadow`，时长 `0.18s, 0.18s, 0.16s`；样式表包含 `.list-controls` 的 `prefers-reduced-motion` 取消 transition 规则；页面恢复顶部。

## 结论

- 已完成最新页控制栏的下滚收起、上滚展开动画，保留原导航结构、sticky 定位和键盘可用性；未引入新依赖或额外配置。
