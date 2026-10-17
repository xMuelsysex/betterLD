# betterLD 实际功能、接口与架构审计

审计基线：`main / e3b5036`，版本 `0.2.5`。范围：根配置、Manifest、全部 `src/` 模块和两个开发脚本。第 1–10 节保留该基线的审计证据与发现；2026-10-17 获授权的行为等价收敛及现行接口差异见第 11 节。基线中的旧接口/行号用于溯源，不代表收敛后仍存在；产品模式与版本保持不变。

**结论：当前首要问题是数据与动作的归属分散，其次才是文件大小。** 原站模型与内容脚本维护帖子双份投影，部分动作穿过主世界后又回到内容脚本请求，再送回主世界写模型；原本可以直接使用 ID 的挂载接口仍传整份帖子。应先缩短这些真实调用链，再按职责整理文件，避免把一个大控制器机械拆成更多转发层。

## 1. 第一性原理：一个能力，一个负责实现的地方

采用以下审计尺度；实施授权沿用主人当前明确范围：

- 一个功能有一个业务实现；首页、搜索、预览、工具栏等多个入口调用它，不各自实现一遍。
- 一个数据对象有一个权威所有者。跨执行世界只传消费端真正需要的投影，动作尽量只传主题 ID、帖子 ID、操作参数，完成结果沿同一更新路径返回。
- 两步能完成的业务保留两步；只有跨浏览器 API、权限、执行世界、持久化或原站组件生命周期这类真实边界才增加适配。拒绝为文件对称而增加 controller → service → repository → adapter 转发链。
- 同一内容材质在一处实现，不按页面复制。用户主动选择的树/原帖、离线/远程、HTML/Markdown/PNG有不同使用语义，不能以“重复样式”为由直接删掉。主人要求“保证功能和现有的均不变”时，等价选项也保留入口、枚举和既有设置，内部共用实现即可；删除选项或迁移设置需另获授权。
- 未拿到数据、权限失败、网络错误要有明确结果；不增加备用实现、默认成功或自动换通道。存储数据校验、主题身份核对、组件释放仍是功能正确性的一部分。

`CONTEXT.md` 继续负责产品语义；本文记录源码接口、审计证据和建议，不建立第二份默认参数或产品契约。文中“确定”表示源码直接可证，“风险”表示静态因果推断；本轮没有性能采样，因此不声称测得卡顿、泄漏或具体耗时收益。

## 2. 实际运行边界

```text
扩展设置页 / 工具栏弹窗 ── options.html + options.js（同一实现）
              │ storage / runtime 消息
              ▼
后台 background.js ── 浏览器权限、外网下载、串行本机数据写入、IndexedDB
              ▲
              │ runtime 消息
页面隔离世界 content.js + 功能模块 ── 插件 DOM、设置应用、读段、几何
              │ JSON 字符串 CustomEvent（Discourse 对象不能直接跨世界）
              ▼
页面主世界 page-refresh.js ── 原站模型、组件、阅读登记、时间轴、原站动作
              └─ sticker-composer.js ── 原站编辑器 / 上传器
```

| 文件/入口 | 实际职责与边界 |
| --- | --- |
| `manifest.json:20-77` | Chrome service worker 与 Firefox background scripts；站点内容脚本按序加载。`all_frames=true`，但 `content.js:4-7` 只接管顶层和插件标记的同站预览，其他模块各有自身入口约束 |
| `betterld.config.js` | 唯一运行参数、默认设置、枚举、分类、权限来源和容量限制；不是数据访问层 |
| `src/content.js` | 7562 行：页面壳层、列表/搜索、过滤、导航、预览、请求队列、树的读段/动作/几何、导出取数、用户标记桥接和全页调度集中在一个 IIFE |
| `src/page-refresh.js` | 1676 行：原站模型投影、identityMap 登记、原生正文/菜单/解决方案宿主、时间轴、阅读、筛选与原站动作；没有独立扩展 runtime API |
| `src/options.html` / `.js` / `.css` | 扩展设置页和弹窗共用；页面内设置再加载同一 HTML/CSS/脚本到 Shadow DOM（`content.js:1402-1436`），属于多入口单实现。注入契约为临时 `globalThis.BETTERLD_OPTIONS_ROOT=ShadowRoot`（`content.js:1425-1434`），options `5` 消费后按同一 UI 实现挂载 |
| `src/topic-library.js` / `src/topic-library.css` | 本机稍后再看/收藏面板与页面按钮；不负责直接持久化业务写入 |
| `src/library-entry.js` / `library-store.js` / `user-marks.js` | 条目身份规则、收藏数据操作、私人标记数据操作；具体公共接口见后文 |
| `src/topic-export.js` / `src/topic-export.css` | 导出对话框、范围解析、HTML/Markdown 转换与离线归档编排；原站取数由注入回调提供 |
| `src/offline-assets.js` / `share-image.js` | 离线 URL/资源规则；PNG 排版和分页生成。两者是不同结果语义，不是两套相同渲染器 |
| `src/media.js` | 视频自动播放控制与静态头像的页面 DOM 生命周期 |
| `src/sticker-library.js` / `src/sticker-library.css` | 表情库面板、导入/导出与选择；`sticker-composer.js` 主世界接原站上传器，store/db/zip 各管数据规则、持久化和文件格式 |
| `src/background.js` | 942 行：消息路由、权限、下载/外部请求、右键菜单及收藏/标记/表情写入调度 |
| `src/webdav.js` / `external-search.js` | WebDAV URL/认证及请求封装；搜索引擎 URL/HTML 结果解析（后台只请求 HTML，隔离世界负责 DOM 解析） |
| `src/settings.js` | 设置规范化、校验、同步/导出投影与交互配置规则 |
| `src/markdown.js` | 老 Markdown 渲染器。仍随内容脚本加载并被初始化检查依赖；实际调用问题见发现 A1 |
| `scripts/package.js:8-13` | 把 manifest/config/src 拷贝进固定 `dist/betterLD/`，无编译；包是生成物，不是第二实现 |
| `scripts/orca-preview.js:22-39,108-112` | 开发预览 HTTP/CLI 与独立存储模拟；不在扩展包内。CLI 命令用环境变量、端口/轮询等局部常量，是开发工具与根参数规则的一个例外现状，不能把其模拟运行当实际扩展已加载 |

### 必要边界与当前摆放问题

- **保留隔离世界 ↔ 主世界。** 内容脚本读不到 Discourse 模块/服务；原生 `PostCookedHtml`、`PostMenu`、阅读登记必须在主世界。消减载荷和往返，而非取消边界。
- **保留 UI ↔ 后台。** 可选域名权限、跨域资源、右键菜单和跨标签写入串行化属于后台能力；直接让每个页面各写一套会损害一致性。
- **调整数据所有权。** 树的关系、读段、收放和几何属于 UI；原站 Post、权限、回应/Boost/解决方案属于主世界。当前同一帖子在两侧均被读取、合并、再次投影，是最值得收敛的部分。
- **收紧文件职责。** `content.js` 同时知道 PNG/HTML 导出取数细节、用户卡标记、主题行和原站动作，`page-refresh.js` 的文件名也掩盖了其主要原站集成职责。重命名/拆分只作为数据流收敛后的整理，不单独计作架构优化。

## 3. 用户功能到实际实现

以下每行代表能力边界，不把每个按钮或设置取值再包装成服务接口。配置细项仍查 `betterld.config.js:418-840`。

