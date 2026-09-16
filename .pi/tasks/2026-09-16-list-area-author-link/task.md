# 主题列表灰底透明化 + 作者用户名可点击进入用户主页

## 目标与决策

主人核对 `https://linux.do/latest` 真实页面提出两点：

1. 把灰底换成透明材质。
2. 主页的用户名可以点击，点进去是被点击的用户主页。

### 问题 1：灰底

- 真实页面实测：`.betterld-topic-grid` 的祖先链里只有 `#list-area` 带不透明底色
  （`oklch(0.217785 0.0000108703 23.5956)`，约等于深灰），其余 `#ember63`、`#main-outlet`、
  `#main-outlet-wrapper`、`.container.list-container` 都已是 `rgba(0, 0, 0, 0)`。
- 规则来源不在页面可读的 CSSOM 里：Discourse 的样式表挂在 `cdn.ldstatic.com`，跨源读取直接
  `SecurityError`；`document.styleSheets` 里能读的 6 张表（含 betterLD 自己的 433 条）没有一条
  选择器提到 `list-area`。属于站点 `--d-` 设计系统（Horizon 主题）的底色。
- 决策：把 `#list-area` 加入 content.css 已有的「受管页面容器透明化」规则组，与
  `#main-container` / `#main-outlet-wrapper` / `#main-outlet` / `.topic-list-container` 同一处、
  同一作用域，用 `transparent !important` 覆盖站点底色，不做局部半透明材质。
  这样壁纸与遮罩才在该区域可见；卡片自身仍是 0.82 不透明度的材质面，正文可读性由卡片承担。

### 问题 2：作者用户名可点击

- 现状：`.betterld-topic-card__author` 是纯 `<span>` 文本，仅用于展示与作者轴过滤。
  菜单里已有「打开作者主页」动作，其 `card.dataset.authorHref` 取自 DOM 的创建者链接。
- 决策：作者元素改为真正的 `<a>`，href 由**权威用户名**拼出 `${location.origin}${config.userProfilePath}${username}`，
  新增 `userProfilePath: "/u/"` 到 `betterld.config.js`（与 `homepagePath` 同层，避免硬编码）。
- 只对「真实用户名」建链：`userProfileHref()` 用 `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` 判定，
  加载中/失败占位文案（`作者信息加载中…`、`作者信息暂不可用`）与可能的显示名（含空格或非 ASCII）
  一律不写 href，元素退化为普通 `<a>`（无 href 即非链接）。失败方向是「不建链」，不会指向错误用户。
- 整张卡片仍然是原帖链接（CONTEXT.md「Card Navigation」不变量：右键 / Ctrl 点击 / 键盘新标签页），
  因此 cards 模式下作者链接位于卡片级 `<a>` 之内。为避免 `handleTopicCardClick` 在
  newTab / background / drawer 三种打开模式下劫持这次点击，作者链接在 click 上
  `stopPropagation()`（不 `preventDefault`），保留浏览器原生导航与右键菜单；
  这与菜单触发器已有的 `stopPropagation` 是同一套做法。
- 不扩大范围：头像、分类 chip、正文预览都不加链接；不做自动跳转。

### 影响文件

- `src/content.css`（`#list-area` 透明 + 作者链接触觉与焦点样式）
- `src/content.js`（`userProfileHref` / `applyAuthorIdentity`，作者元素改 `<a>`）
- `betterld.config.js`（`userProfilePath`）
- `CONTEXT.md`（Author Identity / Visual Enhancement 不变量补充）

## 计划

1. 改动前用 Orca 真实页面记录 `#list-area` 底色与卡片作者元素形态。
2. 落源码改动。
3. 真实页面复核：
   - 宿主变体：`/`、`/latest`、`/c/*`、`/tags`、`/tag/*` 下 `#list-area` 计算值；
   - 卡片模式变体：reading 与 cards 两种 `topicListLayoutMode` 下作者链接的存在性、href 正确性；
   - 行为：点击作者链接后 `location.pathname` 变为 `/u/<username>`；`drawer` 模式（最容易被劫持的模式）
     下点击作者链接仍是导航到用户主页而不是打开抽屉；打开态作者链接可点击但卡片其他区域仍进主题。
4. `npm run check` 语法检查。

## 验证记录

环境：`npm run preview:orca -- https://linux.do/latest`（Orca 真实站点 + 本机 preview 注入），
page `73778e2e-dc26-4977-8893-8e33e7f1abd5`。

改动前：

- 网格祖先链（grid → body）逐层 `backgroundColor`：只有 `div#list-area` 为
  `oklch(0.217785 0.0000108703 23.5956)`，宽 1824 高 2107；`#ember63` 起全部 `rgba(0, 0, 0, 0)`，
  `body` 为 `rgb(20, 18, 24)`。
- 页面级「大块不透明底色」扫描（面积 ≥ 200×80）：仅 `#list-area`、translucent 的
  `nav#d-sidebar` / `div.list-controls`、以及 betterLD 自己的 `__excerpt` 面，无第二个灰色底板。
