# Domain Context

## Terms

### betterLD
- **Definition**：面向 LinuxDo 用户的浏览器美化插件。
- **Rules/Invariants**：插件服务于当前用户的浏览体验，不改变 LinuxDo 服务端数据或其他用户看到的内容。

### Supported Browser
- **Definition**：betterLD 首版覆盖 Chrome 和 Firefox 浏览器的桌面视口。
- **Rules/Invariants**：两种浏览器的桌面端都属于首版交付范围；移动端不属于首版精确适配范围。

### LinuxDo Homepage
- **Definition**：论坛首页及最新、分类、标签等主题列表。
- **Rules/Invariants**：保留 Discourse 原生主题行、排序、分页和链接；在行内补充紧凑信息栏，用 Material 3 表面和状态层美化。

### Homepage Topic Card
- **Definition**：自 0.1.53 起首页阅读卡已停用，主题列表改用 `.betterld-topic-row` 增强原生行。
- **Rules/Invariants**：作者、头像、活动时间、回复/点赞/浏览与参与者都来自原站预载或当前路由模型，不发逐主题 JSON。缺字段保持缺失，不写占位、不自动请求。回复数按原站总楼数减首帖。
- **Rules/Invariants**：分类、标签、未读与置顶保留原生链接/控件；显隐开关与三条字号设置对列表生效，已看只来自本机访问记录。

### Cover Content Area
- **Definition**：旧首页卡片封面/正文区域已废弃；原生行只展示主题信息。

### Topic Title and Opening Excerpt
- **Definition**：首页只保留原生主题标题。搜索卡摘要直接来自原站搜索载荷。
- **Rules/Invariants**：首页不自动读取首帖，无滚动/停顿/悬停正文请求与自动重试。

### Author Identity
- **Definition**：帖子的用户 ID 与头像组合，用于识别发帖人。
- **Rules/Invariants**：首版保留原有 ID 和头像，不用帖子内容替换身份信息。
- **Rules/Invariants**：作者 ID 同时是该用户的链接入口，指向 `/u/{username}` 用户主页；只有拿到真实用户名（ASCII 用户名形态）才生成链接，加载中/失败占位文案与显示名不生成链接，链接形态与参数由 `betterld.config.js` 的 `userProfilePath` 统一提供。
- **Rules/Invariants**：作者链接的点击不进入主题导航（不触发卡片的打开方式设置），也不改变卡片其余区域的原有链接行为。

### Adaptive Card Grid
- **Definition**：网格、卡宽与缩放参数只用于可选的搜索结果卡片。
- **Rules/Invariants**：首页不再生成网格；搜索卡现有缩放尺寸保留，`gridMode/cardMinSize/gridGap/cardSideGutter/showTopicExcerpt` 设置集中在搜索分类。

### Excerpt Failure State
- **Definition**：首页已删除自动摘要与作者回退请求、缓存写入、冷却后重排。
- **Rules/Invariants**：树状回复等必要请求仍保留原站挑战/限速的跨页面冷却，不与列表元信息读取关联。旧摘要本机缓存不再读写，也不主动删除用户存储。

### Card Navigation
- **Definition**：原生标题及搜索卡保留浏览器修饰键、右键与键盘语义。
- **Rules/Invariants**：主题打开方式可选当前页、新标签页、后台、网页抽屉；首页行不再提供独立「预览」按钮，菜单保留预览。手动网页预览设置同站主题 iframe 的 src，关闭移除 src 并回焦触发链接；iframe 占满弹窗标题与底部操作之间的空间，不受原站 iframe 高度上限限制。仅插件标记 `data-betterld-topic-preview` 的同站 frame 运行 betterLD 样式与树状回复，其他帖子嵌入不接管。

### Section Level
- **Definition**：保留原站分类色、分类/标签链接与主题等级；不将 Trust Level 当作分区。