| 功能/实际入口 | 负责实现的符号/路径 | 数据来源与复用判断 |
| --- | --- | --- |
| 全站明暗、主题色、字体、遮罩、模糊、阴影与自定义 CSS | `content.js:350 applyVisualSettings`、`applyColorMode`、`applyCustomCss`；`content.css` | 规范化设置 → CSS token/data 属性；全站壳层一套规则 |
| 随机/内置/远程/本地壁纸及搜索页壁纸覆盖 | `content.js:283 resolveWallpaper`；options 壁纸上传 | 同一设置应用链；来源分支不是多套 UI 材质，失败渐变是既有显式产品行为 |
| Header、Sidebar、Logo、触摸入口、浮动工具、快捷键 | content 的 `applyChromeSettings`、`syncFloatingActions`、`handleShortcut` 等 | 只做页面壳层与插件工具；设置和快捷键复用同一刷新/打开设置动作 |
| 首页、最新、分类、标签、原站已读及帖底推荐/相关列表增强 | `content.js:3491 enhanceTopicRow`、`3540 syncNativeTopicLists` | 原生行 + 同一 `ensureTopicInfo`、菜单、筛选和材质；不是独立列表渲染器 |
| 原站搜索条目增强 | `content.js:3561 enhanceSearchResult`、`3616 syncNativeSearchResults` | 共用信息栏/材质；作者和日期代表命中帖，保留原站摘要/高亮。来源适配应保留，表现重复应合并 |
| 列表原样/美化切换 | `content.js:3518 restoreOriginalTopicLists`、`3547 syncHomepage` | 原样是撤下增强，不是第二套自绘样式 |
| 列表统计/已看/作者元信息 | `content.js:2581 topicListEntries`、`2789 syncTopicListMetadata`；`page-refresh.js:1538 currentTopicListPayload` | 只读预载/原站模型，不发逐主题补读；模型先包装成 API 形状再映射，见 A3 |
| 最新活动/发布时间排序 | `applyTopicSort`；根配置 `topicSortOrders` | 改原站 URL 查询参数，不在前端重排结果 |
| 标题/作者/分类/标签/白名单、等级、旧帖过滤与垃圾桶还原 | `content.js:2940 filterRuleMatches`、`3132 applyCardFilter`、`3179 syncFilterEmptyState` | 同一规则解释器，列表显示层生效；不是另做站点查询 |
| 主题菜单、打开方式、导航/通知打开方式、复制与账号忽略 | `renderCardMenuActions`、`handleTopicCardClick`、`syncConfiguredLinkModes`、`content.js:2075` | 复用链接语义；忽略是显式服务器写入，不能与纯本机过滤混成一个接口 |
| 真实主题抽屉预览 | `content.js:2228` 起抽屉流程 | 用户触发同站 iframe；不是重新拼一套正文，关闭卸载 |
| 搜索历史、推荐词、聚焦效果和显式分页按钮 | content 的搜索历史/搜索设置与 `syncSearchLoadMore`（约 `964-1123`） | 本机 `searchHistory`；加载更多仍驱动原站加载器，没有第二分页 API |
| 无结果外部搜索 | `content.js:1172 syncExternalSearch` → 后台 `external-search` → `external-search.js` | 先读原站完成/无结果，再请求单个已选引擎；无自动换引擎 |
| 默认树/原帖切换、全部/楼主/本人筛选 | `content.js:6705 syncReplyTree`、`6631 changeTopicAuthorFilter`；`page-refresh.js:1074` | 树是自有关系/读段呈现；作者筛选复用原站 postStream，无筛选树第二实现 |
| 树正文、Boost 正文、系统事件、解决方案与更多菜单 | `renderReplyTree:4815` → 主世界 `748/843/925` | 复用原站 `PostCookedHtml` / `PostSmallAction` / `PostMenu` / solved。无需恢复自建 Markdown/装饰器 |
| 连续阅读、双向分页、补父、跳楼、冷却/重试 | `scheduleReplyTreeTask:5530`、`loadReplyTreeTopic:5824`、`loadReplyTreeBody:5899`、`loadReplyParent:6008`、`loadReplyTreeJump:6256` | 一个树任务登记表 + 一个当前文档请求队列；各任务有不同意图但共享出网，见第 7 节 |
| 分支/后续同级收放、连线高亮、布局与阅读锚点 | `positionReplyBranchControls:4632`、`syncReplyTailControls:4710`、`restoreReplyTreeAnchor:4796` | 两类收放语义不同；不可为“统一按钮”把父楼收放与后续同级合并 |
| 作者名/头像/头衔/状态/徽章与 OP/ME | 树 UI + `page-refresh.js:556 enhanceReplyAuthors` | 原站数据/原生状态组件；缺字段不补用户请求，昵称/用户名属于显示选项 |
| 树内回应、回应人、回复、Boost、隐藏/忽略正文 | `content.js:3910-4167`、`4225-4468` → 主世界动作 | 其中回应 HTTP 在隔离世界，写模型在主世界，见 A4；正文/权限错误按实际结果显示 |
| 原站已读登记与时间轴 | `content.js:6927 syncReplyTreePosition` → `page-refresh.js:1281 trackTreeReading`、`216 syncFloorTimeline` | 可见帖子 ID 交还原站 reading；时间轴是一个实现，原帖/树共用 |
| 收藏、稍后再看、文件夹、拖动入口、书签单向镜像 | topic-library/store/entry；`content.js:6338 syncReplyBookmark` | storage.local 唯一收藏源；原站书签成功事件 → 本机收藏，删除本机项不反写原站 |
| 私人短标签/备注、用户卡编辑和设置管理 | user-marks + `content.js:7021-7262` + options | 相同 userId 数据，各场景不同显示；备注不出现在作者栏 |
| HTML/Markdown/PNG 导出、范围、离线/远程资源 | `content.js:5427 readExportTopic` → `topic-export.js` → offline-assets/share-image | 一个取数回调，各格式承担不同输出语义；系统事件状态判定重复见 A5 |
| 阻止自动播放、静态头像 | `content.js:6987 syncMediaSettings` → media 模块；主世界 `media-data` | 当前文档 DOM 管理；头像模板从原站已有模型读取 |
| 表情保存/下载/分组/批量导入/备份/编辑器插入 | sticker-library → 后台/IDB；sticker-composer → 原站上传器 | 保存图片本体；下载本机与加入库是两个动作；选中后上传成功才插入草稿 |
| 即时设置、搜索、恢复/导入/导出、同步与授权 | options + settings；页面内/完整页/弹窗共用 | 设置规范化共享，设置活动存储选择却重复，见 A7 |
| WebDAV 规则/收藏备份 | options → 后台 → webdav/library-store | 显式上传/下载；规则下载追加去重，凭据本机保存 |
| 检查更新、打开设置定位、浏览器 DoH 定位 | options → 后台对应消息 | 手动请求 GitHub latest；DoH 仅打开/指引浏览器设置，不改网络策略 |

## 4. 模块公开接口

本清单的“接口”包括模块发布给其他文件的对象方法、runtime 消息、跨世界事件和外部 I/O；局部 DOM 辅助函数不全部提升为公共 API。`BETTERLD_CONFIG` 是根配置对象，`BETTERLD_OPTIONS_ROOT` 是临时 UI 挂载点，二者不是业务方法集合。无 ES 模块构建：多数文件用 IIFE 发布 `globalThis.BETTERLD_*` 对象；`content.js` 与 `page-refresh.js` 的外部接口主要是事件。

### 4.1 设置、收藏与用户标记

| 对象（定义位置） | 发布的全部成员 / 输入 → 输出 | 当前消费者与收敛判断 |
| --- | --- | --- |
| `BETTERLD_SETTINGS`（`settings.js:629`） | `defaultSettings()`；`normalizeSettings(value)→完整设置`；`normalizeImportedSettings(value,current)→{settings,unknownKeys,warnings,rejectedKeys,errors}`；`normalizeRules(value)`；`webdavUrlAllowed(value)→boolean`；`validateCustomCss(css)→{valid,css,errors}`；`validateSettings(value)→{valid,settings,errors}`；`toSyncSettings(value)→可同步投影`；`stableStringify(value)→稳定串`；只读 `settingKeys`、`allowedCustomCssProperties` | content/options 共享规则；`defaultSettings/normalizeRules` 有内部调用，但无外部调用；两个只读集合也无外部调用，应缩小公开面而非删除内部规则 |
| `BETTERLD_LIBRARY_ENTRY`（`library-entry.js:29`） | `key(item)→主题/楼层身份`；`validate(item)→有效条目或抛错`；`href(item)→归一化 https 链接` | library-store/topic-library/background；身份与链接本应只有这里实现 |
| `BETTERLD_LIBRARY_STORE`（`library-store.js:351`） | `empty()`；`metadataFields(record)`；`read(value,allowDuplicates=false)`；`readImport(payload)`；`record(topic)`；`folderId(value)`；`folderName(value)`；`uniqueFolderId(library)`；`merge(current,incoming)→{library,summary}`；`exportPayload(library)` | background 写入规则、topic-library 读取/元信息、options 导入导出共用；`folderId` 无外部调用（内部校验仍使用） |
| `BETTERLD_LIBRARY`（`topic-library.js:775`） | `sync()→同步入口/按钮`；`updateMetadata(records)→合并已有条目元信息并重绘` | content 列表/主题刷新；另外消费同世界 `reply-bookmark` 事件；不自建 HTTP 数据源 |
| `BETTERLD_USER_MARKS`（`user-marks.js:83`） | `validate(mark)`；`normalize(value)→{version,marks}`；`upsert(store,mark)`；`remove(store,userId)`；`find(store,userId)`；`list(store)`；只读 `storageKey/tagMaxLength/noteMaxLength/maxEntries` | background 唯一增删；content 身份显示/编辑，options 管理；`validate` 与 `maxEntries` 无外部消费者 |
| `BETTERLD_WEBDAV`（`webdav.js:82`） | `createWebdavApi(fetchImpl,maxBodyLength)→{request(message),originPattern(url)}`；`webdavUrl(value)→URL/null`；`basicAuthorization(username,password)→头字符串` | background 只消费工厂；后两个函数对外发布却仅内部调用。构造请求头与 URL 规则有独立意义，没必要对 UI 全部开放 |

