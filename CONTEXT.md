# Domain Context

## Terms

### betterLD
- **Definition**：面向 LinuxDo 用户的浏览器美化插件。
- **Rules/Invariants**：插件服务于当前用户的浏览体验，不改变 LinuxDo 服务端数据或其他用户看到的内容。

### Supported Browser
- **Definition**：betterLD 首版覆盖 Chrome 和 Firefox 浏览器的桌面视口。
- **Rules/Invariants**：两种浏览器的桌面端都属于首版交付范围；移动端不属于首版精确适配范围。

### LinuxDo Homepage
- **Definition**：用户打开 LinuxDo 后看到的论坛首页信息流区域，是首版改造的主要页面。
- **Rules/Invariants**：首页主题条目整体改造成响应式卡片网格；其他页面不自动视为首版同等范围。

### Homepage Topic Card
- **Definition**：首页信息流中展示一个帖子的可视化条目，包含内容预览、作者身份和帖子归属信息。
- **Rules/Invariants**：卡片保留帖子作者的 ID 和头像作为身份识别信息；回复数、最后活动时间等现有元信息以紧凑形式保留。
- **Rules/Invariants**：作者、活动时间、回复 / 点赞 / 浏览统计与参与者头像都取自站点自己已下载的列表数据（首屏预载 `#data-preloaded`，其余读原站当前列表路由的模型），卡片创建即可见，不为这些信息发 `/t/*.json`，只有列表数据覆盖不到的主题才退回逐主题请求；列表载荷缺字段时该项不渲染，不写 0 或占位文字。
- **Rules/Invariants**：卡片内容的显隐由各自独立的开关控制（头像、作者、分类、摘要、标签、元信息、未读、置顶、已看），其中元信息是总开关，
  回复数、点赞数、浏览数与活动时间是它内部的细分开关；细分开关只隐藏对应片段（`data-betterld-meta-part`、`data-betterld-stat`），不改变请求，也不制造替代数值；关闭摘要开关后列表页不再发任何正文预览请求，关闭元信息开关后回复数、活动时间与统计隐藏（统计与参与者的填充要求摘要或元信息至少一个开关为真）。

### Cover Content Area
- **Definition**：参考图中原本展示视频封面的上方大面积内容区域。
- **Rules/Invariants**：首版将该区域用于展示帖子标题和开头正文预览，而不是视频封面。

### Topic Title and Opening Excerpt
- **Definition**：帖子标题与帖子正文开头的一小段内容，作为首页卡片的主要预览内容。
- **Rules/Invariants**：标题和正文预览共同替代封面内容；正文预览是每个主题一次的首帖正文请求，排在共享队列里按阅读位置取（悬停、聚焦或抽屉对应的卡片最优先，视口内越靠上越先，视口外不排队），并按照预览区域的实际高度截断（上限 2400 字符）。

### Author Identity
- **Definition**：帖子的用户 ID 与头像组合，用于识别发帖人。
- **Rules/Invariants**：首版保留原有 ID 和头像，不用帖子内容替换身份信息。
- **Rules/Invariants**：作者 ID 同时是该用户的链接入口，指向 `/u/{username}` 用户主页；只有拿到真实用户名（ASCII 用户名形态）才生成链接，加载中/失败占位文案与显示名不生成链接，链接形态与参数由 `betterld.config.js` 的 `userProfilePath` 统一提供。
- **Rules/Invariants**：作者链接的点击不进入主题导航（不触发卡片的打开方式设置），也不改变卡片其余区域的原有链接行为。

