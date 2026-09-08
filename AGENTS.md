# betterLD 开发指南

## 项目概览

betterLD 是一个面向 LinuxDo 的浏览器美化插件，用于改善站点页面的视觉与交互体验。

## 当前状态

betterLD 首版采用可直接加载的无依赖 Manifest V3 扩展，覆盖 Chrome 和 Firefox 桌面端。

## 技术栈与目录

- `manifest.json`：Chrome / Firefox 共用的 Manifest V3 配置。
- `betterld.config.js`：首版运行参数与设置默认值的唯一参数文件。
- `src/content.js`：LinuxDo 首页路由识别、主题卡片转换、首帖摘要加载和视觉设置应用。
- `src/content.css`：Material 3 风格 Token、卡片网格和背景效果。
- `src/options.html`、`src/options.js`、`src/options.css`：扩展设置页与工具栏弹窗。

## 开发命令

- `npm run check`：执行 JavaScript 语法检查。
- Chrome：打开 `chrome://extensions`，启用开发者模式后加载项目根目录。
- Firefox：打开 `about:debugging#/runtime/this-firefox`，临时加载项目根目录中的 `manifest.json`。

## 代码约定

- 首版不引入运行时依赖或构建步骤，修改后直接加载项目根目录验证。
- LinuxDo 原有 DOM 只做精确覆盖和可恢复替换；插件自有设置 UI 保持独立。
- 运行参数集中维护在 `betterld.config.js`，不通过环境变量注入。
- 不新增测试框架；行为验证使用语法检查、配置解析和浏览器加载检查。