### 4.2 导出、媒体与搜索

| 对象（定义位置） | 全部公开方法 / 输入 → 输出 | 消费者 |
| --- | --- | --- |
| `BETTERLD_EXPORT`（`topic-export.js:1887`） | `sync({topicId,title,readTopic})`；`readTopic({scope,rangeText,postNumbers,onProgress,isActive,signal})→{topic,topicInfo,exportMode}` 是 content 注入的唯一原站取数回调 | content `syncTopicExport:5498`；模块内部持有按钮/对话框/导出流程，未发布 60 多个内部辅助函数 |
| `BETTERLD_SHARE_IMAGE`（`share-image.js:902`） | `render({topic,posts,loadImage,signal,onProgress,settings})→Promise<Array<{blob,width,height}>>` | topic-export `runShareImageExport:581`；只绘图和分页，不自行取原站正文 |
| `BETTERLD_OFFLINE_ASSETS`（`offline-assets.js:183`） | `assertSelfContainedSvgBytes(bytes,label)`；`assertSelfContainedSvgDataUrl(dataUrl)`；`assertAssetMimeType(mimeType,kinds,label)`；`dataUrlMimeType(value)`；`isFontMimeType(value)` | background / topic-export 共用离线资源判定；assert 失败抛错，不返回可冒充成功的空内容 |
| `BETTERLD_MEDIA`（`media.js:516`） | `setAvatarResolver(resolver)`；`sync({autoplay,avatars})`；`invalidate()`；`teardown()` | content `syncMediaSettings:6987`、`setAvatarResolver:7355` 与用户卡 `invalidate:7183`；`teardown` 无外部调用，内部在两项功能均停用时释放 |
| `BETTERLD_EXTERNAL_SEARCH`（`external-search.js:149`） | `searchUrl(engine,query)→URL字符串`；`parseResults(engine,html)→{results,filteredCount}` | background 构造 URL 并请求 HTML，content 解析/展示；后台 service worker 没有 DOMParser；引擎解析差异是真实外部格式差异 |
| `BETTERLD_MARKDOWN`（`markdown.js:195`） | `render(markdown)→HTML` | 实际无 `render` 调用，仅 content 初始化检查其存在。属于历史第二实现，不与导出转换混为一谈 |

### 4.3 表情存储、ZIP 与编辑器

| 对象（定义位置） | 全部公开方法 / 输入 → 输出 | 消费者与职责 |
| --- | --- | --- |
| `BETTERLD_STICKER_STORE`（`sticker-store.js:271`） | `name`、`folderName`、`folderId`；`classify(fileName,mime)→{ok,extension,mime/reason}`；`extensionOf`、`extensionForMime`；`limits(settings)→{itemBytes,totalBytes}`；`checkItemSize(size,capacity)`、`checkTotalSize(usedBytes,addBytes,capacity)→错误串/空串`；`formatBytes`；`bytesEqual`；`bytesToBase64`、`base64ToBytes`、`dataUrl`；`fileNameFor`、`downloadName`；`readBackup(payload)→{folders,stickers,failed}` | **17 个方法**；background/db/options/sticker-library。纯规则与编码，不接触 UI/数据库/网络 |
| `BETTERLD_STICKER_DB`（`sticker-db.js:403`） | `createStickerDb(indexedDBFactory)→实例`；实例 11 个方法：`list()`、`thumbs(ids)`、`record(id)`、`add({name,folderId,type,bytes,capacity})`、`createFolder(name)`、`createFolderIfMissing(name)`、`renameFolder(id,name)`、`deleteFolder(id)`、`rename(id,name)`、`move(ids,folderId)`、`remove(ids)` | 仅 background；list 是元数据，record 返回正文 data URL，thumbs 返回缩略图；数据库方法是真正事务边界 |
| `BETTERLD_STICKER_ZIP`（`sticker-zip.js:172`） | `readEntries(bytes)`；`readEntry(bytes,entry,maxBytes)→Uint8Array`；`isDirectory(entry)`；`isZipName(name)`；`baseName(name)` | sticker-library 本地批量导入。ZIP 解析与图片保存是不同输入边界，不必强行合并 |
| sticker-library（无 global 对象） | DOM 面板/右键、runtime 接收器、`sticker-state/upload` 桥调用 | API 是消息/事件，不是额外 service 类 |
| sticker-composer（无 global 对象） | 编辑器草稿捕获与校验、原站上传、成功后插入 Markdown | 维护 `captureId/epoch`，保证异步结果不会插错草稿；这是必要身份约束 |

这些对象的“无外部调用”来自当前 `src/`、scripts 和入口清单；内部仍需的函数仅取消导出，不能把整个实现一起删除。

## 5. 后台消息协议

所有后台响应应按 `ok/error` 消费，存在资源/权限/容量失败时不能当空数据成功。具体分发在 `src/background.js:836-931`。

后台接收 **29 种**消息：表情 11、收藏 6、独立分支 12。部分行为共用同一设置页或数据实现，消息多不等于有 29 套业务实现；能够用同一入口表达的定位消息可以收敛。

| type | 主要载荷 → 成功结果（`ok:true` 省略） | 唯一处理者 / 当前发送者 |
| --- | --- | --- |
| `open-link` | `{url,active}` → `{tabId}` | `createTab`；content。目标限同站 |
| `open-settings-at` | `{hash}` → `{tabId}` | `handleOpenSettingsAt`；content/options/sticker-library |
| `open-external-search-settings` | 无业务载荷 → `{tabId}` | `handleOpenExternalSearchSettings`；content |
| `open-topic-export-settings` | 无业务载荷 → `{tabId}` | `handleOpenTopicExportSettings`；topic-export |
| `open-dns-settings` | 无业务载荷 → `{tabId}` 或浏览器限制说明 | `handleOpenDnsSettings`；options |
| `check-update` | 无业务载荷 → `{latestTag}` | `handleCheckUpdate`；options |
| `webdav` | `{method,url,username,password,body?}` → `{text}` | `handleWebdav → webdav.request`；options |
| `external-search` | `{query,engine}` → `{html,searchUrl,engine}` | `handleExternalSearch`；content |
| `topic-export-check-origins` | `{origins}` → `{missing}`，同时保存待授权域名 | `handleTopicExportCheckOrigins`；topic-export |
| `topic-export-asset` | `{url,kinds}` → `{mimeType,size,dataUrl}`；失败可含 `missingOrigin` | `handleTopicExportAsset`；topic-export |
| `user-marks-write` | `{remove?,userId?,mark?}` → `{marks}` | `writeUserMark`，userMarksQueue；content/options |
| `sticker-context-menu` | `{visible}` → 成功确认 | `setStickerMenuVisible`；sticker-library |
| `sticker-list` | 无业务载荷 → `{folders,items,totalBytes}` | `stickerList → db.list`；options/sticker-library |
| `sticker-thumbs` | `{ids}` → `{thumbs}` | `stickerThumbs → db.thumbs`；sticker-library |
| `sticker-blob` | `{id}` → `{dataUrl,name,type,size}` | `stickerBlob → db.record`；options/sticker-library |
| `sticker-save` | `{name,mime,base64,folderId?}` → `{status,item}`，status 为 added/duplicate | `stickerSave → saveStickerBytes → db.add`；options/sticker-library |
| `sticker-rename` | `{id,name}` → `{item}` | `stickerRename → db.rename`；sticker-library |
| `sticker-move` | `{ids,folderId}` → `{moved}` | `stickerMove → db.move`；sticker-library |
| `sticker-delete` | `{ids}` → `{removed}` | `stickerDelete → db.remove`；sticker-library |
| `sticker-folder-create` | `{name}` → `{folder}` | `stickerFolderCreate → db.createFolder`；sticker-library |
| `sticker-folder-ensure` | `{name}` → `{folder}`，可复用同名分组 | `stickerFolderEnsure → db.createFolderIfMissing`；options |
| `sticker-folder-rename` | `{id,name}` → `{folder}` | `stickerFolderRename → db.renameFolder`；sticker-library |
| `sticker-folder-delete` | `{id}` → `{movedItems}`，内容回未分组 | `stickerFolderDelete → db.deleteFolder`；sticker-library |
| `library-toggle` | `{group,topic,remove}` → `{library}` | `toggleLibrary`；topic-library |
| `library-folder-create` | `{name}` → `{library}` | `createFolder`；topic-library |
| `library-folder-rename` | `{id,name}` → `{library}` | `renameFolder`；topic-library |
| `library-folder-delete` | `{id}` → `{library}` | `deleteFolder`；topic-library |
| `library-item-move` | `{topic,folderId}` → `{library}` | `moveLibraryItem`；topic-library |
| `library-import` | `{payload,dryRun?}` → `{summary,library?}` | `importLibrary`；options（预览不写入） |

