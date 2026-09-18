# 剩余界面的 betterLD 改造（用户页二级导航、私信、偏好设置、用户流）

## 目标与决策

主人指令：「改造一下剩下的用户界面」。按会话上下文理解为：把此前只做了壳层（壁纸 + 透明底板）与白底归一、但内容区仍是原生 Discourse 形态的界面，
统一到 betterLD 的 Material 3 语言。范围锁定在：

- 用户页与私信页的两级导航条（`.user-navigation .nav-pills`、`.messages-nav`）。
- 用户流列表项（草稿、活动、通知等 `.user-stream .user-stream-item`）。
- 站点列表表头 `.topic-list-header`。
- 站点默认按钮形态（`.btn-default` / `.btn-primary` / `.btn-danger`，不含 `.btn-flat` / `.btn-transparent` / `.btn-icon` 平铺变体）。

决策：

- 导航胶囊**复用同一套写法**，不新造观感：把主题列表导航的 6 条规则（容器、`li`、`a`、hover、active、focus）选择器组从单一 `#navigation-bar.nav.nav-pills`
  扩为 `:is(#navigation-bar.nav.nav-pills, .user-navigation .nav-pills, .messages-nav)`，无重复声明；`backdrop-filter` 兜底块、`forced-colors` 块与
  减少动效块同步扩同组。主题导航专属的「横向滚动 / 居中对齐 / 触屏」设置规则保持原作用域不变（这些设置文案本就写着只作用于主题导航）。
- 列表表头只改字体与分隔线，**不动列宽盒模型**（`th` 的 padding 保持站点值），避免表格列错位。
- 站点按钮只改背景/描边/圆角/文字色与状态，**不改几何尺寸**，图标按钮（`.btn-icon`）的宽高不受影响。
- 表格行的圆角：`tr.topic-list-item` 是 `display: table-row` + `border-collapse: collapse`，CSS 规范下 `border-radius` 对行不生效（实测计算值 20px 但视觉不圆）。
  试过 `border-collapse: separate; border-spacing: 0 8px` 的运行时探针，行仍是方角且行距被拉大，观感并未变好，因此**不采纳**，表格列表保持「半透明行 + 表头分隔线」的形态。

## 计划

1. 审计剩余页面（私信、草稿、偏好设置、近期活动、关于）的表面与原生控件。
2. 实现导航胶囊复用、表头、用户流行、按钮形态四项。
3. 逐页实机复核 + 白底复扫 + 既有页面（主题页、列表页）回归。

## 验证记录

实机（Orca + 本机 preview service，每次改完重载页面取新资源）：

| 界面 | 改造点 | 计算值/截图 |
| --- | --- | --- |
| `/u/lost_myself/preferences/account` | 两级导航条（总结…偏好设置 / 账户…聊天）、`连接` 主按钮、`删除` 危险按钮、铅笔图标按钮 | 导航条 `rgba(33,31,38,0.82)` + 20px 圆角 + 高 48；胶囊 `16px` 圆角、`on-surface-variant` 文字；按钮 `rgba(33,31,38,0.82)` + 16px 圆角 |
| `/u/lost_myself/messages` | 用户导航条 + 私信导航条（收件箱 / 最新 / 已发送 / 新 / 未读 / 归档 / 机器人聊天）、新消息主按钮、列表表头分隔线 | 截图确认；活动项为主色胶囊 |
| `/u/lost_myself/activity/drafts` | 用户导航条 + 活动二级导航条、用户流条目（`.user-stream-item`）、编辑/删除图标按钮 | 截图确认；条目为 betterLD 材质面 |
| `/t/topic/2913933` | 底部操作按钮（分享 / 添加为书签 / 举报 / 标记为未读 / 指定 / 回复 / 常规）、标签胶囊、建议话题行 | 截图确认：中性按钮为材质面、`回复` 为主色 |
| `/latest` | 主题导航胶囊、类别/标签下拉、卡片网格 | 截图确认无回归 |
| `/about`、`/upcoming-events` | 只读审计 | 无纯白表面（日历是第三方组件，保持原样） |

白底复扫（含 `a/button/summary`，面积 ≥ 800px²）：`/t/topic/*` 0、`/u/lost_myself/messages` 0、`/u/lost_myself/activity/drafts` 0。
偏好设置页在改造后由截图与改造前的 surfacescan 确认无白底，但收尾复扫时 `/my/preferences/account` 与 `/u/lost_myself/preferences/account` 均返回 `/404`
（同一会话下 `/about` 仍为已登录状态，疑为风控/路由瞬时状态），因此该页没有自动化扫描数字。

`npm run check` exit 0、`git diff --check` 通过、CSS 花括号配平 514/514。

## 结论

四个界面（用户页两级导航、私信页、偏好设置、用户流/草稿）与站点按钮、列表表头统一到 betterLD 语言，导航胶囊复用主题列表导航的同一套规则（无重复声明）。
主题页与列表页回归通过，白底复扫为 0。遗留：表格型列表的行圆角（`display: table-row` 下 `border-radius` 不生效）保持现状；偏好设置页的自动化复扫因路由 404 未产出。