### Visual Enhancement
- **Definition**：不改变帖子语义和身份信息，只改善页面视觉层次和氛围的效果集合。
- **Rules/Invariants**：首版默认启用可调整的背景图片、页面遮罩和模糊效果；背景图片的加载和呈现方式参考 BewlyCat；没有可用背景图片时仍保持可用的明暗对应渐变视觉。
- **Rules/Invariants**：背景、遮罩与 Header/Sidebar 这套壳层视觉在 betterLD 运行的所有 linux.do 页面生效，由唯一类 `body.betterld-shell` 界定，不按页面类型枚举；页面级类（首页/话题列表/分类/标签/搜索）只用于主题卡片、导航胶囊与分类盒子等页面级能力。
- **Rules/Invariants**：壳层页面里站点自带的页面级底板（`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`）必须透明，壁纸与遮罩在该区域可见。
- **Rules/Invariants**：壳层页面里站点的纯白表面一律换成两种 betterLD 材质面之一，不再保留站点自己的白底：站点内容卡片（原生主题表行、`.badge-card`、`.latest-topic-list-item`、`.user-main .details`、分类盒子 `.category-box`、标签面板、用户页 `.user-main`）用 `surface-rgb / 0.56` + 模糊 + betterLD 描边/圆角/阴影；浮层与输入控件（`.user-card/.group-card/.category-card`、`.select-kit-body`、`.fk-d-menu__inner-content`、`.d-modal__container`、`#dialog-holder .dialog-content`、`#reply-control`、搜索框、导航行的类别/标签下拉 header）用 `surface-container-rgb / 0.96（搜索框 0.82）`；站点标签胶囊 `a.discourse-tag.box` 沿用卡片标签写法（`surface-container-rgb / 0.58` + 999px 圆角 + betterLD 描边），不用站点的 `--primary-low` 灰底。新增站点组件时沿用这两种写法，不引入第三种白底。
- **Rules/Invariants**：站点自己的二级导航条（用户页 `.user-navigation .nav-pills`、私信页 `.messages-nav`）与主题列表导航共用同一套胶囊规则（选择器组写在一处，不复制声明）；站点按钮 `.btn-default`/`.btn-primary`/`.btn-danger` 统一为 betterLD 形态，只改背景、描边、圆角与文字色，保持原几何尺寸，`.btn-icon`/`.btn-flat`/`.btn-transparent` 不受影响。
- **Rules/Invariants**：站点用 `var(--d-content-background)` / `var(--secondary)` 画的整页底板都算壳层要处理的对象，已知清单：`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`、`.list-controls`、`.search-container`、`.user-main`、`.user-content`、`.body-page`（静态文档页）、`#main-outlet.not-found-container`（404）、`.show-badge`（徽章详情）、`.login-fullpage`、`.container.group`（群组页）、`.latest-topic-list-item`、`.user-stream-item`、`.follow-stream-item`、`.badge-card`。聊天页（`.full-page-chat`、`.chat-message-container`、`.c-navbar-container`、`.chat-pinned-bar`、`.chat-channel-status`）与 AI 机器人输入区同样处理。第三方组件（如 `/upcoming-events` 的日历）与帖子正文内容元素（blockquote、代码块）保留自身观感。
- **Rules/Invariants**：主题列表所在容器（`#list-area` 与分类页的 `#header-list-area`）不保留站点自带的不透明灰色底板，壁纸与遮罩在该区域可见；列表区域内的站点组件（如分类盒子 `.category-box`）改用与 `.category-heading` 同一套 betterLD 半透明材质面，不用自己的不透明底色。
- **Rules/Invariants**：原站编辑器、通用弹窗/对话框/Toast、偏好表单和 select-kit、聊天容器/输入、AI 会话输入、徽章详情/登录注册/关注流复用这两种材质。只改变容器和控件观感，保持原尺寸、布局、焦点/禁用/错误/选中语义，不重建表单或改提交行为；普通按钮不覆盖组合按钮与帖子正文/预览/日历内的控件。
- **Rules/Invariants**：betterLD 自有设置/首页/主题/顶部/刷新/撤销刷新工具使用内联 Material SVG，不请求图标字体、不批量替换原站图标。默认字体范围 `own` 仅影响插件自有内容；用户选择 `managed` 后应用到全站壳层及原生控件，保留代码字体与第三方组件自身字体。

