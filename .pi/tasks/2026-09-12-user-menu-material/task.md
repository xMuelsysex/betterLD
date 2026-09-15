# 用户菜单 Material 3 改造

## 目标与决策

- 目标：将真实 LinuxDo 的 `div.user-menu.revamped.menu-panel` 通知/回复/赞/私信/书签等用户菜单改造成与 betterLD 现有 Material 3 token 一致的面板，同时保留 Discourse 原有标签页、链接、未读标记、滚动和键盘交互。
- 根因：当前 `src/content.css` 没有针对 `.user-menu`、`.menu-tabs-container`、`.quick-access-panel` 及菜单内容的覆盖，原生深色菜单面板与 betterLD 的圆角 surface、主色和 focus 体系不一致。
- 影响范围：优先使用 `src/content.css` 的 CSS 覆盖，不新增 JavaScript 状态、不复制设置表单、不改变站点 DOM 或路由行为；覆盖打开、active、hover、focus、未读和窄屏边界。

## 计划

- [x] 读取现有 token、content script 生命周期和真实菜单结构，确定可复用 selector。
- [x] 在 `src/content.css` 增加最小 Material 3 用户菜单面板与状态样式，保留原生交互。
- [x] 执行语法检查、差异检查，并用本机 preview service 做 cache-busting 的真实页面回归。

## 验证记录

- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- `git diff --check`：通过。
- Orca cache-busting 预览 `https://linux.do/latest?betterld_preview=orca-1789237695704` 刷新并重新注入当前 CSS：用户菜单外层为 `378 × 1188px`、`24px` 圆角、深色 Material surface；右侧标签栏为 `56px`，active 标签为 `40 × 40px` 主色 pill；通知项为 `16px` 圆角卡片，底部“查看所有通知/忽略”为 `40px` pill。
- Orca 真实交互回归：打开“通知和帐户”后切换“赞”标签，`user-menu-button-likes` 保持 active 主色状态且内容区更新；未改动原有 href、tab role 或菜单结构。
- Orca 关闭态回归：点击 header 的“通知和帐户”后 `.user-menu.revamped` 从 DOM 移除，页面未留下遮挡面板。
- Orca 截图已捕获，菜单面板与 betterLD 卡片、侧栏 surface 保持一致；浅色 token 临时注入检查确认外层面板切换到 `rgb(243, 237, 247)`、文字切换到 `rgb(28, 27, 31)`，未持久化页面设置。

## 结论

- 用户菜单已在现有 Material 3 体系内完成样式改造，改动限定为 `src/content.css`，保留站点标签页、通知链接、滚动、未读标记和键盘交互；当前验证覆盖桌面深色实时页面与浅色 token 路径。
- 仍需在实际窄屏 viewport 与登录权限变化下复测站点自身菜单内容，这是环境覆盖边界，不影响本轮 CSS 注入和桌面回归结果。
