# 主题卡片作者名错配修复

## 目标与决策

- 目标：修复主题卡片中用户名与真实话题作者对不上的问题，覆盖首页、最新页和分类列表的共同解析路径。
- 根因：`.topic-activity__username` 是最后回复者；当前 `/latest` 的创建者位于 `.topic-creator-data`，原实现把最后回复者误显示为主题作者。
- 决策：在共享作者解析函数修复，不为单个页面或样例增加特例；复用已有话题 JSON 请求，以 `details.created_by.username` 作为唯一 canonical username；DOM 仅使用创建者区域的 `data-user-card` / `aria-label`，缺失时显示通用占位，避免依赖头像或最后回复者。

## 计划

- [x] 读取作者解析与卡片渲染调用链，采集真实 DOM 对照样本。
- [x] 修复共享作者名解析并补充最小静态/真实页面验证。
- [x] 更新验证记录和项目流水，检查最终 diff。

## 验证记录

- `npm run check`：通过，配置、内容脚本和设置脚本均通过 `node --check`。
- `git diff --check`：通过。
- Orca cache-busting `https://linux.do/latest`：前 10 个话题逐项对照 `/t/{id}.json` 的 `details.created_by.username`，10/10 一致。
- Orca cache-busting `https://linux.do/c/develop/4`：前 10 个话题逐项对照，10/10 一致。
- Orca cache-busting `https://linux.do/`：前 10 个话题逐项对照，10/10 一致。
- 关键对照：创建者 `Neo` / 最后回复者 `luckyou` 的话题，卡片最终显示 canonical username `neo`；创建者 `recardo` / 最后回复者 `fengtang` 的话题，卡片最终显示 `Antony_Bricen`。

## 结论

- 主题卡片作者已改为真实创建者 username，不再串用最后回复者；首页、最新页和分类页共享同一修复路径。
