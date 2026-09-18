# 设置界面居中 + BewlyCat 可用能力缺口核对

## 目标与决策

- 目标 1：把设置界面移到屏幕中间。
- 目标 2：核对 BewlyCat 里对 LinuxDo 可用、但 betterLD 还没做的能力。

根因（设置界面贴顶）：

- 页面内设置窗口的 shadow 宿主 `.betterld-settings-dialog__surface` 由 `src/content.css` 的
  `.betterld-settings-dialog__surface { display: block }` 接管，而 shadow root 内 options.css 的
  `:host { display: grid; place-items: center }` 在外层文档规则面前失败（同特异性下外层赢），
  于是只剩 `justify-items` 起作用：横向被居中，纵向居中丢失，窗口贴在视口顶部。
- 实机证据（linux.do/tags，视口 1145×765）：宿主计算 `display: block`；
  `.settings-window` rect = `[37, 0, 1072, 689]`（y=0，底部空 76px）；
  在页面里强制 `surface.style.display = "grid"` 后 rect 变成 `[37, 39, ...]`；
  独立设置页（`body { display: grid; place-items: center }`）同为 `y=39`。
- 结论：居中必须写在**同一层外层规则**里，不能依赖 shadow root 的 `:host`。

决策：

1. 在 `src/content.css` 的 `.betterld-settings-dialog__surface` 上直接声明居中
   （`display: flex` + `align-items: center` + `justify-content: center`），保留原有 `width/height/overflow`。
   不新增第二套定位机制（不用 `position: absolute` + `inset` 替代），窗口尺寸与内部布局保持不变。
2. 核对时发现同屏缺陷：卡片操作菜单排序编辑器的最后一行显示裸键 `ignoreAuthor`
   （`labelMap` 缺条目，`content.js` 里权威中文是「在服务端屏蔽作者」），补上标签。

## 计划

1. 复现并定位贴顶根因（已用实机 rect + 强制 display 对照完成）。
2. 改 `content.css` 一条规则；改 `options.js` 一处标签。
3. 实机验证：窗口双轴居中、7 个主分类与滚动、关闭/重开、卡片菜单标签。
4. 核对 BewlyCat 设置清单（`.x-repo/github.com/keleus/BewlyCat` 的 Settings 组件 + `searchCatalog.ts`）
   与 betterLD 现有设置，产出缺口清单。

## 验证记录

- `npm run check` exit 0；`git diff --check` 通过；`content.css` 花括号 521/521。
- 实机 linux.do/tags（1145×765），preview 注入新资源后：
  - `.settings-window` rect `[37, 38, 1072, 689]` → x=(1145-1072)/2、y=(765-689)/2，双轴居中；
  - `.settings-rail` rect `[37, 210, 56, 345]`（≤1279px 时 rail 进入流内、左侧）；
  - 7 个主分类逐个点击：子导航与标题都随分类切换（4/3/4/3/1/3/1 项）；
  - `#settings-scroll` scrollHeight 2676 / clientHeight 687，滚到底部可达且内容无裁切（截图确认）；
  - 关闭：`open=false`、窗口宽 0；重新打开：`open=true`、`y=38`。
- 独立设置页（`http://127.0.0.1:<preview>/__betterld/options`）未被影响：`.settings-window` `[29, 39, 1072, 695]`，仍居中。
- `ignoreAuthor` 标签：在真实浏览器页面读取 `[data-ordered-key="topicCardContextMenuConfig"]` 的 10 行标签，
  第 10 行为「在服务端屏蔽作者」，不再是裸键。
- 环境摩擦：`linux.do` 整页重载会触发 Cloudflare「Just a moment...」，需等 1–3 分钟自愈；
  `scripts/orca-preview.js` 新增 `--page <tab-id>` 以便复用已过质询的标签页，避免新建标签页被挑战。

## 结论

- 交付：`src/content.css` 一条规则、`src/options.js` 一条标签。
- BewlyCat 缺口清单（详见本轮回复与 journal）：
  - A 类（已进设置界面但无运行时效果）：`sidebarCoverBlurEnabled`、`liquidSegmentIndicatorEnabled`、
    `separateNavigationActions`、`enableUndoRefresh`、`searchRecommendationEnabled`、`searchMode`、
    `searchResultsPaginationMode`。
  - B 类（BewlyCat 有、betterLD 没有且可搬到 LinuxDo）：页面内布局切换按钮、卡片标签显隐、
    卡片统计/发布时间细分开关、已读与稍后再看入口、搜索历史展示、版本更新提醒、
    链接打开方式细分取值、站点 Logo 样式。
- 未做回归的部分：>1279px 宽屏布局未实机验证（Orca 视口固定 1145），
  该分支只改窗口尺寸与 rail 定位，居中由同一条 flex 规则承担。
