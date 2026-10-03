# betterLD

> 面向 [LinuxDo](https://linux.do/) 的零依赖 Manifest V3 浏览器扩展：把论坛首页主题信息流改造成 Material 3 风格的响应式卡片网格，并附带可配置的首页背景。

全部代码为原生 JavaScript / CSS / HTML，约 4000 行，无框架、无打包器、无运行时依赖——改完直接在浏览器里加载即可验证。

## 功能

| 区域 | 改造内容 |
| --- | --- |
| 首页信息流 | 主题条目（Topic Card）转换为响应式卡片网格，卡片目标尺寸约 350 × 350，最小宽度 280px、列间距 16px、侧边留白 24px |
| 封面区 | 原视频封面区域改为展示帖子标题 + 正文开头预览，正文以纯文本呈现 |
| 作者身份 | 保留原帖作者 ID 与头像；回复数、最后活动时间等元信息以紧凑形式保留 |
| 分区标识 | 在作者 ID 下方以使用分区原色的 Material 3 Chip 展示一级分区名 |
| 视觉增强 | 可调背景图片 + 页面遮罩 + 卡片模糊，跟随站点主题自动切换明暗配色 |
| 主题回复 | 主题页默认以真实回复关系的多级树代替按时间排列的原生回复流：父回复包含子回复，保留完整正文和图片、可折叠，滚动接近末尾时自动加载后续回复；默认同时显示昵称与用户名，可在设置中改为仅显示其中一种；完整显示原站上传和字母头像，保留日期并追加会更新的相对时间；点击头像打开原站用户卡片；每层以一个 Material 按钮展示回应图标与数量：点击图标点赞、点击数字在树内查看原站回应人名单（支持分页），悬停或长按选择其他回应（选择器中也可查看名单），提交后按原站返回数据更新状态；已选中某个回应时再次点击即取消当前回应；楼内已有的 Boost 按原站形态显示在该楼操作栏下方（无 Boost 则不显示）；没有 Boost 的楼层用操作栏的 Boost 按钮、已有 Boost 的楼层用列表末尾的火箭按钮，就地在同一楼下方展开原站同款编辑器（当前用户头像 + 文本域 + 提交/取消，尺寸与素材继承原站插件 CSS），回车提交、Escape 或取消关闭；提交后新气泡立即出现在该楼 Boost 列表里；另提供复制链接、更多操作和回复入口；其他菜单或编辑器自动定位对应楼层，之后可返回树视图。 |

可视设置项与取值区间（越界值在读取时即被 `clamp` 到区间内）：遮罩不透明度 0–0.8、背景模糊 0–32px、卡片不透明度 0.55–0.95。参数通过 CSS 自定义属性（`--betterld-mask-opacity`、`--betterld-background-blur`、`--betterld-card-opacity`、`--betterld-card-min-size`、`--betterld-card-side-gutter`、`--betterld-grid-gap`）注入页面，参数值与样式消费分离。
| 导航 | 整张卡片沿用原帖链接语义，保留右键、Ctrl/Cmd 点击、键盘新标签页等浏览器原生操作 |

## 设计要点

**参数集中且冻结。** 所有运行参数与设置默认值集中在 `betterld.config.js`，以 `Object.freeze` 发布的单一 `globalThis.BETTERLD_CONFIG` 对象提供：路由轮询周期、设置同步防抖、卡片尺寸与间距、摘要懒加载阈值与字符上限、摘要/作者请求重试次数与延迟、壁纸模式与内置图库、设置项上下限。不通过环境变量注入参数，也不存在第二份默认值。

**纯精确覆盖，不改站点数据。** LinuxDo 原有 DOM 只做精确覆盖和可恢复替换；离开首页（`popstate` / `hashchange` / 500ms 轮询检测）即恢复原生页面结构。插件只影响当前用户的浏览体验，不改变服务端数据，也不改变其他用户看到的内容。

**摘要按需加载且可降级。** 卡片进入视口（`IntersectionObserver`，`rootMargin: 240px`）才读取首帖正文，按预览区域实际高度截断（上限 2400 字符）并做内存缓存；单个帖子读取失败只在正文区域显示占位状态（`正文预览暂不可用`），不影响首页其他卡片。

**背景来源三选一，失效即回退。** 支持网站随机图（`picsum.photos` 按日期播种，每天固定一张）、内置图库（8 张，含 NASA、BML2019 等）和用户自定义（远程 URL 或本地图片）。本地图片经 canvas 压缩为 JPEG（quality 0.9，最长边 2560 × 1440，≤ 8MB）后存入 `browser.storage.local`。任何来源失效时回退到明暗对应的内置渐变，页面保持可用。

**配色跟随真实主题状态。** `content.js` 通过 `MutationObserver` 监听 `documentElement` / `body` 上的 `class`、`style`、`data-color-scheme`、`data-theme`、`data-theme-name` 变化，并监听系统 `prefers-color-scheme`，据此切换背景、遮罩、卡片与文字的对比度。

**幂等与自恢复。** 内容脚本以 `globalThis.__betterldContentScriptActive` 防重入；DOM 变更由 `MutationObserver` 触发，插件自身写入期间置 `mutating` 标志避免自激循环，写入结束经 160ms 防抖同步。

**双浏览器单份清单。** 一份 MV3 `manifest.json` 同时覆盖 Chrome 与 Firefox 桌面端（`browser_specific_settings.gecko`，`strict_min_version: 109.0`）；运行时以 `globalThis.browser || globalThis.chrome` 适配扩展 API 差异。

## 目录结构

```
manifest.json          Chrome / Firefox 共用的 Manifest V3 配置
betterld.config.js     运行参数与设置默认值（唯一参数文件）
src/content.js         路由识别、卡片转换、摘要加载、视觉设置应用
src/content.css        Material 3 风格 Token、卡片网格、背景效果
src/options.html       设置页（同时作为工具栏弹窗）
src/options.js         设置读写、壁纸选择与本地图片压缩
src/options.css        设置页样式
```

## 本地加载

```bash
npm run check   # 三个 JS 入口的语法检查
```

- **Chrome**：打开 `chrome://extensions`，启用开发者模式，加载已解压的扩展程序 → 选择项目根目录。
- **Firefox**：打开 `about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选择根目录下的 `manifest.json`。

首版不引入运行时依赖或构建步骤；修改后重新加载扩展即可生效。

## 范围与不变量

- 覆盖范围为 Chrome / Firefox **桌面视口**；移动端不属于首版适配范围。
- 首版改造只在真实首页（`https://linux.do/`）启用，其他页面不自动视为同等范围。
- 不把用户 Trust Level 当作分区信息；不用帖子内容替换作者身份信息。
- 领域术语与不变量见 `CONTEXT.md`，开发约定见 `AGENTS.md`。

## 免责声明

本项目为个人使用的第三方美化扩展，与 LinuxDo 官方无关。内置壁纸版权归各自作者所有，仅作默认背景展示。