后台主动向标签发送的另外 3 个协议不属于上述请求计数：`sticker-context-image {srcUrl}→{url,name}` 精确解析右键目标；`sticker-changed` 通知打开面板重读唯一数据源；`sticker-notice {message,status,refresh,openSettings}` 展示结果/错误（`background.js:439,595,795`；`sticker-library.js:1216-1241`）。右键菜单由浏览器菜单 ID 触发后台保存或下载，不需要再造一个后台接收消息。

## 6. 隔离世界与主世界事件协议

下表名称均省略公共前缀 `betterld:`；`I` 为内容脚本隔离世界，`M` 为 page-refresh 主世界。`id` 通常是请求关联 ID；`topicId` 是主题身份，`postId` 是帖子内部 ID，`postNumber` 是楼号，三者不可混用。事件 `detail` 当前普遍用 `JSON.stringify/JSON.parse`，避免直接跨世界传原站对象。

| 请求/通知 | 方向与必要载荷 → 结果 | 实现依据 |
| --- | --- | --- |
| `topic-list-request` → `topic-list` | I→M `{id}` → `{id,payload}`（主题/用户列表及 current_topic） | content `2616`；page `1603` |
| `search-state-request` → `search-state` | I→M `{id}` → `{ready,query,empty,authors}` 或 error | content `1126`；page `1616` |
| `refresh` → `refreshed` | I→M `{id,href}` → 成功或 error/status/retryAfter | content `3394`；page `1638` |
| `reply-sync` → `reply-data` | I 或 M 触发同步 `{topicId}` → stream、变化 posts、context、userFilters、topReplies、user_badges | content `6411,6760`；page `1169`；不是每次传全部帖子，但每次核对全部所选模型 |
| `reply-register-posts` → `reply-posts-registered` | I→M `{topicId,posts}` → 已登记 postIds；失败送 reply-data；之后微任务 reply-sync | content `5353,6405`；page `829` |
| `reply-cooked-mount` | I→M `{topicId,bodies:[{id,post}]}`；DOM mounted 标记或就地错误 | content `5361`；page `748`；普通帖子与 embedded Boost 身份不同 |
| `reply-menu-mount` → `reply-menu-mounted` | I→M `{id,topicId,post}` → `{id,error?}` | content `3760-3789`；page `843` |
| `reply-solved-mount` | I→M `{topicId,slots:[{id,summary,post}]}`；DOM 标记/失败 reply-data | content `5366`；page `925` |
| `reply-author-details` / `reply-author-reset` | I→M `{topicId}` 增强作者；`{postIds}` 或空值释放订阅 | content `4893,5369,6732`；page `400,610` |
| `reply-author-status` | M→I `{topicId,postId,status}`，只更新对应缓存 | page `477`；content `6427` |
| `host-cleanup` | I→M 重试先前失败的断连宿主释放 | content `7275`；page `721` |
| `reply-position` | I→M `{topicId,postNumber,postId,ratio,visiblePostIds,active,timeoutMs}`；更新原站阅读和时间轴，异常 reply-data | content `6948`；page `1334` |
| `reply-reading-status` | M→I `{topicId,error}` 显示阅读登记失败/恢复 | page `1300,1306`；content `6543` |
| `reply-read-state-request` → `reply-read-state` | I→M `{topicId}` → `posts:[{id,read}]` 或 error | content `6570,6551`；page `1243` |
| `reply-reading-release` | I→M 交还原站阅读管理，同时释放树投票订阅；pagehide 也调用释放 | content `6736,7279`；page `677,1328` |
| `reply-jump` | M→I `{topicId,postNumber,postId,requestId}`，统一深链/时间轴目标路径 | page `75`；content `6435` |
| `reply-jump-wait` / `reply-jumped` | I→M 跳楼排队/冷却等待通知与最终回执 `{topicId,requestId,postNumber,error?}` | content `5654,6210`；page `348,355` |
| `timeline-reset` | I→M 清时间轴实例 | content `6735`；page `347` |
| `reading-filter-request` → `reading-filter-result` | I→M `{id,topicId,username}` → userFilters/topReplies 或 error；成功再触发 reply-sync | content `6657`；page `1074` |
| `reply-compose` → `reply-composed` | I→M `{id,topicId,postId}` → 打开原站回复编辑器结果 | content `3747`；page `1366` |
| `reply-boost` → `reply-boosted` | I→M `{id,topicId,postId,raw}` → `{id,boost,error}` | content `4307`；page `1390` |
| `reply-action` → `reply-action-result`；可伴 `reply-action-wait` | I→M `{id,topicId,postId,action,...}` → post/error/cancelled；原站确认框等待期间暂停调用方超时 | content `4135`；page `1432` |
| `reply-action` 的动作枚举 | `reveal(cooked)`、`like-check`、`reaction-update(updated)`、`ignore-reveal(updated?)`、`boost-inspect(permissions?)`、`boost-delete`、`boost-flag` | page `1444-1508`；该接口混合权限检查、数据回写和真正动作，建议按用户动作收敛 |
| `reply-poll-refresh` → `reply-poll-data` | M→I 请求 `{topicId,postId,revision}`；I 经现有队列补该楼 polls，再 I→M 原位写模型 | page `640,669`；content `6371`；不是通用投票轮询 |
| `reply-bookmark-changed` | M→I `{topicId,postId,bookmarked,title}`（原站成功态） | page `905`；content `6360` |
| `reply-bookmark` | content→topic-library 同隔离世界 `{bookmarked,topic}` → 后台本机收藏写入 | content `6352`；topic-library `761`；不是又一次原站写书签 |
| `user-card-request` → `user-card` | I→M `{id}` → 当前用户卡 identity/头像模板或 error | content `7139`；page `991` |
| `media-data-request` → `media-data` | I→M `{id,pairs,templates}` → 模型头像模板/CDN 信息 | content `7014`；page `1045` |
| `export-topic-request` → `export-topic-result` | I→M `{id,topicId}` → 当前主题标题、筛选标记、stream 和 posts 快照或 error | content `5423`；page `1109` |

表情单独主世界桥只有 5 个事件（`sticker-composer.js:8-16,268-287`）：

- `sticker-bridge-ready`：M→I，动态脚本已就绪；重复注入也回通知。
- `sticker-state` / `sticker-state-result`：I→M `{id}`，返回 `{id,state:{open,captureId?,canUpload?}}` 或 error；不在 UI 持有整个编辑器模型。
- `sticker-upload` / `sticker-upload-result`：I→M `{id,captureId,fileName,mime,base64,timeoutMs}`，返回 `{id,ok,markdown/error}`；主世界先核草稿身份、还原 File，再调用原站 `discourse/lib/uploads` 的上传/插入路径（`sticker-composer.js:204-257`）。