- 作者元素：`span.betterld-topic-card__author`，无 href。
- 页面结构与主人附上的浏览器上下文一致：卡片网格是 `table.topic-list.--d-topic-cards` 的兄弟节点，
  同挂在 `div#ember63` 下；源表 `data-betterld-was-hidden="false"`，其 `tbody` 被隐藏。
- 站点灰色 token `oklch(0.217785 0.0000108703 23.5956)` 的完整可见实例（全元素扫描，非抽样）：
  `/latest` 只有 `#list-area`；`/c/develop/4` 还有 `#header-list-area` 与 3 个 `.category-box-inner`；
  `/` 还有 `.list-controls`（导航胶囊的灰色底板）与欢迎横幅的搜索框；其余匹配项都是隐藏源表的 0×0 行。

改动后（每次源码改动后重新加载页面，preview 注入自带 cache-bust）：

| 页面 | body class | `#list-area` | `#header-list-area` | 卡片 / 作者链接 | 剩余可见灰底 |
| --- | --- | --- | --- | --- | --- |
| `/` | `betterld-home` | `rgba(0,0,0,0)` | `rgba(0,0,0,0)`（h0） | 30 / 30 | 欢迎横幅搜索框、`.list-controls` |
| `/latest` | `betterld-topic-page` | `rgba(0,0,0,0)` | `rgba(0,0,0,0)`（h0） | 30 / 30 | 欢迎横幅搜索框 |
| `/new` | `betterld-topic-page` | — | — | 30 / 30 | 欢迎横幅搜索框 |
| `/c/develop/4` | `betterld-topic-page` | `rgba(0,0,0,0)` | `rgba(0,0,0,0)`（h201） | 30 / 30 | 无 |
| `/tag/31-tag/31`（`/tag/公告` 跳转后） | `betterld-topic-page` | — | — | 30 / 30 | 无 |
| `/tags` | `betterld-categories-page`,`betterld-tags-page` | 不存在 | 不存在 | 0 / 0 | 无 |

- 分类盒子改为材质面后：`.category-box` 背景 `rgba(28, 27, 32, 0.56)`（与 `.category-heading` 一致）、
  `border-radius: 24px`、`.category-box-inner` 变 `rgba(0,0,0,0)`；盒内 `h3` `rgb(255,255,255)`、说明文字
  `rgb(230, 225, 229)`，文案与指向 `/c/develop/develop-lv1/20` 等链接完好。
- 作者链接：30 张卡片 `data-author-state="ready"` 与 `[href]` 都是 30/30，href 形如 `https://linux.do/u/neo`；
  加载中/失败占位的卡片不会生成 href（判定在 `userProfileHref` 一处）。
- 真实鼠标点击（`orca mouse move/down/up` 到元素中心，非合成事件）：
  - reading 模式、`topicCardOpenMode=currentTab`：点作者落在 `/u/neo`，随后浏览器跳 `/u/neo/summary`（用户主页）。
  - cards 模式（作者链接嵌在卡片级 `<a>` 内，`a.parentElement.closest("a[href]")` = `.betterld-topic-card__link`）：
    `currentTab` 下 `orca click` 点作者同样落在 `/u/neo` —— 内层链接获胜，外层卡片链接没有抢走导航。
  - cards 模式、`topicCardOpenMode=drawer`（最容易被劫持的模式）：点作者仍落在 `/u/neo`，抽屉未打开。
  - 对照组：同一模式下点卡片本体（标题链接）仍打开抽屉（`drawerTitle="《秘密花园园丁邀请函》"`、`drawerAuthor="neo"`），
    整张卡片的原帖链接行为未被破坏。
  - 占位态对照（同一坐标 `428,494`、cards + drawer）：把某个作者元素的 `href` 去掉（模拟加载中/失败占位）后，
    同一坐标点击改为打开抽屉而不再拦断——说明 `stopPropagation()` 只对有 href 的作者链接生效，占位文本不会变成死区。
- 静态检查：`npm run check` 通过；`git diff --check` 通过。

## 结论

- `src/content.css`：`#list-area`、`#header-list-area` 加入既有的受管页面容器透明化规则组；
  分类盒子改用与 `.category-heading` 相同的 betterLD 材质面，去掉内层站点灰底；作者链接补 hover / focus-visible / 去下划线。
- `src/content.js`：新增 `userProfileHref()` 与 `applyAuthorIdentity()`，作者元素改为 `<a>`，
  href 只由真实用户名生成，并在 click 上 `stopPropagation()` 避免被卡片打开方式劫持。
- `betterld.config.js`：新增 `userProfilePath: "/u/"`。
- 真实页面复核覆盖 `/`、`/latest`、`/new`、`/c/*`、`/tag/*`、`/tags` 六类宿主，reading 与 cards 两种卡片模式，
  以及 currentTab / drawer 两种打开方式。
- 有意不覆盖（同色但不同语义，等主人决定）：首页 `.list-controls`（导航胶囊的灰色底板，改它会把该规则组的宽度/内边距
  一起带到首页，属于布局变更）与欢迎横幅里的搜索输入框（表单控件需要自带的填充底，不是页面底板）。