### BewlyCat Wallpaper Selection
- **Definition**：首页背景图片的来源选择模型，包含网站随机图片、内置图片和用户自定义图片 3 类来源。
- **Rules/Invariants**：用户可以从 3 类来源中选择首页背景；网站随机图片每天固定一张；自定义图片同时支持远程图片和本地图片；来源失效时回退到明暗对应的内置渐变；背景来源属于视觉设置，不改变帖子内容、链接和身份信息。

### Automatic Color Mode
- **Definition**：根据 LinuxDo 当前主题和设备系统偏好确定 betterLD 首页的浅色或深色视觉模式。
- **Rules/Invariants**：优先跟随 LinuxDo 当前主题，无法识别时跟随设备系统偏好；主题变化时背景、遮罩、卡片和文字的对比度随之切换。

### Real LinuxDo Homepage
- **Definition**：用户访问 `https://linux.do/` 时的真实首页信息流，而不是仅用于开发验证的静态页面。
- **Rules/Invariants**：真实 linux.do 是所有页面（列表、主题详情、用户、分类、标签、搜索等）上改造效果的验收基准，不用静态页面代替；betterLD 在真实页面上按页面类型启用对应的页面级能力，壳层视觉则全页面生效，不因离开首页而恢复站点原生外观。

### Reading Topic Card
- **Definition**：首页阅读卡已废弃；搜索结果可继续选择卡片形式，仅消费搜索结果自身的作者与摘要。

### Markdown Opening Preview
- **Definition**：首页已停用首帖 Markdown 预览。手动预览以真实网页为权威；Markdown 渲染器留给项目既有使用路径。

### Card Presentation Style
- **Definition**：`topicListLayoutMode` 只允许 `native`，旧 `reading` 设置读入后归一为 `native`。
- **Rules/Invariants**：不再提供首页布局切换按钮或下拉；首页采用 Material 3 原生列表。
- **Rules/Invariants**：首页与主题列表以整个浏览器视口中线居中；可见桌面侧栏两边对称预留空间，收起侧栏恢复列表宽度上限。新/更新话题提示按文字宽度收紧为居中胶囊，保留原站点击刷新与消息更新行为。

### Incremental Topic Grid Update
- **Definition**：主题行增量同步由 Discourse 管理，betterLD 幂等追加信息栏；搜索卡沿用既有增量网格。
- **Rules/Invariants**：原生模型刷新后重读数据、更新信息与过滤。插件信息栏变更不触发源列表同步，原站新增/重排/标题更新仍被观察；主题页标题与树同宽，以整个浏览器视口的物理中线（`innerWidth / 2`，含滚动条）居中；桌面两侧对称预留侧栏/时间轴空间，窄窗口时间轴独占一行。原生列表的背景、模糊与圆角统一绘制在单元格，行本身透明，展开菜单保持在后续行之上。刷新新行从插入起与增强行保持同一 table 布局、列显隐及材质归属；新增行同轮 DOM 提交幂等增强，不等待尾部防抖。

### Settings Window
- **Definition**：用户在 LinuxDo 页面上打开的 betterLD 设置界面，覆盖当前页面并集中呈现全部设置分类。
- **Rules/Invariants**：在当前页面内打开并保留页面上下文，用户不需要离开 LinuxDo；窗口承载全部设置分类，分类之间只切换视野，不改变已生效的设置值；窗口在视口内既水平也垂直居中，各断点下四周留出边距且分类栏不被视口裁切。

### Settings Category and Sub-category
- **Definition**：设置窗口内的两级分类，主分类界定设置所属的功能域，子分类在主分类内部进一步组织设置项。
- **Rules/Invariants**：每个设置项只属于一个子分类，并归属唯一主分类；分类只用于组织和定位设置项，不改变设置值、生效范围或保存结果。

### Settings Item
- **Definition**：设置窗口中最小的可调单元，由名称、说明和右侧控件组成。
- **Rules/Invariants**：名称与说明共同解释该项设置的作用；同一项设置在同一时刻只有一个控件，且控件始终反映当前生效值。

