# BewlyCat 通用设置实现

## 目标与决策

- 根据 `.pi/tasks/2026-09-12-bewlycat-reuse-design/design.md`，将非 Bilibili 专属的设置能力落地到 betterLD。
- 保持无依赖、无构建步骤的 Manifest V3 结构，保留现有壁纸、主题卡片、作者权威 JSON、原始 DOM 可恢复和 dirty worktree 改动。
- 先完成共享设置规范化与可操作设置页，再逐步接入卡片、壳层、交互、过滤、高级外观、搜索与同步。
- 未确认的 LinuxDo 页面采用条件纳入；不复制 BewlyCat 的 Vue 组件或 Bilibili 业务逻辑。

## 计划

1. Phase 0：新增共享 `src/settings.js`，扩展根配置和脚本加载链。
2. Phase 0/1/3/4：重做原生设置页，覆盖设计纳入的可调字段、搜索、分组、导入导出和状态提示。
3. Phase 1：接入主题卡片布局、显隐、字号、阴影和元数据消费解耦。
4. Phase 2：接入导航、Header / Sidebar 条件壳层、action rail、打开模式、操作菜单和抽屉。
5. Phase 3/4：接入过滤、快捷键、响应式、主题色、字体、受限 CSS 和高级外观。
6. Phase 5：确认并实现搜索设置、`storage.sync` 白名单投影和关于页。
7. 按设计验收标准执行目标检查，更新本记录和 `.pi/journal.md`。

## 验证记录

- 初始基线：工作区存在此前未提交的 `src/content.css` 和 `.pi/journal.md` 改动，实施过程中保留；未执行删除、reset、历史改写或哈希校验。
- 静态检查：`npm run check`、`node --check src/background.js`、`git diff --check` 通过；Manifest / 配置 JSON 解析、脚本入口、settings 字段和活动存储区分支 smoke 通过。
- 设置模型 smoke：规范化保留字段、规则大小写去重、非法规则拒绝、CSSOM 命名空间 / 属性白名单、外部资源拒绝、`toSyncSettings` 排除本地壁纸元数据与搜索历史均通过。
- 浏览器设置页：76 个动态标量控件和结构化编辑器实际加载；合法 CSS 注入、未命名空间 CSS 与 `url()` 拒绝通过；`en-US` 保存后文案、标题和枚举切换，回到 `zh-CN` 后中文文案和枚举恢复通过。
- 浏览器同步 fixture：local `syncEnabled=true` 首次读取 sync 远端，较新 sync 事件应用，sync 开启时 local 噪声事件不覆盖；content 同样从 sync 投影读取并完成 dark 模式、作者 JSON 和 include 过滤。
- content fixture：原始主题表隐藏、cards 生成、作者异步 ready、作者 / 标题过滤 pending 状态与空态、action rail / 独立设置入口切换通过。保留了未确认的真实 LinuxDo 搜索结果卡片为原生内容。
- 最终集成命令：`npm run check`、`node --check src/background.js`、Manifest/package JSON 解析和 `git diff --check` 均以退出码 0 完成；最终工作区只保留实现文件、项目留痕和既有 dirty worktree 记录，无生成依赖或构建产物。

## 结论

- betterLD 已按设计文档落地全部非 Bilibili 专属的可执行设置能力：壁纸 / 主题 / 卡片 / 导航壳层 / 链接抽屉 / 过滤 / 搜索设置 / 响应式 / 快捷键 / 语言 / 备份同步 / 关于页；Bilibili 专属播放器、动态、评论、账号和业务搜索未纳入。
- 运行时继续使用无依赖 Manifest V3、统一设置规范化、白名单 sync 投影和可逆原始 DOM 覆盖；搜索结果卡片、原站分页和未确认页面能力按设计保留条件范围。
