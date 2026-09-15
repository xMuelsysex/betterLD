# 刷新提示条铺满内容区宽度

## 目标与决策

- 问题：主人指出 `.show-more.has-topics` 刷新提示「得覆盖到整个网页」。
- 现状：外层 `.show-more.has-topics` 已经是全内容宽（`width: 100%` + `justify-content: center`），但它只是横向居中容器；内层可点击的 `a.alert.alert-info.clickable` 是 `display: flex` 且没有宽度约束，因此收缩成内容宽度，视觉上是一个居中窄胶囊。
- 决策：给内层 `a` 加 `flex: 1 1 auto` + `width: 100%`，让它铺满外层容器。外层已是内容区宽度，内层铺满后即与主题卡片网格左右对齐，不需要改外层或引入新的容器。
- 影响文件：`src/content.css`（1 个规则块新增 2 行）。

## 计划

1. 在真实页面量出提示条、`#list-area`、卡片网格三者宽度。
2. 只让内层 `a` 铺满，不引入额外包装层。
3. 复核修复后与卡片网格的左右对齐。

## 验证记录

环境：`npm run preview:orca https://linux.do/latest`（Orca 真实页面，Cloudflare 质询后注入；视口 `1145 × 765`）。

- 修复前：`.show-more.has-topics` `x=315 w=783 h=48`，内层 `a` `x=607 w=199 h=48`（居中窄胶囊）；卡片网格 `x=315 w=783`。
- 修复后（重新加载 + 缓存穿透注入）：内层 `a` `x=315 w=783 h=48`；与卡片网格 `leftDiff=0`、`widthDiff=0`，即左右边缘与卡片网格完全对齐。
- 视觉确认：截图显示提示条横跨内容区，文案「查看 3 个新的或更新的话题」居中，圆角/描边/主色 tonal 底与卡片风格一致。
- 其他宿主：`/new`（`betterld-topic-page`）注入正常、网格同为 `x=315 w=783`，该路由当前没有刷新提示节点可测；提示条规则块对 home / topic / categories 三类页面共用。
- 静态检查：`npm run check` 通过；`git diff --check` 通过；`git diff --stat` = `src/content.css | 2 ++`。

未覆盖：Firefox 真实页面；`/new`、分类页当前无提示节点，未在这些路由上实测提示条本体。

## 结论

- `src/content.css` 刷新提示内层链接补 `flex: 1 1 auto; width: 100%;`，提示条自此铺满内容区并与卡片网格对齐。