### Immediate Apply
- **Definition**：用户调整设置后立即作用于当前页面并持久化的生效方式。
- **Rules/Invariants**：任何设置项被调整后立即成为当前生效值，设置窗口不提供提交动作；破坏性操作（恢复默认、导入、清空搜索历史）必须保留独立确认；界面必须让「改动已生效」可见。
- **Rules/Invariants**：页面内即时入口只写同一份设置或本机数据，不引入第二套状态。

### Settings Search
- **Definition**：在设置窗口内按名称或关键词定位设置项的能力。
- **Rules/Invariants**：搜索只定位分类与设置项，不修改任何设置值；跨分类跳转后仍保留搜索关键字与结果上下文。

### Topic Sort
- **Definition**：话题列表的排序方式，可选 LinuxDo 默认的最新回复顺序，或按主题发布时间的倒序。
- **Rules/Invariants**：排序由 Discourse 服务端的 `order` 参数决定，不做前端重排，因此不改变分页语义、也不产生额外请求；取值映射只在 `betterld.config.js` 的 `topicSortOrders` 维护，`activity` 不写参数（`bumped_at` 倒序），`created` 写 `order=created`（`created_at` 倒序）；只接管 betterLD 自己写入的 `created` 取值，URL 上其它 `order` 一律不改；生效范围是所有话题列表页，但热门与最高保留各自的排序语义，个人空间 `/u/{name}/activity/topics` 也在范围内；Discourse 不提供按最后编辑时间排序，编辑首帖不改变 `bumped_at`。

### Topic Filter
- **Definition**：在 betterLD 卡片层按规则隐藏、淡化、高亮或只显示主题的能力，不改变 LinuxDo 原始查询与分页。
- **Rules/Invariants**：规则分为标题、分类、标签、作者四轴，另有优先级最高的白名单；四轴共用一种匹配方式（包含关键词 / 完整词匹配 / 正则表达式）；命中行为为隐藏、淡化、高亮或只显示；另有按活动天数的旧帖规则与按分类等级（Lv1–Lv3）的等级规则；规则组定义只在 `betterld.config.js` 的 `topicRuleGroups` 维护；正则模式下的非法表达式在保存时被拒绝；主题活动时间与作者取自站点自己的主题列表数据（首屏 `#data-preloaded`，其余读原站当前列表路由的模型，两者都不额外发请求），不解析页面上本地化的相对时间；子分类页面行内可能不渲染标签，标签规则在那里天然不命中。

### Filtered Topics Bin
- **Definition**：右下角浮层，列出当前页面被过滤隐藏的主题，支持单条还原与全部还原。
- **Rules/Invariants**：还原是页面级覆盖，不写入存储；规则集（行为、匹配方式、等级、天数、白名单与四轴规则）变化时覆盖自动失效，避免过滤器静默停摆；关闭垃圾桶后命中项在卡片构建阶段就不再生成。

### Server-side Ignore
- **Definition**：调用 Discourse 的 `PUT /u/{username}/notification_level.json` 在账号层面忽略某个用户。
- **Rules/Invariants**：只作为卡片菜单里的显式动作提供，执行前必须确认；默认不在菜单中显示，不做自动或批量屏蔽；未拿到作者用户名时不发起请求。

### WebDAV Rule Backup
- **Definition**：把五组筛选规则上传到 WebDAV 地址，或从该地址下载并追加到现有规则。
- **Rules/Invariants**：请求统一经后台 service worker 发出并按 origin 申请权限，不依赖页面 CORS；地址只接受 https，http 仅允许环回地址；WebDAV 密码只保存在本地，不进入浏览器同步投影与设置导出文件；下载采用追加 + 去重，不是覆盖。

### Watched Topic Mark
- **Definition**：卡片上的「已看」徒标，数据来自本机浏览记录（`visitedTopicStorageKey` 里的主题 id 列表，访问 `/t/{slug}/{id}` 时追加）。
- **Rules/Invariants**：只读本机记录，不读也不写 Discourse 的已读状态；列表不进入浏览器同步投影；超过 `visitedTopicMaxEntries` 时丢弃最早的记录；
  标记只按主题 id 匹配，不根据页面上的未读类名推断。

