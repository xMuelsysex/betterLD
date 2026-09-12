# 修复主题作者信息在 CF/API 失败后的占位

## 目标与决策

- 目标：修复真实首页中部分主题作者显示为错误活动用户或长期停留在 `LinuxDo 用户` 的问题。
- 根因：主题行的 `.topic-activity__username` 是最后回复者；话题 JSON 请求在 CF 挑战期间失败后被永久缓存为 failed，卡片不会再次取得 `details.created_by.username`。
- 决策：创建者只认 `/t/{id}.json` 的 `details.created_by.username`；DOM 不使用头像 title 或最后回复者；JSON 请求采用有限重试，失败状态可在后续重新触发，避免瞬时 CF/API 失败固化错误占位。

## 计划

- [x] 收紧作者回退逻辑，移除 `post.username` 和最后回复者路径。
- [x] 为话题 JSON 请求增加有限重试，并让失败卡片可再次加载作者信息。
- [x] 通过真实首页抽样对照 JSON，运行静态检查并更新项目记录。

## 验证记录

- `npm run check`：通过。
- `git diff --check`、`node --check src/content.js`、`node --check betterld.config.js`：通过。
- 真实首页经 CF 刷新后重新注入当前源码，30 张当前卡片中首屏可见的 16 张均为 ready；逐项请求对应 `/t/{id}.json`，`details.created_by.username` 与卡片作者 `16/16` 一致，无 `LinuxDo 用户` 或最后回复者占位。
- 真实 DOM 抽查确认创建者区域只有头像 `title`，最后回复者在 `.topic-activity__username`；当前解析不使用两者作为 username。
- JSON 请求失败会按 `topicRequestRetryCount=2`、`topicRequestRetryDelayMs=1500` 有限重试；最终失败显示 `作者信息暂不可用`，不显示伪用户名。

## 结论

- 主题卡片作者只接受 `/t/{id}.json` 的 `details.created_by.username`；CF/API 瞬时失败不会永久固化错误作者，页面恢复后可自动重试并回写真实创建者。
