# 设置界面控件全量提交审计

## 目标与决策

- 问题：上一轮发现「壁纸缩略图点击不提交」后，主人追问设置界面其他控件是否也测过。需要对设置窗口里每一类控件做真实页面验证，确认是否都遵守「改动即时生效」。
- 审计方式：先静态枚举 `src/options.js` 里所有会改动设置状态的处理器，判断各自是否落到 `commitSettings()` / `save()`；再用 Orca 真实页面把每类控件都点一遍，对比 `betterld.settings` 是否变化。
- 静态审计结论：设置项本身由三处覆盖——`settingsPageBody` 的委派 `change` 监听（input/textarea/select）、委派 `input` 监听（仅 `input[type="range"]`，220ms 防抖）、以及各控件的自绘处理器。分段控件会派发冒泡 `change`、开关是原生 checkbox，都落在委派路径里；真正漏提交的是自绘控件和结构化编辑器。
- 发现并修复 4 处同族缺陷 + 1 处白名单缺陷：
  1. 规则行「删除」只 `row.remove()`，不提交 → 删除只在 DOM 生效，存储里的规则继续生效。
  2. 选择本地图片后只改内存 state → 本地壁纸从不落盘；且文件 input 的 `change` 会冒泡到委派监听，异步准备完成前先提交一次旧状态（选择失败还会顺带提交）。
  3. 「移除本地图片」只改内存 state 并提示「将在保存后移除」→ 与已取消保存按钮的架构矛盾。
  4. `导入设置` / `导入规则` / `清空搜索历史` 缺少独立确认，违背 `docs/adr/0001-settings-immediate-apply.md` 与 `CONTEXT.md` 的 Immediate Apply 不变量（只有「恢复默认」有确认）。
  5. `validateCustomCss` 遍历 `rule.style` 时拿到的是 CSSOM 展开后的长属性，白名单里的 `margin`、`padding`、`border`、`border-radius`、`background-position`、`overflow`、`text-decoration` 等简写永远匹配不上 → 缩写合法属性会被误拒（实测 `border-radius` 报 `不允许的 CSS 属性：border-top-left-radius`）。
- 决策：所有自绘控件在自身处理器里提交；文件控件从委派监听中排除，由其处理器在异步准备完成后提交；白名单改为按作者书写的声明属性名校验。
- 影响文件：`src/options.js`、`src/settings.js`。

## 计划

1. 静态枚举所有设置变更路径，标出未提交者。
2. Orca 真实页面按控件类型逐项验证提交行为。
3. 修复缺陷并重跑同一矩阵。
4. 回归校验：白名单仍能拒绝非法属性/选择器/at-rule。

## 验证记录

环境：`npm run preview:orca`（Orca 真实 `https://linux.do/latest`，Cloudflare 质询通过后注入）；每个用例读取 `localStorage['__betterld_preview_storage__']` 的原始串对比，另读 `#settings-status` / `#wallpaper-status`。

修复前（同一矩阵，真实页面）：

| 控件 | 用例 | 结果 |
| --- | --- | --- |
| switch | `frostedGlassEnabled` | 已提交 |
| segmented | `topicListLayoutMode` | 已提交 |
| range | `cardMinSize`（220ms 防抖） | 已提交 |
| color | `themeColor` | 已提交 |
| ordered editor | `topicCardContextMenuConfig` | 已提交 |
| 规则编辑器 | 添加 + 填关键词 | 已提交 |
| 规则编辑器 | 点「删除」 | **未提交**（存储仍保留规则） |
| 本地壁纸 | 选择图片 | **未持久化**（`domMode=local`，存储仍 `builtin`） |
| 本地壁纸 | 移除 | **未提交**（`domMode=none`，存储不变） |
| customCss | `.betterld-topic-card { border-radius: 17px }` | **被误拒**：`不允许的 CSS 属性：border-top-left-radius` |

修复后（同一批用例重跑 + 补充）：

| 控件 | 用例 | 结果 |
| --- | --- | --- |
| switch / segmented / range / color | 同上 | 已提交 |
| text | `fontFamily`（依赖 `fontMode=custom`） | 已提交 |
| time | `themeScheduleStart`（依赖 `themeMode=scheduled`） | 已提交 |
| radio + url | 壁纸来源 `url` + `wallpaperUrl` | 已提交（`mode=url`、URL 落盘） |
| 规则编辑器 | 点「删除」 | 已提交（`topicTitleRules` 变化） |
| 本地壁纸 | 选择图片 | 已提交：`mode=local` + `betterld.local-wallpaper` 正文写入（`probe3.png`，1039 字节） |
| 本地壁纸 | 移除 | 已提交：`mode` 变 `none` 且本地壁纸键被删除 |
| customCss | `padding` / `margin` 简写 | 已提交（简写不再被误拒） |
| customCss | `.betterld-topic-card { border-radius: 17px }` | 已提交 |
| customCss | `position: fixed` / at-rule / `body` 选择器 | 仍被拒并给出对应错误（回归通过） |

破坏性操作确认（通过临时覆盖页面 `globalThis.confirm` 分别返回 false/true 验证两个分支；真实原生对话框会阻塞 Orca 自动化桥，无法用 `dialog accept` 收尾）：

| 操作 | confirm(false) | confirm(true) |
| --- | --- | --- |
| 清空搜索历史 | 历史保留 2 条 | 历史清空（0 条） |
| 恢复默认 | 设置不变（`fontFamily` 不变） | 回到默认（`fontFamily=""`、`themeColor=#6750a4`、`wallpaperMode=none`）+ `✓ 已恢复默认设置。` |
| 导入设置 | 设置不变 | `fontFamily=Imported Sans`，`设置已导入，97 个字段生效。` |
| 导入规则 | 规则不变 | 规则被替换，`筛选规则已导入并保存。` |

原生确认对话框确实会出现：真实点击「清空搜索历史」后页面被模态对话框阻塞（`orca eval` 20s 超时、`dialog accept/dismiss` 均无法响应），据此确认对话框已在点击路径上触发。

- 静态检查：`npm run check` 通过；`git diff --check` 通过。

未覆盖：Firefox 真实页面；原生确认对话框的「确定」由用户手动点击的路径未实测（仅验证了分支逻辑与对话框确实弹出）；`同步` 按钮依赖远端同步服务，未测。

## 结论

- `src/options.js`：规则行删除、本地壁纸选择、本地壁纸移除改为显式提交；文件控件排除出委派提交；导入设置、导入规则、清空搜索历史补独立确认。
- `src/settings.js`：自定义 CSS 白名单改按声明属性名校验，简写与长属性不再错配。
- 设置窗口每一类控件现在都在真实页面上验证过「改动即落盘」，破坏性操作的两个分支都已验证。
