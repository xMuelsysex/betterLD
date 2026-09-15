# 主题过滤升级：标签轴、匹配模式、白名单、淡化模式

## 目标与决策

- 主人要求：① 刷新提示条铺满内容区（已单独完成，见 `2026-09-15-refresh-notice-full-width`）；② 调研 GitHub 上其他 LinuxDo 插件并集成能力，例如「按规则屏蔽帖子」。
- 调研结论（GitHub / GreasyFork 实测，详见下节）：betterLD 已有「标题 / 作者 / 分类」三轴关键词过滤，社区实际基准是**四轴**（标题 / 作者 / 分类 / **标签**），且主流还提供整词与正则匹配、独立白名单、淡化中间态。
- 决策一：把过滤能力补齐到社区基准，而不是照抄某个插件的实现——新增标签规则组、白名单规则组、三种匹配方式（包含 / 完整词 / 正则）、淡化命中行为，规则导入改为追加去重。
- 决策二：规则组定义收敛到 `betterld.config.js` 的 `topicRuleGroups`（key / title / empty / help），settings.js、options.js、content.js 全部从这一处派生，避免规则 key 在 6 处硬编码（原实现就是 3 个数组 × 多处枚举）。
- 决策三：正则合法性在保存时校验（`validateSettings` → `validateRuleArrays`），非法表达式直接拒绝并给出字段级错误，而不是静默降级；content.js 侧仅对「已存在存储里的非法正则」保留一条带 `console.warn` 的忽略路径。
- 决策四（不做的部分）：不集成自动浏览 / 自动点赞 / 刷已读类脚本——它们会改动服务端数据与其他用户可见状态，与 `CONTEXT.md` 中 betterLD 不改变 LinuxDo 服务端数据的既有不变量冲突；服务端 ignore（调用 Discourse API 永久屏蔽用户）同样会写到账号上，留待主人明确要求后再做。办公伪装皮肤、AI 总结、WebDAV、收藏夹等属于不同产品取向，本轮不引入。
- 影响文件：`betterld.config.js`、`src/settings.js`、`src/content.js`、`src/content.css`、`src/options.js`、`src/options.html`、`src/options.css`。

## 计划

1. config 定义规则组单一来源、新枚举与新默认值。
2. settings.js 规则组循环化 + 正则校验接入保存路径。
3. content.js 匹配模式、标签轴、白名单优先级、淡化状态机。
4. content.css 淡化样式。
5. options.js / options.html 规则编辑器与字段渲染、导入追加去重。
6. Orca 真实页面逐项验证。

## 调研要点（原始报告见会话记录，此处保留可复用结论）

- 面 **linux.do** 的插件里维护最活跃、功能最全的是 `anghunk/linuxdo-scripts`（2782★，Apache-2.0）；过滤实现最工程化的是 `rianlu/do-trash`（本地垃圾桶 + 可还原）；唯一做**服务端** ignore 的是 `wowhao333/linuxdo-script-lite` 与 GreasyFork #589525。
- 「屏蔽/过滤」类项目共调查 17 个，支持**标签轴**的有 9 个（do-trash、#589673、naseaoi/linuxdo-enhanced、#588763、chadyi/LinuxdoSieve、Cedriccmh/linuxdo-filter、airline233、anghunk、#577799），支持**用户正则**的只有 3 个（#588763、#590271、#582479）。
- 更好的导入语义是「追加 + 判重」（#589673 的 ruleKey 指纹），优于全量覆盖；本轮采用追加 + 关键词去重（复用 `normalizeRules` 既有的 identity 去重）。
- 需注意的反证：Discourse 子分类页面行内可能不渲染标签，标签规则在这些页面天然不命中；因此规则组 help 明确写出该限制，不做静默降级。
- 点名候选查证结果：`linuxdo-userscript`、`linuxdo-enhance`、`linuxdo-helper` 三个裸仓库名均 404；真实项目分别是 `naseaoi/linuxdo-enhanced`、`xiaohuihui202504/linuxdo-helper-extension`。