另有同世界 UI 事件 `betterld-settings-close`（没有冒号）：options `2964` 从关闭按钮发 bubbles/composed 事件，content `1451` 在 ShadowRoot 关闭设置对话框，不经过后台/主世界。以上覆盖 51 个冒号业务事件和该 UI 关闭事件；原站点击由精确 DOM 事件代理触发。

## 7. 数据所有权、网络和调度

### 7.1 列表数据：源是原站，UI 不应反向伪造 API 载荷

```text
原站 route/controller 模型
 → currentTopicListPayload（拼 users/topic_list.topics 的接口形状）
 → JSON event
 → topicListEntries（再 join users、规范化、生成 stats）
 → topicListMetadata Map
 → dataset + 信息栏 DOM
 → applyCardFilter / 收藏元数据消费
```

首屏还从 `#data-preloaded` 取已下载载荷，统一经 `topicListEntries`（`content.js:2639`）。首次预载与后续模型读取属于不同输入来源，不能简单删掉其一；可让两种来源各自在进入时转成同一最终条目结构，之后只消费该结构。

观察器已有源/输出区分：`sourceMutation:7436` 排除插件 owned 节点、插件 class 和过滤 hidden；原站变更当轮增强行，尾部防抖 `scheduleSync:3628` 再作全页核对。另有 `routePollMs=500` 和 `pageDataSyncMs=5000`（根配置）低频兜核；同一模块同时受这些入口驱动，有可减少重复扫描的空间，尚未测量次数。

### 7.2 树帖子：模型唯一，投影应小而单向

```text
预载 / 按需 JSON
 → tree.posts + tree.loaded + tree.stream（隔离世界）
 → reply-register-posts（全帖对象）
 → 原站 identityMap Post
 → reply-sync / snapshotPost
 → reply-data（变化帖全投影）
 → pendingData Map → mergeReplyTreePost → renderReplyTree
 → cooked/menu/solved mount（又传 post）
 → 主世界 findLoadedPost（取回刚登记的模型）
```

`tree.posts` 是用于读段和 UI 的投影缓存，不能直接断言是第二份原站模型；但挂载时再次带回大对象是确定冗余。普通帖完成登记后可仅发 `{topicId,postId,hostId}`。Boost 是独立嵌入正文，不存在同一个 Post 身份，需要单独保留其嵌入载荷语义（`page-refresh.js:53-60`）。

原站变化检测已经只发 `changedPosts`（`page-refresh.js:1204-1235`），优于全量跨世界发送；其每次全字段快照、内容脚本逐字段 stringify 与 render 全帖签名仍可重复消耗 CPU，见 A6。

### 7.3 网络端点与唯一读取路径

| 对象 | 实际路径/发起者 | 当前纪律 |
| --- | --- | --- |
| 主题快照/筛选流 | `/t/{topicId}.json`，带 summary/username_filters；content `5858` | 共享主题队列、取消/筛选世代、挑战/429 冷却 |
| 按 ID 批量楼层 | `/t/{topicId}/posts.json?post_ids[]=...`；content `5899`、`5450`、`6385` | 正文分页、导出、投票补读共用主题 JSON 读取；投票强制消息之后的新响应 |
| 补父/目标附近页 | `/t/{topicId}/{postNumber}.json`；content `6008`、`6256` | 同一队列，补父另有间隔，不预读全帖 |
| 导出指定楼号 | `/posts/by_number/{topicId}/{postNumber}.json`；content `5476` | 只有缺少所选楼时请求，loaded 范围不补请求 |
| 显示隐藏正文 | `/posts/{postId}/cooked.json`；content `4093` | 用户触发、队列读取，主世界核权限写回 |
| 原站局部刷新 | 主世界 `postStream.refresh` 或 `router.refresh`；page `1650-1658` | content 将刷新也放入同一当前文档预算，不整页重载 |
| 回应名单 | GET `/discourse-reactions/posts/{id}/reactions-users-list.json`；content `3947` | **直接 fetch**，不经过主题读取队列/统一超时/冷却分类 |
| 回应提交 | PUT `/discourse-reactions/posts/{id}/custom-reactions/{reaction}/toggle.json`；content `4065` | **直接 fetch** + CSRF；检查和回写在主世界 |
| 账号忽略 | PUT `/u/{username}/notification_level.json`；content `2075` | 用户确认后直接写入；不是自动过滤 |
| Boost | 创建 `/discourse-boosts/posts/{id}/boosts`、删除 `/discourse-boosts/boosts/{id}`；page `1408,1487`；权限检查 content `4147` | 写动作走原站 ajax/权限；按需权限读取走主题请求路径 |
| 原生阅读、回复、编辑/书签/解决方案/投票 | 原站 reading 服务、controller、原生组件 | 复用原站生命周期与成功结果，不由插件再建第二请求协议 |
| 离线资源/右键图片/外部搜索/WebDAV/版本 | 后台 + 各功能 URL 规则，见消息表；右键图片下载 `background.js:548-591` | 功能各有权限/大小/错误语义，不该套为统一万能 fetch 业务层 |
| 壁纸配色取样与实际页面媒体 | content `updateWallpaperColor:503` 直接 CORS fetch 后 Canvas 取色；图片/播放器仍由浏览器 DOM 加载 | 壁纸/媒体 URL 来自根配置或用户输入，非站点 JSON 队列 |
| 嵌入设置静态资源 | content `1375/1410` 读取扩展或开发预览的脚本/HTML/CSS；正常扩展脚本动态 import | 本地资源加载与运行时站点数据请求是不同边界 |

主题读取的实际链是 `requestTopicResponse → scheduleMetadataRequest → shareTopicFetch → fetchTopicJson`（`content.js:2363-2578`）：队列处理优先级/启动预算，URL 表处理在途复用，最底层处理一次 fetch/超时/错误。树任务已占队列时直接 `shareTopicFetch`，避免队列内再次排队死等。它们职责有区别，不能仅因四个函数就判为臭抽象；可改清命名和收紧调用入口，不能机械叠成四个类。

**预算不是浏览器全局队列。** `metadataQueue/metadataStarts/responseRequests` 在每个 content IIFE 内（`content.js:55-59`）；冷却从 storage 初次读取并写回，但 `storage.onChanged:7390-7428` 不接收冷却键。顶层、预览和多个已打开标签会各算各的预算，运行中的其他页也不会同步最新冷却。当前参数正确只证明单文档限速，跨页同时读帖仍可能合计超预算。后台确有库数据写入队列，与主题 HTTP 队列不是一个对象。

### 7.4 持久化与所有者

| 数据/根参数键 | 权威存储与写入方 | 实际传播与重复成本 |
| --- | --- | --- |
| `storageKey` → `betterld.settings` | storage.local；options 和 content 都可重写整份设置；sync 保存筛选后的投影 | options `save` 写 local + sync-meta；content 搜索历史/每日壁纸/过滤修改只写 settings，不共同维护元数据，详见 A7 |
| `syncMetadataKey` → `betterld.sync-meta` | local/sync；options | `updatedAt/origin` 决定较新设置，content 的活动设置选择未遵从同一策略 |
| `wallpaperLocalStorageKey` / `wallpaperRemoteCacheKey` | local；前者 options 存压缩图、content 读；后者 content 缓存可用状态 | 壁纸私有大值不进浏览器 sync |
| `libraryStorageKey` → `betterld.library` | local；background `libraryQueue` 是唯一变更写入者 | handler 回整库 → UI 丢弃该字段再 get 整库；storage.onChanged 同时可能再触发读和 render |
| `libraryPositionStorageKey` | local；topic-library | 浮动入口位置，预览不重复创建顶层入口 |
| `userMarksStorageKey` | local；background `userMarksQueue` 唯一写入 | content/options 读并订阅；按 userId 匹配，备注不是原站数据 |
| `topicRequestCooldownStorageKey` | local；content | 初读和失败/成功写回；现有标签未监听该键更新，跨页仍各算预算 |
| `topicReadingViewStorageKey` / `refreshScrollTopStorageKey` | sessionStorage；content | 当前标签视图/滚动状态，不进入跨设备同步 |
| `topicExport.offlinePermissionStorageKey` | local；后台记待授权来源，options 申请权限 | 保存精确来源待授权列表，不保存导出媒体本体 |
| `stickerLibrary.pendingOriginsStorageKey` | local；后台/设置授权流程 | 表情外部图片的待授权来源，与离线导出流程有用途差别 |
| `stickerLibrary.dbName` → `betterld-stickers` | 扩展源 IndexedDB：items/blobs/folders/meta（缩略图放在 blobs 同一条记录）；只有 background 调 db | 内容/缩略图不塞 storage.sync；所有表情消息共用 stickerQueue，真实写入在 IDB 事务内 |