### Search History Panel
- **Definition**：搜索输入框聚焦时弹出的浮层，列出本机保存的搜索历史，支持回填、单条删除与清空全部。
- **Rules/Invariants**：数据源与搜索推荐词完全共用本机搜索历史，不请求站点的搜索建议接口；
  条目数量上限由 `searchHistoryPanelMaxItems` 决定；回填后仅当页面存在搜索表单时才自动提交，否则只填入输入框。

### Version Reminder
- **Definition**：关于页的「检查更新」动作，比对 GitHub Releases 的最新 tag 与本地 manifest 版本号，只做提示。
- **Rules/Invariants**：只在用户点击时请求一次，不做自动轮询、不自动更新；
  请求经后台 service worker 发出（设置窗口在页面内以 Shadow DOM 复用，页面环境直连不可靠），
  权限只限于 `host_permissions` 里声明的版本接口来源；请求失败只显示失败原因，不隐式降级为「已是最新」。

### Site Logo Style
- **Definition**：原站 Header 里站点 Logo（`#site-logo`）的显隐、描边与发光。
- **Rules/Invariants**：只改 `#site-logo` 自身（在这个站上它就是一个 `<img>`）的显隐与滤镜，不重建 Header 结构，也不影响其余 Header 内容。

### Topic Reply Tree
- **Definition**：主题详情页按父子关系组织多级回复的默认视图，父回复包含子回复，沿头像绘制可折叠的竖干与弧线分支。
- **Rules/Invariants**：树状正文取代按时间排列的帖子流，不同时显示两份；未加载父帖的回复标明归属，加载后回归父帖。竖线止于最后一条可见子回复，没有可见子回复则不留尾线。滚动接近树末尾自动加载后续回复，失败时暂停并提供重试。作者名称默认同时显示昵称和用户名，也可只显示一种；头像和作者名称打开原站用户卡片。每条回复可查看回应、点赞、复制链接、使用 Boost、更多操作与回复；点击点赞、长按选择原站开放的其他回应，两者均以原站结果为准；已选中某个回应时，再次点击该按钮取消当前回应，切换其他回应仍走选择器。楼内已有的 Boost 按原站形态显示在操作栏下方（沿用原站 `discourse-boosts` 类名与样式，无 Boost 时整块不渲染）；原站同一楼只会有一个 Boost 入口：没有 Boost 时在操作栏，已有 Boost 时在列表末尾。点击入口不会再切回原站视图，而是直接在该楼下方展开原站同款编辑器（当前用户头像 + 文本域 + 提交/取消，尺寸与素材继承原站插件 CSS），回车提交、Escape 或取消关闭；提交走原站 Boost 创建接口，成功后该楼立即出现新气泡且入口收为列表末尾。需要原站交互时可以返回树状视图。
- **Rules/Invariants**：楼层正文与楼内 Boost 内容按原站 cooked 原样呈现：服务端能下发的任何内容都不在树里被单独剔除或改写（含 B 站等 iframe 播放器、object/embed 嵌入、内联矢量图、表单、帖子自带样式，以及 data:/blob: 资源），避免出现「原站可见、树里消失」；显示的尺寸与行为同样以原站为准。
- **Rules/Invariants**：树内除按原站 cooked 原样呈现内容外，还按原站 DOM 复刻 Discourse 客户端的增强：`[!Type]±` callout 折叠、`spoiler` 剧透（点击/键盘显示）、`hashtag` 图标、代码块复制与全屏按钮、语法高亮（借用原站 highlight.js，经主世界桥接）、图片灯箱（树内浮层）；各增强幂等，树重建时随 cooked 重新应用。
- **Rules/Invariants**：引用有两种独立能力，都对齐原站：一是每个引用都带「展开/收起」按钮，展开时按 `data-topic`/`data-post` 取被引用帖的完整内容替换引用片段、收起时还原；二是内容高度超过 `replyTreeQuoteCollapseHeightPx` 的引用额外提供限高折叠。展开失败要可见并可重试。