## 验证记录

环境：`npm run preview:orca`（Orca 真实 `https://linux.do/new`，Cloudflare 质询后注入，30 张卡片）；设置通过预览 storage 桥（`chrome.storage.local.set`）驱动，走真实的存储 → content.js 变更链路。

过滤矩阵（`topicFilterEnabled=true`，除最后一行外）：

| 用例 | 结果 |
| --- | --- |
| 基线 | 30 张卡片，`data-filter-tags` 已填充真实标签（人工智能 / 快问快答 人工智能 / …） |
| `contains` 标签=人工智能 | 隐藏 16 / 可见 14，隐藏项标签均含人工智能，可见项标签均不含 |
| `whole` 标签=智能 | 隐藏 0（「智能」在「人工智能」内部，词边界不成立） |
| `contains` 标签=智能 | 隐藏 16 → 与上一行构成差异对照，证明整词与包含确实是两种语义 |
| `regex` 标签=`^人工` | 隐藏 10（仅以「人工」开头的标签命中） |
| 白名单=Google + 标签=人工智能 | 隐藏由 16 降为 15，标题含 Google 的那张保持可见 |
| `dim` 标签=人工智能 | 淡化 16 / 隐藏 0，淡化卡计算 `opacity: 0.4`、`hidden=false` |
| `include` 标签=人工智能 | 可见 16，且可见项标签全部含人工智能 |
| 关闭过滤 | 30 张全部可见 |

- 淡化模式的视觉确认：同一张截图内取两块正文区域做灰度统计，淡化卡最亮像素 `114`（p95 `95`），未淡化卡最亮 `199`（p95 `191`），确认淡化真的影响绘制而不只是属性变化。
- 设置界面：`[data-rule-editor]` 渲染为 5 组（标题 / 分类 / 标签 / 作者 / 白名单，顺序与 config 一致），字段数 80 → 81，新增「关键词匹配方式」三段控件（包含关键词 / 完整词匹配 / 正则表达式），「过滤命中行为」增加「淡化命中项」。
- 正则校验：切到正则模式后保存合法表达式 `^【` → `✓ 设置已保存。`；保存非法表达式 `C++((` → `设置未生效。 topicTitleRules[0] 不是合法的正则表达式`，存储中的规则保持不变。
- 规则导入：`confirm(false)` 不改变存储；`confirm(true)` 后标题规则由 `["^【"]` 变为 `["^【","新规则"]`（重复的 `^【` 未被重复追加）、标签规则由 `["人工智能"]` 变为 `["人工智能","抽奖"]`，状态提示列出各组条数。
- 修复记录：首轮矩阵发现 `include` 模式回归（可见 30 张，应约 16 张），原因是把「非 hide 即可见」的简化条件与 include 混用；改为白名单 / include / dim / hide 四分支显式状态机后复测通过。
- 静态检查：`npm run check` 通过；`git diff --check` 通过。

未覆盖：Firefox 真实页面；跨设备 `storage.sync` 投影里新规则组的实测（`toSyncSettings` 只排除 4 个键，新组自动同步，属代码层推定）；正则模式与作者轴组合的实测（作者 JSON 到达后的二次判定沿用既有 `pending` 状态机）。

## 结论

- 过滤能力补齐到社区基准：四轴规则（标题 / 分类 / 标签 / 作者）+ 白名单（最高优先级，命中即不过滤）+ 三种匹配方式 + 淡化 / 隐藏 / 只显示三种命中行为 + 追加去重的规则导入。
- 规则组 key 从 6 处硬编码收敛为 config 单一来源；正则合法性在保存路径上校验。
- 自动浏览 / 自动点赞 / 服务端 ignore 等会改动服务端数据的能力明确不集成，理由记录在上文决策四。