### Adaptive Card Grid
- **Definition**：首页阅读卡按照可用桌面宽度自动排列的网格，网格最小列宽由设置 `cardMinSize` 控制；网格相关设置同样作用于阅读卡：`gridMode`（自适应列数，或按断点使用固定列数）、`gridGap`、`cardSideGutter`。
- **Rules/Invariants**：网格优先保持卡片可读性和稳定比例，再根据可用宽度调整列数。
- **Rules/Invariants**：`cardMinSize` 有三处耦合：① 网格 track 下限（阅读网格与搜索网格的 `minmax` 下限都用它）；② 基类 `.betterld-topic-card` 的 `min-height` 回退（默认 280px，阅读卡自身覆盖为 210px）；③ 浏览器不支持容器查询单位时缩放单位的回退值（`ratioPerWidth × cardMinSize`，不经过上限）。
- **Rules/Invariants**：阅读卡内部尺寸（标题 / 作者 / 元信息字号、内边距与间距、头像、徽标、菜单定位与触发按钮几何）按卡片自身内容盒宽度整体缩放（卡片 `container-type: inline-size`）：缩放单位 `--betterld-card-unit = min(0.0459 × 卡片内容盒宽, 22px)`，只有上限、无下限：卡片变窄时内容按比例缩小（现有卡宽下内容盒约 305px ≈ 14px，与改前固定尺寸逐项一致），每个尺寸 = 单位 × N（N = 改前固定 px ÷ 14）；比例与上限集中在 `betterld.config.js` 的 `cardScale`（`ratioPerWidth` / `maxPx`），经 `--betterld-card-unit-ratio`、`--betterld-card-unit-max` 注入。
- **Rules/Invariants**（例外：窄屏横幅分支）：`@media (max-width: 900px)` 下阅读卡高度固定为 `cardScale.narrowHeightPx`（经 `--betterld-reading-narrow-height` 注入，默认 250px）；内部单位 = `min(0.0459 × 卡片内容盒宽, 14px)`，上限为 `--betterld-reading-narrow-unit`（`cardScale.narrowUnitPx`，默认 14px = 改前该分支字号），卡片更宽也不超过 14px、更窄时同样按比例缩小。该媒体块里的单列网格只对 `gridMode=auto` 成立，`gridMode=fixed` 与搜索页在该断点仍可能多列、卡片可宽至约 860px，但高度固定。
- **Rules/Invariants**（例外：菜单）：阅读卡的菜单定位与触发按钮随卡缩放——top / right 0.857 单位、触发按钮宽高 2.571 单位、字号 1.571 单位；菜单弹层（panel / item）是浮层，保持固定 Material 3 尺寸（min-width 176px、item 最小高度 36px）。
- **Rules/Invariants**：标题 / 作者 / 元信息三条字号设置作用于阅读卡，在缩放单位基础上乘档位系数：标题 响应式 1.0（默认，不写规则）/ 小 0.86 / 标准 1.14 / 大 1.43；作者 小 0.857 / 标准 1.0（默认）/ 大 1.143；元信息 小 0.909 / 标准 1.0（默认）/ 大 1.091。

### Excerpt Failure State
- **Definition**：首帖正文无法读取时，首页卡片中对正文预览区域的可见替代状态。
- **Rules/Invariants**：保留帖子标题、作者和分区，并在正文区域展示占位状态；单个帖子失败不影响首页其他卡片。
- **Rules/Invariants**：撞上站点限流（429）或 Cloudflare 挑战时正文预览请求整体停发一段时间（挑战状态 10 分钟，限流按 `Retry-After`、上限同为 10 分钟），冷却截止时间写进 `storage.local`，同一浏览器里换页或重新打开页面都接着等。
- **Rules/Invariants**：冷却期间被拒的卡在正文区域显示 `站点正在限制正文请求，稍后自动重试`（状态为失败），冷却到期后自动整批复位并重排一次：失败状态与失败缓存一并清掉、不受普通失败的重试配额限制，视口内与视口下方一屏的卡立即排队，其余只复位状态、滚动进视口时照常加载。

### Card Navigation
- **Definition**：用户通过首页主题卡片进入对应原帖的行为。
- **Rules/Invariants**：整张卡片沿用原帖链接习惯，并保留右键、Ctrl/Cmd 点击和键盘新标签页等浏览器原生操作。
- **Rules/Invariants**：打开方式是一套共用取值，同时作用于主题卡片、主题导航与搜索链接：当前标签页、新标签页、后台标签页，
  以及两个条件取值（首页外开新标签页 / 仅首页开新标签页）；修饰键点击一律交回浏览器原生行为，取值解析只在 `linkOpenBehavior` 一处。

### Section Level
- **Definition**：帖子所属的一级分区名称，在作者 ID 下方以使用分区原色的 Material 3 风格 Chip 展示为帖子归属标识。
- **Rules/Invariants**：首版将参考图中原有的辅助标签位置改为展示一级分区名称；不把用户 Trust Level 当作分区信息。