收藏链（`background.js:340-417`、`topic-library.js:84-98`）：UI 发增删 → 后台读全库/改/写 → 返回整库（UI只读ok）→ UI 再读全库；`storage.onChanged` 也重读。最小方案在“成功响应直接采用”与“成功响应只确认、变更通知读取”中选一种；两者并存才是多余，不能为省一步取消串行写入。

### 7.5 导出与表情资源链

**HTML 离线：** 用户选范围 → content 读快照/缺楼 → topic-export 清理 cooked/构建 HTML DOM → 收集资源清单 → 后台核权限/有界下载 → 字节编码 data URL → topic-export 替换引用/打包 Blob。原生资源到扩展后台的权限边界必要；媒体全部内嵌前不能称完全离线。PNG 和 Markdown 分别走 Canvas 绘制、HTML→Markdown 转换，输出不同，不能合成一个含大量 format 判断的万能渲染器。

**表情新增：** 文件/ZIP/右键 URL → UI 或后台读取字节 → 类型/容量规则 → 后台 db.add 去重/缩略图/事务保存 → 通知面板。文件导入在页面把 bytes 编成 base64，后台解码；JSON 消息跨浏览器表示约束确需可传载荷，不宜直接宣称所有 base64 转换均可删除。

**表情插入：** db Blob → db.record arrayBuffer→data URL → runtime 消息 → UI 截 base64 → JSON CustomEvent → 主世界解码为 File → 原站上传成功 → 编辑器插入。这里有一次必要的扩展源/主世界字节转移，另有可省的 data URL 包装/剥头（`sticker-db.js:184-196`、`sticker-library.js:869-878`）；不能把浏览器不可传/不可访问的 Blob 直接当跨世界对象递过去。

**表情备份：** options `2280-2290` 逐条索取原图编码，拼 JSON 分片 Blob；避免单一巨串，但每项是完整 data URL 在两侧复制。恢复逐条进后台队列，优点是单一容量/去重规则，代价是去重扫描可能随库规模增长。

**WebDAV：** options 每次消息传 URL/用户名/密码/body → 后台权限判断 → webdav 生成认证/HTTP → 文本回 UI 解析。UI 输入尚未保存时要明确使用草稿还是持久值，不能为“少传一次”偷偷改成读旧设置；确定采用持久值后才可收敛成 `{kind,method,body}`。

## 8. 具体冗余、摆放与性能风险

以下编号用于后续定点决策；每项先处理既有调用，不引入备用路径。

### A1 — 废弃 Markdown 渲染器仍是核心初始化前置条件（确定）

- 依据：`manifest.json:47` 仍加载 `src/markdown.js`；`markdown.js:195` 发布 `render`。`content.js:14,25` 只取对象并验证 `render` 存在，实际没有调用它。
- 影响：无实际使用路径的实现进入每个匹配 frame；缺这个废弃能力会让整个 content 初始化退出。该问题不仅是少一个文件，也是不相干功能耦合。
- 最小方向：删除依赖检查、Manifest 加载和无调用模块；同步核对预览脚本与产品文档的旧引用。保留 `topic-export.js` 真正在用的 HTML→Markdown 转换，不把同名输出误删。

### A2 — 原站模型已经登记，挂载仍重复传帖子全文（确定）

- 依据：`content.js:5350-5368` 先 register `unregistered`，再给 cooked、solved 发 `post`；更多菜单 `3788` 同样传 post。主世界 `registerTreePosts:38`、`resolveTreePost:53` 实际以 `findLoadedPost(data.id)` 优先取原模型。
- 影响：首轮普通楼层可能同时经历登记、正文挂载、方案入口挂载和回传同步，包含 `cooked`/反应等大字段；更多菜单也重复载荷。事件 JSON 复制次数多于实际业务必需。
- 最小方向：普通帖只登记一次，后续所有宿主按 ID 寻址；保留 Boost 独立嵌入身份及挂载失败提示，不加“找不到再偷偷创建另一份模型”的第二路径。

### A3 — 列表模型先装成 HTTP 形状再拆开，且传无人消费字段（确定）

- 依据：`page-refresh.js:1538-1600` 从模型拆出 users/posters/topic_list，`content.js:2581-2613` 又建 users Map 并重新 join。`page-refresh.js:1592-1594` 发送 `image_url/thumbnails/tags`；`image_url` 仅作为 `thumbnails` 的候选；`topicListEntries` 留下的 `excerpt/thumbnails` 后续无读点（DOM 搜索摘要走原生 blurb）。
- 影响：为复用旧 API mapper 多做展开/映射/序列化；无用图片/摘要字段随着每轮模型同步流动。
- 最小方向：定义实际列表条目结构，在主世界模型投影时直接给出作者/活动/stats/participants；预载在其读取入口转成同结构。不为这一转换增加 DTO 工厂、repository 或第二缓存。

### A4 — 回应动作被拆成“检查→隔离世界 HTTP→主世界写回→隔离世界再渲染”（确定）

- 依据：`content.js:4053-4081 toggleReplyTreeReaction` 连续调用 `like-check`、PUT fetch、`reaction-update`；主世界 `1448-1453` 分别核验与 setProperties，随后 `1507-1512` 返回整 post 并再排 `reply-sync`。
- 影响：一次用户操作两轮桥 RPC，检查/回写都回整帖并触发同步（实际增量是否发送取决于快照是否变化）；动作执行与模型写入分属不同所有者。名单另做直接 HTTP，错误/限流语义与主题读取分散。
- 最小方向：一个 `toggleReaction(topicId,postId,reaction)` 主世界动作完成权限核对、原站请求与原位模型更新；UI 只收结果/同一增量流。`like-check` 当前还回整帖并触发同步，进一步放大同一操作的重复回传。UI 选择器/名单若需要自有呈现可保留，不能借此复刻另一套原站数据模型。

### A5 — 树与导出对“合法帖子状态”有两套判断，已出现契约分叉（确定）

- 依据：`replyTreeBodyState`（`content.js:5740`）接受 `post_type===3` 的空 cooked 系统事件及隐藏/删除状态；`readExportTopic` 最终 `5489` 对所有帖子一律要求非空 cooked。
- 影响：相同原站楼层在树中合法可读，选择全量导出时可被当成正文缺失。不是兜底应该解决的问题，而是两个调用点对同一事实的定义不同。
- 最小方向：共享帖子状态判定；各导出格式明确如何表达合法系统事件/可见占位。确实读取失败继续失败，禁止自动跳过事件/缺页或用假正文宣称完整。此项涉及输出契约，先确认具体格式表达再实施。

### A6 — 已有 changedPosts 增量，后面仍多次全字段比较和全树签名（确定路径，性能收益待测）

- 依据：主世界 `snapshotPost:1148` 每次序列化嵌套字段；content `6190` 附近逐字段 stringify 比较；`renderReplyTree:4815` 为 previous/current 帖子计算包含完整 post 的签名（`4874 signatureFor`），`renderPost` 又计算签名。`5331-5338` 每次 disconnect/reobserve 全部 card，`5402` 再标记所有 item dirty。
- 影响：只有一个楼层变化也可能遍历当前模型、UI 缓存和可见树；内容越长/累积楼越多，字符串与几何准备开销越大。已有 cooked 宿主复用不能证明这些计算不存在。
- 最小方向：沿现有 changedPosts 传递变化 ID/必要字段，分别标记结构、作者、正文和几何失效；未变化楼复用既有签名/订阅/观察对象。先减少重复判断，避免引入通用 diff 引擎或更多状态框架。

### A7 — 设置同步权威与写入元数据不是同一实现（确定，覆盖后果是静态风险）

