# 首页阅读卡变体

## 目标与决策

- 新增一种首页主题卡片展示形式，并让用户可在设置中选择；保留现有卡片展示形式与 `native` 原生列表模式。
- 新形式单独提供测试界面，便于脱离真实 LinuxDo 页面校验视觉和 Markdown 内容。
- 内容结构参考用户提供的卡片：标题、作者与头像、辅助标签、Markdown 正文预览、互动数据和详情入口。
- 目标视口为桌面端；卡片采用略长的圆角矩形，具体宽高比例以阅读性和整体视觉平衡为准。
- 已将 `Reading Topic Card`、`Markdown Opening Preview` 和 `Card Presentation Style` 写入 `CONTEXT.md`。
- 默认展示形式为新阅读卡；核心 Markdown 覆盖标题、段落、加粗、斜体、链接、列表、引用、行内代码和围栏代码。
- 独立预览展示截图同构样例、较长 Markdown、无正文和加载失败状态。
- 生产互动数据尽量映射 LinuxDo 真实字段，缺失字段隐藏；独立预览使用固定示例数据。
- 低风险默认：复用现有整卡原帖导航语义，并让可见的 `View details` 入口指向同一原帖。

## 计划

1. [x] 第二轮确认 Markdown 边界、默认选项和独立预览数据。
2. [x] 检查现有主题卡片渲染、设置规范化、设置页绑定和预览启动方式。
3. [x] 在最小范围内新增阅读卡布局、设置选择项和静态测试界面，复用现有数据与导航行为。
4. [x] 执行语法、配置解析、静态预览和必要的浏览器/DOM 烟测，更新记录。

## 验证记录

- 已读取用户参考图、`CONTEXT.md`、项目 journal、首页卡片任务记录、主题网格任务记录和 BewlyCat 设计任务记录。
- 已确认工作区存在用户/前序任务的未提交修改；后续编辑需保留这些修改。
- 第二轮访谈已完成；用户选择了新阅读卡默认、核心 Markdown、多状态预览和真实字段缺失隐藏。
- 扩展点已确认：`topicListLayoutMode` 复用现有设置枚举；`src/settings.js` 会从 `settingsEnums` 自动规范化；设置页由 `fieldDefinitions` 和枚举文案自动生成；Orca preview server 可直接提供新增静态文件。
- 现有主题详情请求只返回纯文本摘要和作者；阅读卡需要保留 Markdown 原文并从主题 JSON 可选映射统计字段，缺失字段必须省略。
- 已实现 `reading` 布局：共享 `src/markdown.js` 安全渲染核心 Markdown；主题 JSON 请求使用 `include_raw=1`，以 `details.created_by` 为作者、按可用字段显示统计与参与者，空正文进入 `empty` 状态。
- 已接入 `betterld.config.js`、`src/options.js`、`manifest.json`、`scripts/orca-preview.js`、`src/content.js`、`src/content.css` 和独立 `reader-card-preview.html` / `src/reader-card-preview.css`；既有 `cards` / `native` 路径保持可逆。
- 已通过 `npm run check`、`node --check scripts/orca-preview.js`、配置与 Manifest 解析、`git diff --check`；本地预览检查了 5 种状态、桌面比例和窄屏无横向溢出，Markdown 检查了 `ol start`、HTTPS/相对链接与脚本过滤。
- 临时 Discourse DOM 烟测确认默认 reading 卡可从 JSON 更新作者、Markdown、参与者和统计；`cards → reading → native` 切换可重建并恢复原生列表；空字段保持隐藏且空正文显示 `正文为空`。
- 独立复审首轮发现的 3 项问题已修复；后续复审因模型 `429 usage_limit_reached` 未产出结果，根会话完成了当前源码的最终边界复核。
- 按后续视觉反馈将阅读卡桌面网格下限从 `540px` 调整为 `270px`，生产最小高度从 `420px` 调整为 `210px`，独立预览最小高度从 `460px` 调整为 `230px`；同步紧凑化内边距、字号、状态区和正文占位，避免缩小后内容裁切。
- 窄屏继续单列，卡片高度从 `500px` 调整为 `250px`；CSS 最小尺寸约 `326 × 230px`、比例 `1.42:1`，并让 1280px 预览自动使用 3 列，避免因最小高度导致横向溢出。
- 修复后续反馈：展开菜单卡片提升为 `z-index: 20` 并允许溢出，菜单面板为 `z-index: 40`；设置 surface 改为 `overflow: auto`；标题和正文均为 `14px`；主题元数据改用 `no-store`，并增加配置化单次恢复重试，避免 Cloudflare 错误响应被 HTTP cache 固化。
- 真实 LinuxDo Orca 回归通过：30 张 reading 卡作者状态为 `ready`，前 12 张均显示主题 JSON 的 `details.created_by.username`；菜单面板实际可命中，设置面板 `scrollHeight=8571`、`clientHeight=828` 且可滚动；标题/正文实测均为 `14px`。独立预览在 1280px 和 390px 视口均无横向溢出，console 无错误。
- 按后续视觉反馈去掉三点菜单的圆形包裹，改为透明无边框按钮（保留 `36 × 36` 可点击区域和 focus-visible 轮廓，hover 仅变色），并将阅读卡比例从 `1.42:1` 放宽变化为竖长卡片（依次试过 `1.2`、`0.7`，最终定为 `0.8:1`）；生产与独立预览同步修改。
- 真实页面复核（`1.2` 阶段）：卡片 `304.6 × 253.9px`，触发器 `background: transparent`、无边框/圆角/阴影/backdrop-filter，实测展开菜单仍可命中 9 个菜单项。最终 `0.8:1` 下 1440px 独立预览卡片 `437.7 × 547.1px`、正文区域高度 `375px`、无裁切与横向溢出；生产规则 `aspect-ratio: 0.8 / 1` 已在浏览器实际加载的 `src/content.css` 中确认。

## 结论

- 阅读卡已完成并可通过设置选择；新安装默认使用 `reading`，已有 `cards` / `native` 用户设置保持兼容。
- 独立预览页可直接验证 ready、loading、failed、empty 和长 Markdown 状态；桌面卡片为竖长的 `0.8:1`，CSS 最小尺寸约为 `326 × 230px`，1280px 自动为 3 列，窄屏仍为固定 `250px` 高度的单列。
- 验证覆盖源码语法、配置/Manifest、共享 renderer 安全边界、真实 DOM 卡片接入、布局切换、菜单层级、设置滚动、作者恢复和预览视觉；真实 LinuxDo Orca 回归通过，30/30 作者信息可用。