### Visual Enhancement
- **Definition**：不改变帖子语义和身份信息，只改善页面视觉层次和氛围的效果集合。
- **Rules/Invariants**：首版默认启用可调整的背景图片、页面遮罩和模糊效果；背景图片的加载和呈现方式参考 BewlyCat；没有可用背景图片时仍保持可用的明暗对应渐变视觉。
- **Rules/Invariants**：背景、遮罩与 Header/Sidebar 这套壳层视觉在 betterLD 运行的所有 linux.do 页面生效，由唯一类 `body.betterld-shell` 界定，不按页面类型枚举；页面级类（首页/话题列表/分类/标签/搜索）只用于主题卡片、导航胶囊与分类盒子等页面级能力。
- **Rules/Invariants**：壳层页面里站点自带的页面级底板（`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`）必须透明，壁纸与遮罩在该区域可见。
- **Rules/Invariants**：壳层页面里站点的纯白表面一律换成两种 betterLD 材质面之一，不再保留站点自己的白底：站点内容卡片（原生主题表行、`.badge-card`、`.latest-topic-list-item`、`.user-main .details`、分类盒子 `.category-box`、标签面板、用户页 `.user-main`）用 `surface-rgb / 0.56` + 模糊 + betterLD 描边/圆角/阴影；浮层与输入控件（`.user-card/.group-card/.category-card`、`.select-kit-body`、`.fk-d-menu__inner-content`、`.d-modal__container`、`#dialog-holder .dialog-content`、`#reply-control`、搜索框、导航行的类别/标签下拉 header）用 `surface-container-rgb / 0.96（搜索框 0.82）`；站点标签胶囊 `a.discourse-tag.box` 沿用卡片标签写法（`surface-container-rgb / 0.58` + 999px 圆角 + betterLD 描边），不用站点的 `--primary-low` 灰底。新增站点组件时沿用这两种写法，不引入第三种白底。
- **Rules/Invariants**：站点自己的二级导航条（用户页 `.user-navigation .nav-pills`、私信页 `.messages-nav`）与主题列表导航共用同一套胶囊规则（选择器组写在一处，不复制声明）；站点按钮 `.btn-default`/`.btn-primary`/`.btn-danger` 统一为 betterLD 形态，只改背景、描边、圆角与文字色，保持原几何尺寸，`.btn-icon`/`.btn-flat`/`.btn-transparent` 不受影响。
- **Rules/Invariants**：站点用 `var(--d-content-background)` / `var(--secondary)` 画的整页底板都算壳层要处理的对象，已知清单：`#main-outlet`、`#main-outlet > :is(.regular, .container)`、`#main-outlet > * > .container`、`#list-area`、`#header-list-area`、`.list-controls`、`.search-container`、`.user-main`、`.user-content`、`.body-page`（静态文档页）、`#main-outlet.not-found-container`（404）、`.show-badge`（徽章详情）、`.login-fullpage`、`.container.group`（群组页）、`.latest-topic-list-item`、`.user-stream-item`、`.follow-stream-item`、`.badge-card`。聊天页（`.full-page-chat`、`.chat-message-container`、`.c-navbar-container`、`.chat-pinned-bar`、`.chat-channel-status`）与 AI 机器人输入区同样处理。第三方组件（如 `/upcoming-events` 的日历）与帖子正文内容元素（blockquote、代码块）保留自身观感。
- **Rules/Invariants**：主题列表所在容器（`#list-area` 与分类页的 `#header-list-area`）不保留站点自带的不透明灰色底板，壁纸与遮罩在该区域可见；列表区域内的站点组件（如分类盒子 `.category-box`）改用与 `.category-heading` 同一套 betterLD 半透明材质面，不用自己的不透明底色。

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
- **Definition**：首页主题卡片默认且唯一的 betterLD 展示形式，以略长的桌面端圆角矩形集中呈现标题、作者、头像、标签、Markdown 正文预览、互动数据和详情入口。
- **Rules/Invariants**：常规视口下为 1:√2 竖版卡（宽高比 0.7071 / 1），内部尺寸按卡片内容盒宽度整体缩放（缩放单位见 Adaptive Card Grid）；≤900px 视口走高度固定 250px 的横幅分支，使用该分支的上限单位（`--betterld-reading-narrow-unit`，卡片更窄时同样按比例缩小）。
- **Rules/Invariants**：它与原生主题列表共享帖子语义、作者身份和原帖导航；`topicListLayoutMode` 的另一个取值是原生列表（`native`），不再提供其它卡片形式；新安装或恢复默认时使用此形式。

### Markdown Opening Preview
- **Definition**：将主题首帖开头按 Markdown 语义呈现的卡片正文预览，保留段落、强调、链接、列表、引用和代码等内容层次。
- **Rules/Invariants**：核心范围包含标题、段落、加粗、斜体、链接、列表、引用、行内代码和围栏代码；预览服务于阅读和识别主题，不改变原帖内容；无法读取正文时保留标题、作者和分区信息，并展示可见占位状态。
- **Rules/Invariants**：正文与抽屉共用同一份本机缓存：每个主题一次请求，条目同时保存原站 `cooked` 与 Markdown，保留 7 天、最多 500 条；`cooked` 超过 32768 字符的条目不落盘、只留 Markdown 文本，抽屉对此退回 Markdown 渲染。

