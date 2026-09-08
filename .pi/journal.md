# betterLD 项目流水

## 2026-09-08：完成首版首页卡片与视觉设置

- 完成无依赖 Manifest V3 扩展：首页主题行转换为约 `350 × 350 px`、按可用空间自动填充的卡片网格，保留帖子链接、作者 ID、头像和压缩元信息，分区显示 Material 3 Chip。
- 首帖正文通过同源 `/t/{id}.json` 按视口懒加载，HTML 清洗为纯文本并按卡片预览区域截断；请求失败显示占位状态。
- 完成 SPA 路由监听、动态主题行同步、原列表恢复、背景图预加载、遮罩、模糊、卡片透明度和原生设置页。
- `chrome.storage.local` 同时兼容 Chrome callback 与 Firefox Promise 调用；设置页包含 HTTPS 背景 URL 校验、范围归一化和恢复默认。
- 验证：`npm run check`、配置 JSON 解析、Chrome for Testing 151 真实目录扩展加载、Firefox `geckodriver 0.36.0` 临时 XPI 加载、LinuxDo 形态 HTTPS fixture 注入、宽窄视口卡片尺寸、首帖摘要、设置保存恢复均通过。
- 自动填充与边距验证：网格使用 `auto-fill + minmax(280px, 1fr)`；桌面端每侧预留 `175 px` 半卡宽，CFT `1440 px` 视口排为 3 列、卡片约 `342 × 342 px`，左右留白符合要求；当前目录尚未初始化 Git 仓库。Chrome branded 150 的 `--load-extension` 被浏览器自身忽略，真实 Chrome 加载验证使用本机 Chrome for Testing 151 完成，Firefox 实际 XPI 验证已补齐。
