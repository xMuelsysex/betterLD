# 壁纸背景覆盖全部页面

## 目标与决策

主人反馈：背景图片不能只覆盖主页，别的界面也要有。

现状（`src/content.css`）：背景壁纸 + 页面遮罩 + Header/Sidebar 透明这套「壳层视觉」被复刻了三份，
分别挂在三套页面类上：

1. `body:is(.betterld-home, .betterld-topic-page, .betterld-categories-page)` —— 首页、话题列表页（含 `/latest`、`/new`、`/hot`、`/top`、`/c/*`、`/tag/*`）、`/categories`、`/tags`。
2. `body.betterld-unmanaged-page` —— 由设置项 `applyToUnmanagedPages`（默认关）驱动，只覆盖静态/工具页，且显式排除了 `/t/...`、`/u/...`、`/messages`、`/admin`、`/session`。
3. `body.betterld-search-page` —— `/search`。

因此实际没有壁纸的页面是：**主题详情页 `/t/{slug}/{id}`、用户页 `/u/*`、`/badges` 等未列举页面**。
其中最常访问的主题详情页在任何设置下都没有壁纸——这是主人反馈的真实缺口。

决策：

- 壳层视觉的作用域从「逐个页面类枚举」收敛为单一类 **`betterld-shell`**，在 `updateRouteState()` 里无条件挂到 `document.body`（content script 只在 linux.do 运行）。
- 三份重复的壳层 CSS 合并成一份 `body.betterld-shell`；页面级类（`betterld-home` / `-topic-page` / `-categories-page` / `-tags-page` / `-search-page`）继续保留，只用于列表卡片、导航胶囊、分类盒子等页面级能力。
- 设置项 `applyToUnmanagedPages` 在壳层视觉全站默认生效后不再有任何独立行为，随 `betterld-unmanaged-page` 一起删除。
- 字体作用范围设置 `fontScope: "managed"`（「已管理页面正文」）语义未变，仍挂在原来的三个页面类上，不随壳层扩大。
- 页面级底板按与列表页既有做法一致的方向处理：路由层容器透明化，站点自有组件（卡片、tag 面板、搜索框）保留自己的表面；用户页正文底板改用与 `.category-heading` 同一套 betterLD 半透明材质面，避免密集小字直接压在壁纸上。

## 计划

1. recon：用 Orca preview 打开真实 `/categories`、`/t/*`、`/u/*`，确认壳层缺口与不透明容器。
2. `src/content.js`：新增 `betterld-shell`，移除 `isUnmanagedShellPage()` 与两处 `betterld-unmanaged-page` 开关。
3. `src/content.css`：218 处 `body:is(.betterld-home, .betterld-topic-page, .betterld-categories-page)` → `body.betterld-shell`；合并/删除 `.betterld-unmanaged-page`、`.betterld-search-page` 两份重复壳层；补齐非列表页所需的分层与容器透明化。
4. 删除 `applyToUnmanagedPages`：`betterld.config.js` 默认值与分组 keys、`src/settings.js` 布尔白名单、`src/options.js` 控件与英文标签。
5. 验证：`npm run check`、`git diff --check`、Orca 真实页面逐页检查。

## 验证记录

代码层：

- `npm run check` 通过；`git diff --check` 通过；`src/content.css` 花括号配平 490/490。
- 全仓搜索 `applyToUnmanagedPages` / `betterld-unmanaged-page` / `unmanaged` 无残留。
- 设置窗口 Shadow DOM（155 KB innerHTML）内不再出现 `unmanaged`；设置项读取到 80 个 `data-setting-key`，`页面行为` 组只剩 `touchOptimization`、`enableHorizontalNavigationScroll`、`showHomeButtonInTouchMode`。
- 过期存储值不需要迁移：`normalizeSettings()` 从 defaults 重建对象，未知键自动丢弃。

Orca 真实 linux.do 实机（本机 preview service 注入当前源码，每次改完重载页面取新资源）：

| 页面 | 壳层类 | `::before` | 壁纸变量 | 结果 |
| --- | --- | --- | --- | --- |
| `/t/topic/847468/498` | ✅ | `block` / `fixed` / z0 | ✅ | 帖子直接落在壁纸上，页面内无大于 2 万 px² 的不透明底板（只剩一个 blockquote） |
| `/latest` | ✅ | `block` | ✅ | 30 张卡片、导航胶囊、刷新提示条正常；卡片操作菜单打开后 190×392、10 项、z-index 40，未被裁切 |
| `/u/stellafortuna/summary` | ✅ | `block` | ✅ | `.user-main` 材质面 `rgba(255,251,254,0.56)` + `blur(16px)` + 圆角 24px + 阴影，正文可读 |
| `/categories` | ✅ | `block` | ✅ | 分类盒子仍是 betterLD 材质面，无回归 |
| `/tags` | ✅ | `block` | ✅ | 壁纸在 tag 面板外可见，文字正常 |
| `/search` | ✅ | `block` | ✅ | 搜索面板保留自身表面，下方空白区显示壁纸 |
| `/badges` | ✅ | `block` | ✅ | `.container.badges` 透明化后徽章卡片改为壁纸上的白卡，与 `/tags` 一致 |

- 容器透明化最终形态：`#main-container`、`#main-outlet-wrapper`、`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`、`.topic-list-container` 统一 `position: relative; z-index: 1; background: transparent`。
- 设置窗口（页面内 Shadow DOM dialog）在 `/u/` 页打开正常，完整渲染 90% 尺寸大窗口与分类导航。
- 已知环境摩擦：验证期间多次整页导航会被 Cloudflare 拦成「请稍候…」，等约 40–60 秒自动放行；不是插件问题。
- 未实测：Firefox（Orca 只能跑 Chromium）；`/admin`、`/messages`、发帖编辑器页面未逐一走查（壳层规则对所有页面统一，风险集中在站点自身的编辑器/管理面板表面）。

## 结论

壁纸、遮罩与 Header/Sidebar 壳层视觉现在由单一 `betterld-shell` 类驱动，在 linux.do 的所有页面生效；
主题详情页、用户页、`/badges` 等此前完全没有壁纸的页面已实测覆盖，列表页、分类页、标签页、搜索页与卡片菜单无回归。
`applyToUnmanagedPages` 设置项与其 CSS/JS 分支一并删除，设置界面不再出现该开关。
