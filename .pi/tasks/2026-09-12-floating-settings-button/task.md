# 网页右侧浮动设置按钮

## 目标与决策

- 目标：在 LinuxDo 网页右侧中部增加 Material 3 设置按钮，让用户可直接进入现有壁纸与视觉设置页。
- 现状：`src/options.html` / `src/options.js` 已完整提供壁纸来源、远程/本地图片、遮罩、模糊和卡片透明度设置；`src/content.js` 已监听 `storage.onChanged` 并即时应用设置。
- 决策：新增网页内固定浮动按钮，点击复用 `runtime.openOptionsPage()` 打开现有设置页，不复制设置表单或建立第二套存储逻辑；按钮保持键盘焦点、可访问名称、reduced-motion 和窄屏适配。

## 计划

- [x] 在 content script 增加幂等设置按钮和打开现有 options 页的行为。
- [x] 增加右侧中部 Material 3 浮动按钮样式，覆盖 hover/focus/active、暗色与窄屏状态。
- [x] 运行静态检查并在 Orca 真实页面验证位置、点击入口和设置页打开行为，更新项目记录。

## 验证记录

- `npm run check`：通过，配置、内容脚本和设置脚本均通过 `node --check`。
- `git diff --check`：通过。
- Orca cache-busting `https://linux.do/latest?betterld_preview=settings-button-v1`：按钮数量为 `1`，固定位置 `right: 20px`、垂直居中，尺寸 `80 × 48px`，圆角 `999px`，Material 主色背景，`aria-label="打开 betterLD 设置"`。
- 点击回归：在 preview runtime stub 中成功调用 `runtime.openOptionsPage()`；真实扩展继续使用同一现有 `src/options.html` 设置页。
- 设置能力复用：现有 `storage.onChanged` 会即时应用壁纸、遮罩、模糊和卡片透明度变化，不复制第二套配置逻辑。

## 结论

- LinuxDo 网页右侧中部已提供可访问的 Material 3 “设置”按钮；桌面显示齿轮和文字，窄屏收缩为图标按钮，点击进入完整视觉设置页。
