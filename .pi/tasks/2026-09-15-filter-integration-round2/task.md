# 七项能力集成：服务端屏蔽、等级/旧帖过滤、高亮、垃圾桶、WebDAV、远程规则

## 目标与决策

- 主人从上一轮调研的备选清单里点名 7 项：① 调用 Discourse API 的服务端 ignore（setIgnoreUser）；② 旧帖按天数过滤；③ 等级过滤；④ 命中项高亮；⑤ 过滤结果垃圾桶可还原；⑥ WebDAV 同步规则；⑦ 远程规则 URL。
- 决策一（服务端 ignore 的接口）：不靠猜——拉取已验证可用的社区脚本源码（GreasyFork #589525）确认真实调用：`PUT /u/{username}/notification_level.json`，`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`，请求头 `X-CSRF-Token` 取自 `meta[name="csrf-token"]`，body 为 `notification_level=ignore` + `expiring_at` + `acting_user_id`（uid 取自 `Discourse.User.current().id`）。参数落在 `betterld.config.js` 的 `discourseIgnoreExpiringAt`。
- 决策二（入口与安全）：服务端屏蔽只在卡片右键菜单里作为显式动作提供，默认不在菜单里显示（需在「组件 › 交互」里打开），执行前有原生确认，提示会写入账号；不做任何自动批量屏蔽。
- 决策三（旧帖天数）：时间戳不解析页面上本地化的相对时间文本，改用已有的 `/t/{id}.json` 元数据（`last_posted_at → bumped_at → created_at`），随作者请求一起拿到，卡片写入 `data-filter-activity`；元数据未到位时按 `pending` 处理，不提前隐藏。
- 决策四（等级）：等级取自行内分类 slug 的 `-lvN` 类名，缺失时回退到分类名 `, LvN` 后缀；无等级分类为 0，不受影响。用三个开关（Lv1/Lv2/Lv3）而不是多选控件，复用现有 toggle 控件类型。
- 决策五（高亮）：作为 `topicFilterMode` 的第四个值 `highlight`，命中项保持可见、标题内命中词包 `<mark>`，标签/分类规则命中时给对应 chip 打 `data-filter-hit`。
- 决策六（垃圾桶）：命中项仍然生成卡片但隐藏，右下角出现「已过滤 N」浮层，可单条还原与全部还原；还原是页面级覆盖（`data-filter-override`），并且**规则集变化时自动清除覆盖**，否则用户点过「全部还原」之后过滤器会静默失效。关闭垃圾桶时恢复原来的性能优化（命中项在构建阶段就不再生成卡片）。
- 决策七（WebDAV）：请求不能从 content script 直发（跨域受页面 CORS 约束），因此统一走后台 service worker；新增 `src/webdav.js`（地址白名单 + Basic 认证 + GET/PUT）由 `importScripts` 载入，manifest 增加 `optional_host_permissions`，首次使用按 origin 申请权限。地址策略与设置页一致：只接受 https，http 仅允许环回地址。
- 决策八（凭据边界）：`webdavPassword` 不进入 `storage.sync` 投影、不进入设置导出文件；导出提示显式写明「不含 WebDAV 密码」。
- 决策九（远程规则 URL）：本轮不做。它与 WebDAV 覆盖同一需求（外部规则来源），但需要额外处理「远程地址可信度、拉取频率、失败回退」三件事，先由主人确认取舍再单独一轮实现。
- 影响文件：`betterld.config.js`、`src/settings.js`、`src/content.js`、`src/content.css`、`src/options.js`、`src/options.html`、`src/background.js`、`src/webdav.js`（新增）、`manifest.json`、`package.json`。

## 计划

1. 取事实：服务端 ignore 的真实接口与页面时间/等级来源。
2. 配置与设置模型：新键、枚举、限值、单一规则组来源。
3. content.js：等级/旧帖判定、高亮、垃圾桶、服务端屏蔽动作。
4. 样式、设置界面字段、WebDAV 传输层与后台消息。
5. 真实页面逐项验证 + 传输层本地回环验证。

## 验证记录

环境：`npm run preview:orca`（Orca 真实 linux.do）；设置通过预览 storage 桥驱动，走真实存储 → content.js 链路。因 Orca 窗口被遮挡，rAF 被节流到约 2.5fps，验证脚本统一改为轮询等待条件成立，并记录等待毫秒。