### Card Presentation Style
- **Definition**：用户为首页主题信息流选择的呈现方式，对应设置 `topicListLayoutMode`，枚举只有两个值：`reading`（Reading Topic Card）与 `native`（原生主题列表）。
- **Rules/Invariants**：新安装或恢复默认时选择 `reading`；切换呈现方式只改变布局与视觉层次，不改变主题数据、互动语义、链接行为或原生列表恢复能力；互动数据缺失时不制造替代数值。

### Incremental Topic Grid Update
- **Definition**：卡片网格跟随原站主题列表变化的方式：网格顺序镜像原站列表，同步时复用已有卡片节点，不重建整张网格。
- **Rules/Invariants**：网格顺序与原站主题列表一致；已渲染的卡片在同步中沿用同一节点（正文预览不重新加载，列表元信息按当前列表数据重填），只按原站顺序移动位置，只有未知主题才新建卡片；主题过滤规则对新卡与首批卡片一致生效；刷新入口是站点「查看 N 个新的或更新的话题」提示条（用户点击）以及操作栏刷新按钮与 `refreshTopics` 快捷键（触发同一次合并），刷新不重载页面；只有网格尚不存在、卡片呈现方式变更或进入新的主题列表时才重建整张网格。

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
- **Rules/Invariants**：页面内的即时入口（浮动操作栏的卡片样式切换按钮、搜索历史面板）只写同一份设置或同一份本机数据，不引入第二套状态；
  样式切换的取值顺序由 `config.settingsEnums.topicListLayoutMode` 决定，权威取值始终是 `topicListLayoutMode` 本身。

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
- **Rules/Invariants**：树状正文取代按时间排列的帖子流，不同时显示两份；未加载父帖的回复标明归属，加载后回归父帖。竖线止于最后一条可见子回复，没有可见子回复则不留尾线。滚动接近树末尾自动加载后续回复，失败时暂停并提供重试。作者名称默认同时显示昵称和用户名，也可只显示一种；头像打开原站用户卡片。每条回复可查看回应、点赞、复制链接、使用 Boost、更多操作与回复；点击点赞、长按选择原站开放的其他回应，两者均以原站结果为准；已选中某个回应时，再次点击该按钮取消当前回应，切换其他回应仍走选择器。楼内已有的 Boost 按原站形态显示在操作栏下方（沿用原站 `discourse-boosts` 类名与样式，无 Boost 时整块不渲染）；原站同一楼只会有一个 Boost 入口：没有 Boost 时在操作栏，已有 Boost 时在列表末尾。点击入口不会再切回原站视图，而是直接在该楼下方展开原站同款编辑器（当前用户头像 + 文本域 + 提交/取消，尺寸与素材继承原站插件 CSS），回车提交、Escape 或取消关闭；提交走原站 Boost 创建接口，成功后该楼立即出现新气泡且入口收为列表末尾。需要原站交互时可以返回树状视图。
- **Rules/Invariants**：楼层正文与楼内 Boost 内容按原站 cooked 原样呈现：服务端能下发的任何内容都不在树里被单独剔除或改写（含 B 站等 iframe 播放器、object/embed 嵌入、内联矢量图、表单、帖子自带样式，以及 data:/blob: 资源），避免出现「原站可见、树里消失」；显示的尺寸与行为同样以原站为准。
- **Rules/Invariants**：树内除按原站 cooked 原样呈现内容外，还按原站 DOM 复刻 Discourse 客户端的增强：`[!Type]±` callout 折叠、`spoiler` 剧透（点击/键盘显示）、`hashtag` 图标、代码块复制与全屏按钮、语法高亮（借用原站 highlight.js，经主世界桥接）、图片灯箱（树内浮层）；各增强幂等，树重建时随 cooked 重新应用。
- **Rules/Invariants**：引用有两种独立能力，都对齐原站：一是每个引用都带「展开/收起」按钮，展开时按 `data-topic`/`data-post` 取被引用帖的完整内容替换引用片段、收起时还原；二是内容高度超过 `replyTreeQuoteCollapseHeightPx` 的引用额外提供限高折叠。展开失败要可见并可重试。