- 依据：content `getActiveSettings:152-170` 开同步即优先远端；options `reconcileSyncSettings:684-733` 按 `updatedAt` 和用户确认选新值。content `persistSettings:874`、每日壁纸 `305`、过滤 `2115/3174` 及同步合并 `7394` 写 settings；只有 options `save:747-777` 同时维护 sync-meta。
- 影响：页内刚改的同步字段没有更新同一版本元数据，另一入口按旧时间戳比较时可能反向覆盖。搜索词等本地字段不应挤进 sync，但仍和同步字段共用整对象写入，放大覆盖与存储通知范围。
- 最小方向：同一个 settings 写入口负责规范化、local 写入、同步投影和元数据；options/content 只提交明确变更，不各自定义远端优先级。浏览器 Promise/callback 差异另用一个轻薄平台函数，不加业务层转发。
- 适配重复：storage 包装 `options.js:134-250` / `content.js:114-200`；runtime 发送在 content `1932`、options `1971`、topic-export `1014`、sticker-library `47`、topic-library `71` 五处。共享适配确有收益，但先统一失败语义再合并，不能只抽一个万能 `callApi` 把分歧藏起来。

### A8 — Header 两个选项实际共用完全相同样式（确定）

- 依据：`content.css:3411-3436` 将 `header-visual="native"` 与 `"frosted"` 放同一选择器组；`content.js:859` 仅写设置值。透明/实色另有规则，二者确有视觉差异。
- 影响：界面给出两个名字，实际实现/结果相同，用户必须理解无价值的区别。
- 最小方向：收为一个渐变模糊值；读取旧值时一次规范化，停止存储/展示两种等价命名。保留透明/实色等有实际语义的选项，未经授权不删除。

### A9 — 主题“全局队列”只在单文档全局（确定）

- 依据：第 7.3 节列出的独立 state 与冷却监听缺口。多个标签/预览都可各自发请求，单文档 URL 去重不跨文档。
- 影响：单页预算无法约束账号/IP 合计；跨标签看到不同等待状态。是否导致当前站点故障需要真实现场，不能从代码直接断言。
- 最小方向：若目标是跨标签统一预算，应由已有后台作为唯一预算所有者，页面保留筛选世代和 UI 等待；原站 ajax/CSRF 等执行世界约束仍在调用处满足。不要只广播冷却后继续各算各的请求窗口，也不要在 UI 队列外再加第二层独立限流规则。

### A10 — 读取失败被消化为 null、false、默认设置，调用方无法区分失败与无数据（确定）

- 依据：`content.js:161-169 getActiveSettings` sync 读取失败后继续用 local；`7378-7387` 设置读取失败套默认值。`page-refresh.js:1606-1612` 捕获列表投影错误仅 console，然后回 `{payload:null}`；`content.js:2616-2637` 超时/异常也返回 null，`syncTopicListMetadata:2789-2835` 再转为 false。
- 影响：多层状态压缩，故障原因在到达用户入口前丢失；“当前确实没字段”和“桥失败”混淆。已有控制台日志不等于用户看到明确状态。
- 最小方向：可预期的缺字段仍缺字段；异常沿调用链带原始 error，到已有状态行终止。设置读取失败不要把默认值伪装成成功加载，也不要增加备用存储/备用请求实现。壁纸渐变、原站权限拒绝等已确认产品行为另行保留。

### A11 — 源变化、尾部全扫、慢核对重复驱动同一组业务（确定路径，非已测循环）

- 依据：`content.js:7463-7510` 当轮增强受影响行后 `scheduleSync`；`3630-3637` 扫列表/树/搜索加载；`7263-7275 syncPageData` 每 5 秒又核同组业务；全设置应用 `349-451` 也跨域驱动这些同步。
- 影响：来源变化已局部更新仍会进行尾部全量核对；任何设置变更也触发与其不相关的模块。当前 owned 过滤避免纯插件输出自激，不能把此项写成已证实无限循环。
- 最小方向：保留必要低频核对；源变化只传受影响行/领域，按设置差异调用实际受影响功能。别新增四层事件总线来替代函数调用。

### A12 — 收藏链“整库返回后再整库读取”是确定空转（确定）

- 依据：`background.js:355-357/372/381/391/405/417` 回 library；`topic-library.js:88-90` 消费只核 ok 后 `readLibrary`；`777-780` 变更监听也读。
- 最小方向：保留后台唯一写入者与串行队列；一条结果采用路径、一处 render。单次改动只返回确认或直接采用返回值，二选一。不要再加一层 store 与 library 并存维护数据。

### A13 — 导出树关系构建两份，格式绘制分开才有必要（确定）

- 依据：`topic-export.js:1212 renderNestedPosts` 和 `1254 renderNestedPostsHtml` 都重建 byNumber、roots、范围外父级并排序。分歧只在最终 Markdown/HTML 输出；正文脱水 `1527` 与 HTML 解析 `1621` 还有各自的 DOM/嵌入检查，转换路径有可复用信息。
- 最小方向：一个 `buildReplyForest(posts)` 返回关系，两个格式消费；纯文本/HTML/Canvas 绘制各保留格式职责。先抽确定重复的关系，不造抽象导出 pipeline，也不把每个私有函数发布成接口。

### A14 — 表情按内容去重逐张扫描同尺寸原图（确定，增长成本待测）

- 依据：`sticker-db.js:223-238 add` 用 size 索引找候选，每个候选 `blob.arrayBuffer()` 再 `bytesEqual`。N 个同尺寸且内容各异的文件逐条导入，会使原图候选读取/比较次数呈二次增长；字节比较还受每对数据首个不同字节的位置影响。
- 最小方向：不先增加索引/算法层。若实际批量导入成本需要优化，可在现有后台队列的单批中复用同尺寸候选字节，减少反复 IDB 读取；这仅降低 I/O，最坏字节比较次数仍为二次。保持逐字节比较与容量约束，不引入哈希校验/去重，也不声称简单缓存解决了算法复杂度。

### A15 — 编码、字段映射与校验存在小范围真重复（确定，收益低于数据绕行）

- 编码：后台 `encodeBase64:248` 与已加载的 `sticker-store.bytesToBase64:164` 同一分块算法；可以用一个现有实现，不必新增 `codec-service`。
- 收藏：`library-entry.js:19/26` 与 `topic-library.js:164/479` 重复主题路径/楼层链接规则；`library-store.js:128-135` 和 `205-213` 重复条目字段投影，可定点调用共享字段规则。
- 设置：关键词空值校验 `settings.js:532` / `options.js:1666`，收藏/规则备份地址不能相同 `settings.js:568` / `options.js:2495`。WebDAV URL 在 settings/options/background/webdav 都有校验调用/解释；**信任边界的再次检查应保留，判断表达式与错误定义可共用**，不能把每次验证都算冗余。
- 参数：`sticker-store.js:102-110 limits` 再做默认/范围处理，后台传原始 settings，UI传 normalize 后值；应明确输入契约，消除谁都要猜的两种用法。
- 低收益样式重复：options.css 已有 `:root,:host`，content `1358` 仍替换 `:root`；`html/body→:host` 仍有嵌入作用，不能整段删掉。
- 三处 DOM `element` 小助手相似，但分处独立 UI/owned 约定。只为少几行抽公共组件会引入跨场景耦合，优先级低；可明确 owned 属性，不增加 UI 框架。

### A16 — 无外部调用的公开成员和重复设置定位协议（确定）

- 第 4 节列出的无外部调用导出保留为内部实现；没有证据的将来复用不构成公开 API 的必要性。
- `open-settings-at`、`open-external-search-settings`、`open-topic-export-settings` 都只打开同一 HTML 的定位 hash（background `121/129/314`）。可以一个已有白名单定位接口实现，发送者直接传已允许的位置；不能为合并删掉用户需要的授权入口。
- `open-settings-at` 白名单中的 `externalSearchEngine` 当前走专用消息，属于重复协议下的未用定位值，不是整个外部搜索功能无调用。

### A17 — 消息分发表面统一，处理函数签名却不统一（确定）

- 依据：`background.js:730 stickerList(sender)` 只声明 sender；handlers 表 `807` 将它直接注册，分发 `851` 统一传 `(message,sender)`。因此该函数实际把 message 当 sender 传入 `isTrustedSender`；后者 `31-35` 在没有 URL 时直接放行。
- 影响：该消息没有核验真实 sender，而其他表情处理器有。这是实际接口契约不一致；本轮未运行攻击/行为验证，不声称已存在外部可达利用路径。
- 最小方向：处理器全部采用已有 `(message,sender)` 签名，真实 sender 只在一处判来源。不要为了兼容错位参数再加猜参/无来源兜底。
- 相邻通知缺口：`sticker-folder-ensure` 在 `stickerMutationTypes:825-834` 之外；创建新分组时没有同样的跨标签变更广播。它可能只是查找，也可能写入，应返回是否创建并仅在真实变更时通知，不把两种行为拆成四层接口。

