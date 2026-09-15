# Orca 预览设置页打开与读写

## 目标与决策

- 目标：点击真实 LinuxDo 页面上的 betterLD 设置按钮时，在当前网页内显示 BewlyCat 风格的 Material 3 设置面板，不新建设置 Tab。
- 约束：复用现有 `src/options.html`、`src/options.css` 和 `src/options.js`，保持单一表单、配置规范化、storage 语义和即时页面同步，不复制一套设置业务。
- 根因与取舍：页面 CSP 的 `frame-src 'self' blob:` 会阻止 localhost 或 extension iframe；最终采用原生 `<dialog>` 加 Shadow DOM，将现有设置 HTML/CSS/JS 载入页面面板，并用 scoped CSS 隔离原站样式。预览和真实扩展都通过 `runtime.getURL()` 获取 web-accessible 资源；Orca 的 localhost nonce 注入额外桥接 Shadow root 给页面执行的 `options.js`。

## 计划

- [x] 检查现有设置页、共享设置入口和 preview 注入依赖，确定复用边界。
- [x] 在 `src/content.js` / `src/content.css` 增加当前网页内的 Material 3 dialog、遮罩、关闭和焦点恢复。
- [x] 通过 Shadow DOM 载入现有设置表单，并兼容生产扩展与 Orca preview 的 script world。
- [x] 用 cache-busting Orca 真实页面验证打开、保存、关闭、重复打开和页面同步。

## 验证记录

- `npm run check`：通过。
- `node --check src/content.js`、`node --check src/options.js`、`node --check scripts/orca-preview.js`：通过。
- `git diff --check`：通过。
- Orca cache-busting `/latest?betterld_preview=orca-settings-shadow-3`：当前 Tab 内显示 `betterLD 设置` dialog；Shadow DOM 中 `#settings-form` 存在，`iframe=0`，无新增设置 Tab。
- Material 3 视觉取证：dialog 圆角 `28px`、raised shadow `rgba(0, 0, 0, 0.4) 0px 8px 24px 0px`，内层设置卡片圆角 `24px`；截图确认背景遮罩、surface、搜索、分组卡片、radio card、range slider 和滚动区域均正常。
- 交互回归：真实点击保存按钮后 `betterld.settings.maskOpacity=0.63`，当前页面 `--betterld-mask-opacity=0.63`；关闭后焦点回到“打开 betterLD 设置”，再次打开仍加载完整表单。Orca accessibility ref 在页面导航后偶发复用，最终使用新快照和稳定 selector/页面脚本完成核验。

## 结论

- 设置界面已改为当前网页内的 Material 3 面板；现有设置表单和 storage 逻辑保持复用，保存结果即时作用于当前 LinuxDo 页面，生产扩展不再依赖打开独立设置 Tab。
