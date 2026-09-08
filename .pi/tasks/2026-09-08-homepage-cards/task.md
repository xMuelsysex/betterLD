# betterLD 首页卡片首版

## 目标与决策

- 将 LinuxDo 首页主题信息流改造成约 350 × 350 像素的自适应卡片网格。
- 卡片预览区展示标题和首帖正文开头；正文以纯文本呈现，进入视口后按需加载并按卡片高度截断。
- 保留作者 ID、头像和压缩后的原有元信息；作者 ID 下使用分区原色 Material 3 风格 Chip 展示一级分区名称。
- 整卡沿用原帖链接行为；正文读取失败时展示标题与占位。
- 首版覆盖 Chrome / Firefox 桌面端，默认启用可调整的背景图、遮罩和模糊效果。
- 采用无依赖的 Manifest V3 静态扩展；自有设置 UI 使用原生 HTML，LinuxDo 页面改造使用 CSS 与 content script。

## 计划

1. 创建可直接加载的 Chrome / Firefox MV3 扩展骨架和根目录参数文件。
2. 实现首页识别、Discourse 主题条目提取、卡片网格替换、路由与动态 DOM 监听。
3. 实现首帖 JSON 按视口懒加载、纯文本提取、分区 Chip、失败占位和原生链接行为。
4. 实现背景图预加载、遮罩、模糊和设置页，并执行静态检查与最小加载验证。

## 验证记录

- 骨架检查：`npm run check` 通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 Node 语法检查。
- 配置检查：`manifest.json` 和 `package.json` 均通过 JSON 解析。
- 项目指南已补充当前技术栈、目录和加载方式。
- 真实 LinuxDo 页面已核对首页选择器与 Discourse DOM；CFT fixture 用同一 `https://linux.do` 匹配规则完成最终扩展注入验收。
- 首帖 JSON 按视口触发，首卡由 `loading` 变为纯文本 `ready`；卡片链接、作者 `neo`、分区 `运营反馈`、`800 · 2 小时` 元信息和分区颜色均正确。
- 动态烟测：源行元信息变化会更新卡片；替换源 `table` 不产生重复网格；`history.pushState` 离开首页会恢复源列表，返回首页会重新生成卡片。
- Chrome callback 与 Firefox Promise 存储 API 烟测均通过；默认范围值显示正确，非 HTTPS 壁纸被拒绝，合法图片预加载后应用到背景。
- 视觉变量烟测通过：遮罩、背景模糊、卡片透明度实时变更，旧壁纸变量会在清空设置后移除；设置页已生成本地截图预览。
- Chrome for Testing 151 真实加载项目目录扩展：`chrome://extensions` 显示 `betterLD`，LinuxDo 形态 HTTPS fixture 实际注入 1 个网格和 1 个卡片；首帖请求返回后摘要为纯文本 `ready`。
- 修复自适应填充：网格改为 `auto-fill + minmax(280px, 1fr)` 并移除总宽度上限；桌面网格随后增加每侧 `175 px` 的半卡宽留白，CFT `1440 px` 视口 10 张卡片排为 3 列、每张约 `342 × 342 px`，左右留白符合要求；`500 px` 视口保持单列。
- 实际扩展设置页烟测通过：默认值、非法 HTTP 壁纸拒绝、合法设置保存、恢复默认和 `chrome.storage.local` 内容均正确。
- Chrome branded 150 的 `--load-extension` 被浏览器本身忽略；已用本机 Chrome for Testing 151 完成真实加载验证，产品代码不依赖该测试启动参数。
- `npm run check` 和 `manifest.json` / `package.json` JSON 解析通过；项目当前没有 Git 仓库，因此 `git diff --check` 无法执行。
- Firefox 实际验证：临时 XPI 通过 `geckodriver 0.36.0` 安装，在 `https://linux.do:8443/` fixture 按真实匹配规则注入成功；网格、卡片、约 `324 × 324 px` 自适应尺寸、首帖纯文本 `ready`、分区 Chip 和源列表隐藏均正确。

## 结论

- 已完成 betterLD 首版首页卡片、自动填充网格、首帖摘要、分区 Chip、背景视觉设置和 Chrome / Firefox 存储兼容实现。
