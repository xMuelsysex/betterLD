# Orca 预览启动脚本与刷新恢复

## 目标与决策

- 目标：将真实 LinuxDo 页面预览、本地源码服务和 Orca 注入流程封装成一个启动脚本；页面刷新后自动重新注入当前源码，保持预览状态。
- 根因：Orca 内置浏览器不能直接挂载未打包的 MV3 扩展；手工 `eval` 注入只存在于当前文档，刷新后页面上下文和注入状态都会销毁。
- 决策：使用 Node 标准库启动禁缓存、CORS 本地静态服务；通过页面现有 CSP nonce 注入 `betterld.config.js`、`src/content.css`、`src/content.js`；轮询目标页面的注入标记，在刷新或整页导航后自动重新注入；预览 storage 使用 LinuxDo `localStorage` 保存，跨刷新保留设置状态。

## 计划

- [x] 新增无依赖 Orca 预览启动脚本并接入 npm 命令。
- [x] 验证静态语法、服务启动、页面注入与刷新恢复。
- [x] 更新项目流水记录。

## 验证记录

- `npm run check`：通过。
- `node --check scripts/orca-preview.js`：通过。
- `npm run preview:orca -- --help`：通过，npm 入口可用。
- `git diff --check`：通过。
- Orca 实测启动 `npm run preview:orca`：真实 LinuxDo 首页注入成功，`cards=30`、`tableHidden=true`、`settingsButton=1`、`material=ready`。
- Orca 实测刷新同一页面：刷新后仍为 `injected=true`、`active=true`、`cards=30`、`tableHidden=true`、`settingsButton=1`。
- Orca 实测设置持久化：通过 mock `chrome.storage.local.set` 写入后刷新，`maskOpacity=0.61`、`blur=23px`、`cardOpacity=0.69` 保持，`persisted=true`。
- Orca 实测整页导航到 `/latest`：自动重新注入，`cards=30`、`grid=1`、`injected=true`。
- 首次页面处于 Cloudflare challenge 时，启动器保持运行并持续重试；页面恢复后自动注入，不再因固定初始超时退出。

## 结论

- `scripts/orca-preview.js` 将本地源码服务、CSP nonce 注入、Orca 页面监控和跨刷新预览 storage 封装为 `npm run preview:orca`；启动器运行期间刷新网页不会丢失 betterLD 预览状态。
