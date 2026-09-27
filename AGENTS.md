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
- `npm run package`：将当前扩展文件就地更新到固定测试包目录 `dist/betterLD/`；保留该目录，不另建带版本或时间后缀的 ZIP。
- Chrome：打开 `chrome://extensions`，启用开发者模式后加载 `dist/betterLD/`。
- Firefox：打开 `about:debugging#/runtime/this-firefox`，临时加载 `dist/betterLD/manifest.json`；交付有实际改动的新包时同步递增 `manifest.json` 和 `package.json` 版本，重新打包后对这个路径的附加组件点击「重新载入」，再刷新已打开的 LinuxDo 标签页。在 `about:addons` 的 betterLD 详情中核对新版本号以区分旧包和新包；版本已更新但页面未更新时，继续查内容脚本、用户设置和 CSS，而非重复打包。Firefox 已加载的内容脚本和样式留在内存中，仅覆盖磁盘文件不会更新页面。
- 交付前从 `dist/betterLD/` 实际加载扩展验证改动：检查页面确有 `body.betterld-shell` 和目标样式/控件，并核对附加组件实际加载的路径；仅比对源码与打包文件或在全新浏览器里加载，不能证明用户当前 Firefox 会话已经重载。Orca 的 `npm run preview:orca` 使用独立设置存储，只能辅助调试。
- 临时浏览器与驱动的短时验证使用有界前台命令；需长驻才启用后台任务，结束时主动停止并说明 `killed` 通知来自清理。浏览器退出时的网络/GPU 日志要与打包或页面验证失败区分，不让清理通知反复干扰交付。

## 代码约定

- 首版不引入运行时依赖或构建步骤；开发时可直接加载项目根目录，打包交付的验收必须使用 `dist/betterLD/`。
- LinuxDo 原有 DOM 只做精确覆盖和可恢复替换；插件自有设置 UI 保持独立。
- 运行参数集中维护在 `betterld.config.js`，不通过环境变量注入。
- 不新增测试框架；行为验证使用语法检查、配置解析和浏览器加载检查。
