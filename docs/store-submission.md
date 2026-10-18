# betterLD 官方商店发布资料

本文维护商店文案、权限说明和审核材料。正式版本以 `package.json` 为准；上架前从当前源码重新运行既有语法检查与 `npm run package:stores`（Node.js 与 Python 3 标准库，无新增依赖）。商店提交、审核通过和公开上架是不同状态，以下文案准备完成不代表已发布。

## 本轮发布范围

主人确认「如果要付费那就不要了」：停止 Chrome 网上应用店注册及提交，不支付其一次性 5 美元费用；仅继续免费的 Firefox Add-ons 上架。Chrome 本地加载与兼容源码保持。下方 Chrome 表单与 ZIP 资料仅留作参考，不代表本轮提交授权。

## 开发者账号

个人开发者可申请 Chrome 网上应用店与 Firefox Add-ons，无须成立公司。Firefox 账号注册、签名与公开上架免费。账号资料、地区资格、交易者身份、联系方式和其他验证须由发布者真实填写；个人开发者身份本身不能决定欧盟交易者/非交易者身份。

- Chrome：[开发者后台](https://chrome.google.com/webstore/devconsole/)。注册需要一次性注册费，具体金额以账号付款页面为准；发布前启用 Google 两步验证并验证联系邮箱。
- Firefox：[开发者中心](https://addons.mozilla.org/developers/)。使用本人 Mozilla 账号，选择在 AMO 公开列出；上架后由 Mozilla 签名。注册协议、验证码与身份核验由发布者本人完成。
- 支持网站：<https://github.com/xMuelsysex/betterLD/issues>。联系邮箱由发布者本人在账号后台填写，仓库公开资料不用于猜测私人邮箱。
- 许可证：MIT，见根目录 `LICENSE`；导出模块头部保留上游完整 MIT 声明。
- 隐私政策：根目录 `PRIVACY.md`。将其随源码推送到公开仓库并确认匿名可访问后，可使用 `https://github.com/xMuelsysex/betterLD/blob/main/PRIVACY.md`；本地文件存在不等于该 URL 已上线。

## 可直接填写的商店文案

**名称**：betterLD

**简短说明**：美化 LinuxDo 原生列表，提供真实网页预览、树状回复、本机收藏与帖子导出。

**单一用途**：改善 LinuxDo 桌面网页的阅读、内容组织与保存体验。

**详细说明**：

betterLD 是面向 LinuxDo 的独立社区扩展，为桌面网页提供页面美化、树状阅读与内容保存工具。

- 保留原站主题列表、搜索摘要、排序与分页，统一列表外观，可切回原站列表样式。
- 手动打开真实网页预览，在同一窗口继续浏览主题。
- 将主题回复按父子关系组织成可折叠树，保留原站正文、媒体、引用及可用的互动组件；跳楼后围绕目标继续阅读。
- 将稍后再看、收藏、文件夹及私人用户备注保存在本机。
- 按选择的楼层导出 HTML、Markdown 或分享图片；完全离线 HTML 会在资源无法完整保存时明确报错。
- 调整明暗配色、背景与表面效果；默认不加载全局壁纸，可选择内置、随机或自己的图片。
- 管理个人表情库，选择图片后通过 LinuxDo 原站上传并插入草稿。
- 可选浏览器设置同步、用户自选 WebDAV 备份及站内无结果后的 Bing / DuckDuckGo 搜索补充；这些功能默认关闭或仅在用户操作时发送请求。

外部搜索开启后会把搜索词及 `site:linux.do` 发送给所选引擎。WebDAV 只将用户选择的备份及认证信息发送给用户填写的服务。浏览器同步可能包含 WebDAV 地址与用户名，排除密码、本地壁纸数据及搜索历史。远程图片和资源由对应提供商提供。开发者不运营接收用户内容的后端，不包含广告或遥测。

本扩展与 LinuxDo、Mozilla 及 Google 无官方隶属或背书关系。部分内容及互动需要用户已有的 LinuxDo 账号权限；扩展不会提供账号、绕过权限或绕过站点限制。仅支持桌面浏览器；Firefox 要求 140 或更高版本。

**分类建议**：Chrome「工作效率」（按后台实际分类选择）；Firefox「外观」「其他」（按当前可用分类核对）。

## 权限说明

| 商店字段 | 可填写的用途 |
| --- | --- |
| `storage` | 保存设置、本机收藏、搜索历史及私人标记；仅在用户开启后把设置投影交给浏览器同步服务。 |
| `contextMenus` | 在用户右键图片时提供保存到个人表情库和下载图片的入口。 |
| `downloads` | 用户点击下载图片时调用浏览器下载功能；不读取下载历史。 |
| `https://linux.do/*`、`https://www.linux.do/*` | 只在目标站点运行页面增强、预览、树状阅读、站内互动及用户请求的内容导出，遵循已有会话权限。 |
| `https://cdn.ldstatic.com/*`、`https://cdn3.ldstatic.com/*` | 保存用户选中图片及离线导出所需的 LinuxDo CDN 资源。 |
| `https://api.github.com/*` | 仅在用户点击检查更新时读取本项目最新 Release 的版本信息，不下载或运行远程代码。 |
| 可选 `https://*/*` | 支持用户指定的 HTTPS WebDAV 与图片/附件来源，及显式开启的搜索引擎。按精确 origin 申请，不一次授予所有网站。 |
| 可选 `http://127.0.0.1/*`、`http://localhost/*` | 用户可显式配置本机环回 WebDAV 备份地址；不访问任意局域网 HTTP 服务。 |

必需站点权限与可选来源的关系不可在表单中混写为「安装时访问全部网站」。

### Firefox 数据类别

核心站内阅读及互动声明 `websiteContent`、`websiteActivity`、`browsingActivity`、`personalCommunications`。这些类别涵盖 LinuxDo 可见内容及通过原站提交的通信/交互，不能因开发者没有接收服务器就填 `none`。

可选 `searchTerms` 用于外部搜索；`authenticationInfo` 用于 WebDAV 认证及浏览器同步中的 WebDAV 用户名；`technicalAndInteraction` 用于用户显式开启的设置同步。数据授权与网站访问权限分别检查，拒绝或撤销时对应发送失败；相关设置入口仍可见。Firefox 140+ 使用浏览器内置同意界面。

### Chrome 隐私表单

根据实际提交版本逐项填写。重点核对网站内容、用户活动、搜索/浏览相关信息、认证信息，以及帖子/私信等个人通信类别；WebDAV 用户名、筛选规则等还可能含用户提供的可识别信息。表单类别与 Firefox 字段并非一一同名，不能直接复制枚举或勾选「完全不处理数据」。以 `PRIVACY.md` 和源码数据流为依据，提交前逐项回读并确认 Limited Use 声明真实。

## 审核备注（英文，可直接使用）

betterLD enhances the desktop LinuxDo website (https://linux.do/). It is an independent community extension, not an official LinuxDo, Google, or Mozilla product. Some pages and interactions require a LinuxDo account with appropriate site permissions. The extension does not create accounts or bypass login, access controls, rate limits, or challenges. Please contact the publisher if additional reviewer access is needed; personal session cookies and personal account credentials are not included in the package.

All extension JavaScript is included as readable source. There is no bundler, transpilation, minification, runtime dependency, telemetry service, or developer-operated data backend. The development package command only copies files. The packaged page-refresh.js and sticker-composer.js run in the LinuxDo page context and use the site's existing Discourse/Ember components and models. They do not download a third-party JavaScript library. The site itself may render its own embedded media.

The source also contains a localhost-only Orca development preview path. The preview server is under scripts/ and is not shipped in the extension; installed extension resource URLs are generated with runtime.getURL(). No settings UI JavaScript is fetched from a remote service by the installed extension.

External search is disabled by default. Once explicitly enabled and authorized, it sends the current query plus site:linux.do to the selected provider only after LinuxDo topic search has completed with no results. WebDAV backup only contacts the user-configured endpoint on a user action. Browser settings sync is opt-in and excludes the WebDAV password, search history, and local wallpaper data. Please refer to PRIVACY.md for the complete data flow and provider disclosures.

Firefox requires version 140 or later and uses built-in data collection consent. Optional search, authentication, and settings-data permissions are checked before the corresponding transmission. The source ID is betterld@linux.do; please confirm publisher ownership of this ID during first upload. The project license is MIT; the upstream full MIT notice remains at the top of src/topic-export.js.

## 图片与上传文件

- 扩展图标：`src/icons/icon-16.png`、`icon-32.png`、`icon-48.png`、`icon-96.png`、`icon-128.png`。统一从主人另一会话已确认的 `assets/betterld-avatar.png` 蓝色 LD 对话气泡原图缩放，128px 商店图包含四边 16px 透明留白。
- Chrome 必需小宣传图：`docs/store-assets/promo-440x280.png`。沿用同一蓝色 LD 图标，宣传图按 440×280 规格排版。
- Chrome 至少一张**真实当前扩展**截图：1280×800 或 640×400，展示实际界面，不含用户敏感信息。截图须来自真实加载的包，不能用概念图、源码截图或模拟页面替代。Firefox 可复用合适的真实截图。
- 本地加载包继续固定为 `dist/betterLD/`；`npm run package:stores` 先更新该目录，再使用 Python 标准库生成商店要求的 ZIP，固定为 `dist/betterLD-chrome.zip`、`dist/betterLD-firefox.zip`，不使用日期或版本后缀。上传 ZIP 的根直接包含 `manifest.json`，不多套 betterLD 文件夹。
- 两份上传 ZIP 的 JS/CSS 相同；Chrome manifest 只保留 `background.service_worker` 并移除 Firefox 专属键；Firefox manifest 只保留 `background.scripts` 和 Gecko 声明。这是平台清单投影，不产生第二套业务实现，也不改变根清单及固定解压包。
- 可读源码直接随上传包交付，审核要求额外源包时使用同一提交的源码，不上传本机 `.pi/`、配置账户资料或其他私人文件。本次沿用主人指定的 1.0.1，商店准备提交与既有 `v1.0.1` tag 的源码不同；审核溯源使用实际提交的 commit，不移动旧 tag，不以旧 Release 源码代替本次包。扩展「检查更新」只比较数字版本，不会为这些同号调整提示升级。

## 提交前尚需本人或平台完成的步骤

1. 登录开发者后台，完成本人协议、邮箱/身份/地区验证、Chrome 注册付款和两步验证。发布者名称与联系邮箱据实填写。
2. 确认图标与宣传图；从实际加载的包取得可公开的真实截图。账号相关审核需要时，提供专用授权审核账号或与审核团队协调，避免提交个人密码或会话。
3. 把隐私政策发布到可匿名访问的 URL；核对上架范围、免费分发与许可等表单。上架授权不等于授权更改账号安全或付款设置。
4. 上传对应平台 ZIP，修正平台实际返回的校验问题，填写说明与权限；全部必填项就绪后提交审核。保留商店条目 ID、版本、提交状态和审核结果；取得公开链接前不得宣称已上架。

## 官方参考

- [Chrome 注册](https://developer.chrome.com/docs/webstore/register)、[两步验证](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)、[发布](https://developer.chrome.com/docs/webstore/publish)
- [Chrome 图片要求](https://developer.chrome.com/docs/webstore/images)、[隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[用户数据 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Firefox 提交](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)、[数据传输同意](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)、[附加组件政策](https://extensionworkshop.com/documentation/publish/add-on-policies/)
