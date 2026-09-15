# 按 BewlyCat 重做设置界面

## 目标与决策

### 目标

将 betterLD 的设置界面按 BewlyCat 的设置界面重新设计：在真实 LinuxDo 页面内以 BewlyCat 式大窗口呈现，采用「外层主分类 rail + 内容层子分类导航」的双层结构、「标题 + 描述 / 右侧控件」的设置行排版，以及 BewlyCat 的分段控件、开关与滑块。

### 权威参考

- 源码：`github.com/keleus/BewlyCat`，本地只读镜像 `~/.x-repo/github.com/keleus/BewlyCat`，取文件为 `src/components/Settings/*`（sparse checkout，仅设置相关路径）。
- 关键结构事实：`src/options/Options.vue` 是空占位页，BewlyCat 的设置界面不在扩展 options 页；真实设置窗口是 `90% × 90%`、`max 1000 × 900px` 的居中圆角玻璃 surface；窗口内侧 header 高 `92px`，含面包屑、圆角搜索框、`32 × 32` 关闭按钮；滚动区顶部有渐变遮罩；外层主分类 rail 悬浮在窗口左外侧（`xl` 偏移 `-84px`），内容层内为 `180px` 子分类导航；设置行是「标题 + 描述 / 右侧控件」并用 1px 分隔线相连，分组是 `fill-alt` 圆角卡片加 edge-glow 阴影；`≤760px` 时子导航折成顶部两列网格；搜索是跨分类 popover 跳转。

### In-Scope

- 宿主：沿用现有页面内 dialog + Shadow DOM，改为 BewlyCat 式大窗口尺寸与视觉。
- 双层导航：外层 7 类（常规 / 页面 / 组件 / 外观 / 快捷键 / 高级 / 关于），内层保留现有分组作为子分类导航。
- 设置行排版、分组卡、分节标题、分隔线、窄屏折叠均按 BewlyCat 结构复刻。
- 控件完全对齐：二值用 switch，短枚举用 segmented control，数值用 slider，多选标签用 toggle tag。
- 改动即时生效，取消保存按钮；恢复默认、导入、清空搜索历史保留独立确认。
- 主色取当前页面主题色（betterLD 已应用的主题色变量），取不到时回退紫色。
- 搜索：header 圆角搜索框 + 跨分类结果 popover 跳转。
- 结构化编辑器（断点列、卡片菜单项、筛选规则表、快捷键表、阴影曲线）保留并套用设置行排版。

### Out-of-Scope

- Bilibili 专属分类与字段，以及任何 Bilibili 业务语义。
- 引入 Vue、unocss、图标字体或任何运行时依赖；界面继续用原生 DOM 与 CSS。
- BewlyCat 的云同步协议与多语言体系；语言仍为现有 `zh-CN` / `en-US`。
- 以扩展独立 options 页作为主入口；页面内大窗口是唯一入口。

### Key Decisions

1. 宿主保持页面内大窗口，不改为扩展独立设置页。
2. 双层分类：外层 7 类照搬 BewlyCat 语义，内层沿用现有分组名与分组边界。
3. 控件完全对齐 BewlyCat，不再以原生 `select` / `checkbox` 作为主要控件形态。
4. 改动即生效，放弃保存按钮（见 `docs/adr/0001-settings-immediate-apply.md`）。
5. 设置界面主色取页面主题色，回退紫色。

## 计划

1. 扩展 `betterld.config.js` 的设置分类目录，集中维护主分类、子分类、控件类型与即时生效相关参数。
2. 重建 `src/options.html` 窗口壳：主分类 rail、内容面板 header（面包屑 / 搜索 / 关闭）、滚动区、无保存按钮。
3. 复刻 `src/options.css`：窗口与 rail 视觉、分节标题、分组卡、设置行与分隔线、switch / segmented / slider / toggle tag、窄屏折叠。
4. 重写 `src/options.js`：分类状态机、设置行渲染器、即时写入存储、搜索 popover、结构化编辑器。
5. 调整 `src/content.js` 的 Shadow DOM 宿主尺寸与结构为 90% × 90% 大窗口。
6. 按验收判据回归：真实页面截图对照、全分类交互、命令与留痕。