## 9. 建议的最小目标结构与执行顺序

```text
页面 UI（列表、树、设置、收藏、表情、导出）
  ├─ 直接函数：同一世界里的规则/渲染/范围转换
  ├─ 主世界动作与投影：原站模型/组件所有者，ID 定位、一次动作
  └─ 后台：扩展权限、外网/文件、本机持久化串行写入与必要跨页预算
根 config：参数与默认值唯一来源
```

这三处是执行环境边界，不是让每个功能依次经过三个对象。纯本机格式转换就在当前模块直接完成；原站动作不先经后台；后台表情存储不借道原站模型。

| 顺序 | 最小交付单元 | 完成标准与需要保留的边界 |
| --- | --- | --- |
| 0 | 校正现有消息签名与通知条件（A17） | 实际 sender 被正确消费；只有真正写入时通知，不新增业务通道 |
| 1 | 清理确定无调用模块/字段与等价设置命名（A1/A3/A8） | 入口、加载清单、消费点和文档一致；等价模式有一次迁移；不动有真实差异的产品模式 |
| 2 | 普通帖一次登记、所有宿主 ID 寻址（A2） | 正文/菜单/方案共用 identityMap；Boost 独立身份、断连释放、错误提示保持 |
| 3 | 一次原站动作在主世界完成（A4） | 回应权限、请求、模型更新由同一处负责；UI 不再回灌全帖，不重复触发渲染 |
| 4 | 统一帖子状态事实与导出表达（A5） | 事件/隐藏/删除与真正缺失分清；全部导出仍校验完整性，无法表达就明确报错 |
| 5 | 收敛设置/存储/表情等数据通路（A7 及领域发现） | 每种持久数据单一写入所有者；避免每次传全库，不吞失败 |
| 6 | 消减快照/扫描/几何重复（A6/A11） | 相同候选仅变化楼进入相关更新；保持原生组件/媒体状态、连线及阅读锚点 |
| 7 | 按需要修正跨页预算（A9） | 一个实际预算所有者；多标签/预览同步窗口和冷却，旧任务仍可取消，不造第二请求渠道 |

每单元完成后再整理职责文件，不把文件数量、接口数量下降当作唯一验收指标。全部调整都应在保留现有真实行为的前提下进行；涉及删用户选项、导出表达、数据迁移的部分先明确产品决定。

## 10. 覆盖、证据与边界

- 已清点 Manifest 中的内容脚本、后台模块、主世界资源、设置入口与全部 `src/` 文件；公共方法、runtime 消息、业务事件分别列在第 4–6 节。CSS 按共享材质和功能消费点检查，未声称每个选择器都做了可达性证明。
- 代码行号基于 `e3b5036`。后续定位同时使用符号名，行号可能随开发移动；历史 ADR 的网格方案是 Superseded，不作为保留网格实现的依据。
- Codegraph 当前索引报告同步禁用/符号不存在，未将索引缺失当作无调用证据；接口和调用链直接从当前文件检索核对。
- 静态审计能够确认重复序列化/绕行/状态分叉的存在；不能证明浏览器内的实际耗时、内存走势、限流触发或所有用户路径可用。本轮没有运行测试、浏览器验收或性能实验。
- 本轮文档交付不改变 `0.2.5` 运行包；无需重打包相同源码。未验项保持原状，源码调整及其实际包加载证据属于下一轮明确授权范围。

## 11. 2026-10-17 行为等价收敛

主人在审计提交 `8f1da9e` 后授权收敛，并要求功能与现有均不变。本节是该次实施的增量记录；第 1–10 节保留原审计基线，查询现行协议时应用以下差异。

### 11.1 已收敛的实现与现行接口

| 审计项 | 实施结果 | 保留的行为/边界 |
| --- | --- | --- |
| A1 | 删除无消费的 `src/markdown.js`、Manifest/开发注入加载、初始化依赖和语法检查条目 | HTML→Markdown 导出转换保留；真实网页预览不变 |
| A2 | 普通帖正文/菜单/解决方案均按 `postId` 定位已登记的原站模型；只有 `reply-register-posts` 可以创建补载 Post，菜单独立入口先登记；Boost 正文继续携带独立 `post` | 原生组件、身份/权限、系统事件、Boost ownsPost 释放和失败就地提示保留；不改 cooked ID/DOM 宿主规则 |
| A3 | 主世界列表返回 `{current_topic,entries}`，条目包含身份、活动、参与者和 `counts:{posts_count,reply_count,like_count,views}`；内容端直接消费条目、调用既有 `topicStats(counts)` | 预载 API 在读取处适配；统计标签/图标/缺值/总楼数减首帖规则只保留 content 一处；作者优先级、头像去重、前四参与者及路由世代不变；不补网络请求 |
| A4 | 评估后保留原 `like-check → content PUT → reaction-update` 整条链，未交付回应动作合并 | 合并会改变网络是否受桥超时限制，以及请求期间切树/切帖的旧状态守卫；仅保留更短调用链不足以证明异步契约等价，本轮按原实现保留 |
| A6（局部） | 一次 `renderReplyTree` 内按楼号缓存签名，同一输入仅序列化一次 | 完整签名字段、跨轮失效、正文复用、作者订阅、几何/ResizeObserver 和页面慢核对均保持 |
| A12（传输） | 收藏五种写入与非 dryRun 导入不再返回无人消费的整库；写入完成返回 `ok`，导入另外返回 `summary` | 后台唯一写入者和串行队列不变；各 UI 原本的成功后读取与 storage 通知路径保留，不引入版本/第二缓存，也不声称已消除所有重复读 |
| A13 | HTML 与 Markdown 共用私有 `buildReplyForest(items)` | 仍分别绘制格式；排序、父子关系、范围外父级标题/深度及输出顺序不变；PNG 和资源策略不变 |
| A15（编码） | 后台离线资源调用既有 `stickerStore.bytesToBase64`，删除第二份编码函数 | 同样分块算法、字节输入、data URL 和失败行为 |
| A16 | 设置定位全部收为 `open-settings-at {hash}`，白名单包含 `externalSearchEngine/libraryWebdavUrl/stickerOrigins/topicExportOffline`；删除两个专用消息/处理器 | 所有原授权按钮、设置目标及失败提示仍可达；后台消息由 29 减至 27，用户功能没有删除 |
| A16（公开面） | settings 不再导出 `defaultSettings/normalizeRules/settingKeys/allowedCustomCssProperties`；library-store 不导出 `folderId`；user-marks 不导出 `validate/maxEntries`；webdav 仅导出 `createWebdavApi`；media 不导出 `teardown` | 全仓无外部调用后才取消发布；内部使用的函数、容量约束、清理与校验仍在 |
| A17（签名） | `stickerList(message,sender)` 与统一分发签名一致 | options/站点两个现有入口保持；沿用原来源政策，只纠正实参错位，不改变权限配置 |

### 11.2 保持原状的部分

- A4 的回应异步链、A5 的系统事件导出表达、A7 的设置同步优先级与版本元数据、A8 的 Header 两个用户选项、A9 的跨页预算、A10 的失败策略、A11 的调度、A14 的去重算法保持原状。这些涉及既有可观察行为/状态机，不能把“收敛”当作改语义授权。
- A6 的跨轮快照/观察器、A12 的重复读取、A15 的其余校验/链接复用及 A17 分组 ensure 通知仍有后续空间；本轮只移除可直接证明等价的重复，不以新增接口补齐审计清单。
- 配置、CSS、HTML、用户存储格式及正式版本未改；不移除模式，不迁移数据，不改变请求预算或树的几何/阅读行为。

### 11.3 证据与未验状态

- 使用现有 JavaScript 语法检查、差异检查、静态调用/协议回读和固定包直接字节比较；这些说明源码/交付包的一致性，不能证明运行交互完全等价。
- 未运行任何行为/回归/性能测试或浏览器验收；用户当前 Firefox 是否重载及真实长帖、回应、导出交互保持明确未验。具体检查输出、修正与提交信息记录在 `.pi/tasks/2026-10-17-equivalent-convergence/task.md`。
