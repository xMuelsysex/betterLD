# 用户菜单通知头像右上角元素

## 目标与决策

- 目标：确认真实用户菜单通知项头像右上角异常元素的来源，修复头像显示/覆盖层问题，同时保留头像、通知文字、未读状态和原有 DOM 交互。
- 根因：Discourse 在 `.icon-avatar.user-avatar` 内插入 `.icon-avatar__icon-wrapper` 通知类型图标（heart、follow、bell 等），原生位置为 `top: -7.2px; right: -10.4px`；头像容器的 `overflow: hidden` 将其裁成突兀叠层。附着上下文中的 `img.avatar` `0 × 0px` 是当时图片加载状态，当前预览已恢复为 `40 × 40px`。
- 决策：按用户菜单清爽头像目标，用 CSS 隐藏该装饰性通知类型图标；不改站点 DOM、不改通知路由和 JavaScript 状态。
- 影响范围：限定在 `src/content.css` 的头像/通知选择器。

## 计划

- [x] 用新的 cache-busting Orca 预览读取真实头像 DOM、伪元素、子节点和计算尺寸。
- [x] 定位根因并做最小 CSS 修复，隐藏突兀的通知类型叠层。
- [x] 运行定向检查与真实页面回归，更新本记录和项目流水。

## 验证记录

- `npm run check`：通过。
- `git diff --check`：通过。
- Orca cache-busting 预览 `https://linux.do/latest?betterld_preview=orca-1789279312984` 刷新并重新注入当前 CSS：30 个通知头像均为 `40 × 40px`，30 个 `.icon-avatar__icon-wrapper` 均为 `display: none`；`zy066` 头像为 `40 × 40px`。
- Orca 真实交互回归：切换“赞”标签后 active 节点为 `user-menu-button-likes`，30 个头像仍为 `40 × 40px`，通知类型叠层全部隐藏；点击 header“通知和帐户”后菜单从 DOM 移除，关闭态无遮挡。
- Orca 截图已捕获，头像区域无右上角叠层；未修改通知文字、tab、href 或未读 badge。

## 结论

- 已完成用户菜单通知头像清理，改动限定为 `src/content.css`，图片尺寸和圆形裁剪保持正常，原有通知内容与交互保持不变。
