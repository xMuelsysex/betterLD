# betterLD BewlyCat 壁纸与真实首页

## 目标与决策

- 将当前仅支持单个 HTTPS 背景 URL / 内置渐变的视觉设置，扩展为 BewlyCat 风格的完整壁纸来源选择。
- 壁纸来源包含网站随机图片、完整内置图片目录、HTTPS URL 和本地上传；网站随机图片每天固定一张，图片加载失败回退到明暗对应的内置渐变。
- 深浅色模式自动优先跟随 LinuxDo 当前主题，无法识别时跟随系统偏好；主题变化同步背景、遮罩、卡片和文字对比度。
- 首版只在真实 `https://linux.do/` 首页启用卡片与背景改造，离开首页恢复原页面。
- 继续保持无依赖 Manifest V3、Chrome / Firefox 桌面端和原生设置页；不引入构建步骤或运行时依赖。

## 计划

1. 在根目录参数文件中补齐 BewlyCat 壁纸目录、来源模式和每日随机规则所需参数。
2. 将设置页改为支持内置目录选择、网站随机图、HTTPS URL、本地上传、预览和恢复默认，并保持现有视觉参数。
3. 在 content script 中解析并预加载壁纸来源，持久化每日随机结果，处理失败回退，并加强真实 LinuxDo 首页的主题同步。
4. 运行语法/配置检查，在真实网站加载扩展验证首页卡片、壁纸来源、明暗模式和路由恢复，并写回验证证据。

## 验证记录

- `npm run check`：通过，`betterld.config.js`、`src/content.js`、`src/options.js` 均通过 `node --check`。
- 独立 reviewer 发现并已修复 2 个边界：随机壁纸跨日缺少触发点、设置页随机预览未使用当天 seed；修复后重新执行聚焦回归。
- 真实 `https://linux.do/` 页面 Playwright 验收：实际页面包含 30 条 `.topic-list-item`；扩展脚本接入后生成 30 张卡片，原表格隐藏，作者 `neo` 和分区 `运营反馈` 正确显示。
- 修复后重打真实 Firefox 153 + geckodriver 0.36.0 临时 XPI 验收：安装 `betterld@linux.do` 成功；线上首页得到 `cards=30`、`mode=light`、`home=true`、`tableHidden=true`；临时深色 class 使模式变为 `dark`；切换到 `/latest` 后网格移除并还原表格，返回 `/` 后重新生成 30 张网格。
- 真实页面背景模式验收：内置图 `rocky-mountain-cloudscape`、按日 Picsum seed `2026-09-08`、本地 `data:image` 均成功预加载并写入背景变量；随机结果保存为当天 URL。
- 跨日回归：将真实页面时钟推进 1 天后，`routePollMs` 触发重新解析并写入 `2026-09-09` 的 `https://picsum.photos/seed/2026-09-09/2560/1440/?nature`，卡片仍为 30 张。
- 设置页文件页验收：显示 5 种来源、8 张固定内置图和 1 个随机图预览；随机预览为当天 seed URL；选择内置图保存成功；上传截图作为本地图片后压缩为 JPEG 并保存成功（约 131 KB）。保存为 `green-white-mountains` 后重新打开，目标项保持 `aria-pressed="true"`，8 张缩略图 URL 均正确。
- `git diff --check`：通过。预览截图：`betterld-settings-wallpaper.png`。
- 线上页面另有 Cloudflare Turnstile / Identity Provider 控制台错误，与扩展逻辑无关；浏览器原生扩展 UI 未在可见桌面窗口打开，Firefox 临时 XPI 和真实页面 WebDriver 验收已覆盖注入、路由和主题边界。
- 最终 `npm run check` 与 `git diff --check`：均通过。

## 结论

- 完成 BewlyCat 风格壁纸来源、每日随机、本地上传、失败渐变回退和自动明暗模式，并将首版卡片改造落实到真实 LinuxDo 首页。