## 验证记录

### 静态检查

- `npm run check`（`betterld.config.js`、`src/settings.js`、`src/markdown.js`、`src/content.js`、`src/options.js`）与 `git diff --check` 退出码 0。

### Orca 真实页面（`https://linux.do/`，preview bg-3）

- 窗口：`1000 × 900`，页面模式 `dark`，surface `data-betterld-theme=dark`，主色 `#6750a4`（页面主题色），对比前景 `#ffffff`。
- 结构：rail 7 项、子导航 4 项（当前分类）、设置字段 87、segmented 25、switch 38、slider 11；breadcrumb「设置›常规›主题」、heading「主题」。
- 逐分类切换：`general`（4 子 / 8 字段）、`pages`（3 子 / 15）、`components`（4 子 / 3）、`appearance`（3 子 / 2）、`shortcuts`（1 子 / 4）、`advanced`（3 子 / 2）、`about`（1 子 / 0），可见面板与 heading 均与预期一致。
- 即时生效：`frostedGlassEnabled` 开关 → `--betterld-surface-blur` `16px → 0px → 16px`，状态提示「✓ 设置已保存。」；`topicListLayoutMode` segmented `reading → cards → reading`，中间态卡片重建 30 张；`cardMinSize` 滑块 `280 → 320 → 280`，`--betterld-card-min-size` 与 `output` 同步。
- 搜索：输入「壁纸」→ 8 条结果 popover，点击首条跳转到 页面 › 搜索、目标字段高亮、搜索框清空。
- rail hover：折叠 `56px` → 展开 `211px`，圆角 `32px`，项目宽 `192px`。
- 关闭按钮：`dialog.open → false`，节点保留供复用；加载失败时会标记 `panel.failed`，关闭后销毁以便下次重建。
- 编辑器：阴影曲线 3 行、网格断点 6 行、顺序编辑器 3 组 / 22 行、规则编辑器 3 组 / 3 个添加按钮、快捷键 3 输入；导出 / 导入 / 恢复默认 / 立即同步 / 清空历史按钮、关于版本与存储状态均存在；壁纸来源 5 项、内置目录 9 项。

### 未覆盖与限制

- 恢复默认的 `confirm` 确认未在预览会话中实际触发（原生模态框会阻塞自动化会话），该分支仅做静态核对。
- `≤760px` 窄屏折叠只有 CSS 规则就绪，未做真实视口验证（首版范围为桌面端）。
- Cloudflare 挑战期间注入失败会让设置窗口一次性失败；已补充「关闭后可重建」的重试路径，但首次打开仍需重试。

## 结论

- 设置界面已按 BewlyCat 的结构重做：页面内 `90% × 90%`（max `1000 × 900`）大窗口、外悬浮主分类 rail（折叠 56px / 展开 206px）+ 内容内 180px 子分类导航、设置行「标题 + 描述 / 右侧控件」与 1px 分隔线、`fill-alt` 圆角分组卡 + edge-glow 阴影、switch / segmented / slider / toggle 风格控件均照搬 BewlyCat 几何与 token。
- 改动即时生效：保存按钮与表单单列结构已移除，任何控件变化立即写入存储并作用于页面；恢复默认、导入、清空历史保留独立确认。
- 主色取页面主题色（`--betterld-primary`）与对比前景（`--betterld-on-primary`），深浅模式跟随 betterLD 当前模式（`:host([data-betterld-theme])` + `light-dark()`）。
- 保留既有数据层：设置规范化、`storage.sync` 投影、导入导出、规则校验、壁纸引擎与结构化编辑器均未重写，仅接入新容器与即时生效路径。