### Reply Author Details
- **Definition**：树状回复保留原站作者头像徽章、状态表情、用户头衔与姓名旁整组 poster-icon 徽章。
- **Rules/Invariants**：四项独立按已有帖子数据呈现，缺项不留占位、不补发用户请求；覆盖首帖、任意嵌套与分页/实时载入的回复，与昵称/用户名显示模式独立。头像徽章位于头像右下角，复用原站 topic-avatar 样式、图标或图片、群组徽章解析与颜色，不推断原站未显示的身份徽章。作者栏按原站姓名 → 头衔 → 状态排列（保留 OP / ME）；头衔同字号并保留原站文本/群组类名、转换器和群组卡片链接。状态复用原站 UserStatusMessage 与 FloatKit，保留自定义 emoji、状态说明、按原站时区/语言格式化的到期时间及悬停/点击提示，键盘可操作；遵循原站 enable_user_status/enable_emoji。
- **Rules/Invariants**：主世界按楼复用原站 User 模型，原站未加载的分页楼层用已有 post 字段创建独立 User，不加入 postStream；跟踪原站状态事件与到期清除，状态取消以 null 清除旧值，缓存回写供树重建使用。无状态作者也订阅后续状态；每楼各自的头衔/群组快照不互相覆盖。树重建/离开话题清除 tooltip、监听、自建模型及同步签名，原站共享模型仅释放本树订阅。保留用户卡片入口及 OP / ME 标识，不添加设置开关或新的身份推断。

### External Search Supplement
- **Definition**：原站确认站内搜索为空后，按用户选择的 Bing 或 DuckDuckGo 补充检索并追加 `site:linux.do`，展示在当前搜索页。
- **Rules/Invariants**：默认关闭，启用时显式申请所选引擎权限；搜索词发送给该引擎。读取原站控制器的完成/错误/查询/结果状态，加载、失败、私信、用户或分类搜索不触发；外部结果只保留 HTTPS LinuxDo 主题链接，按主题 ID 去重，标题与摘要以文本渲染，标明外部索引。权限/挑战/结构/网络失败清晰显示，不自动换引擎或降为无结果。

### Local Topic Library
- **Definition**：右下角 Material 3 入口，按「稍后再看」「收藏」分类保存主题；首页行提供稍后再看，主题标题提供收藏。
- **Rules/Invariants**：`libraryStorageKey` 对应的 storage.local 是唯一数据源，与原站书签及浏览器同步设置独立；后台串行处理跨标签增删，成功写入后更新 UI，失败保留原数据并显示错误。面板可打开或移除主题，其他标签监听同一存储；插件预览内保留主题收藏，右下入口只在顶层渲染。

### Browser DoH Location
- **Definition**：高级 → 浏览器网络提供 Chrome 安全 DNS / Firefox 基于 HTTPS 的 DNS 的现有设置定位。
- **Rules/Invariants**：标准扩展不接管网页 DNS，不自行修改 DNS、代理或浏览器隐私配置；Chrome 可直达设置，Firefox 复制内部地址并提示准确路径。路径集中在 `browserDnsGuides`，受管理策略或浏览器限制时由用户自行选择配置。

### Reply Author Mark
- **Definition**：树状回复作者名旁用于识别话题发起人和当前用户本人的紧凑身份标识。
- **Rules/Invariants**：OP（Original Poster）代表首帖作者，只在其第 2 楼及后续楼层显示；ME 代表当前登录用户，在其全部楼层显示，包括本人首帖。同一楼层可并列显示 OP ME，顺序固定为 OP 在前。
- **Rules/Invariants**：身份以原站真实用户 ID 判定，与昵称/用户名的显示模式无关；身份缺失时不猜测，未登录时没有 ME。标识覆盖任意嵌套深度和后续加载的新回复，只标注作者身份，不改变回复内容或交互；自定义身份标识仅提供 OP / ME，原站头像徽章、用户状态与头衔按 Reply Author Details 独立保留。