- **等级过滤**（`/new`，30 张卡，等级分布 0×21 / 1×8 / 2×1）：隐藏 Lv1 → 隐藏 8、不符预期 0；隐藏 Lv2 → 隐藏 1、不符预期 0。
- **旧帖天数**（`/top?period=all`，41 张卡，全部拿到活动时间，最旧 189 天）：关闭时为 0 隐藏；`maxAgeDays=30` → 隐藏 11，与「活动时间早于 30 天」的卡数完全一致，不符预期 0；复位后 0 隐藏。
- **命中项高亮**：标题规则 `AI` → 1 张命中卡进入 `highlight` 状态、该卡标题内 1 个 `<mark>`，其余卡 0 个 `<mark>`（`也许我们都已经是AI时代的新职业了`）；标签规则 `人工智能` → 7 个标签 chip 打上 `data-filter-hit="true"`。
- **垃圾桶**：标签规则命中 9 张 → 浮层出现、计数 `9`、条目 9；展开面板 `data-open="true"`；单条还原后隐藏数 9→8、计数同步为 8、该卡 `data-filter-override="visible"`；「全部还原」后隐藏 0、浮层移除（等待 899ms）；再把垃圾桶关掉并重新过滤 → 隐藏 9 且无浮层，证明规则集变化会清掉上一轮的还原覆盖。
- **服务端屏蔽**：把菜单项打开后，卡片菜单出现「在服务端屏蔽作者」；作者未加载时点击提示「作者尚未加载完成，暂时无法屏蔽」；把卡片作者临时改成不存在的用户名后点击（CSRF 与 uid 均正常读取、请求真实发出）→ 状态提示 `服务端屏蔽失败（HTTP 404）`。**未做**对真实用户执行 200 成功的屏蔽，避免改动主人账号状态。
- **WebDAV 传输层**（Node 直接加载 `src/webdav.js`，对本机回环 WebDAV 替身服务器）：PUT 上传成功、GET 下载内容与上传字节一致、Basic 认证头正确、错误密码 401 转为明确错误、公网 http 地址被拒、非 GET/PUT 方法被拒。
- **WebDAV 设置界面**（Orca 真实页面设置窗口）：三项字段渲染（密码为 `type=password`）、上传/下载按钮存在；公网 http 地址保存被拒并提示「WebDAV 地址无效：只接受 https:// 地址，http:// 仅允许本机地址」，原已保存的本机地址保持不变；本机回环地址可保存；预览环境点击上传给出「当前环境不支持权限申请…」——预览桥没有 `chrome.permissions`，属预期边界。
- **凭据边界**：设置导出经拦截 `URL.createObjectURL` 抓取真实导出内容，`probe-secret-value` 未出现、用户名与地址保留，提示为「设置已导出（5458 字节，107 个字段，不含 WebDAV 密码）」。
- **筛选面板字段**：`topicFilterEnabled / Mode / MatchMode / MaxAgeDays / HideLv1..3 / BinEnabled` 全部渲染，时间滑杆 min 0 / max 3650 / step 1，命中行为四个选项（隐藏 / 淡化 / 高亮 / 只显示）。
- 静态检查：`npm run check`（已把 `src/webdav.js`、`src/background.js` 纳入）通过；`git diff --check` 通过。

未覆盖：①服务端屏蔽的成功路径（会对主人账号产生真实副作用，留给主人自行验证一次即可看到效果）；②扩展后台 + 权限申请的真实链路（Orca 内置浏览器无法加载未打包 MV3 扩展），仅验证了传输层逻辑与预览环境下的错误分支；③Firefox 真实页面；④远程规则 URL（本轮按决策九不做）。

## 结论

- 六项已落地并通过真实页面验证：服务端屏蔽动作、等级过滤、旧帖天数过滤、命中项高亮、可还原的过滤垃圾桶、WebDAV 规则备份；远程规则 URL 明确留待下一轮。
- 关键不变量：服务端屏蔽只作显式动作；时间戳取权威 JSON 而非本地化文案；垃圾桶覆盖只对当前规则集有效；WebDAV 密码不出本地。
