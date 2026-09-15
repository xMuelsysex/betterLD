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

### Cover Content Area
- **Definition**：参考图中原本展示视频封面的上方大面积内容区域。
- **Rules/Invariants**：首版将该区域用于展示帖子标题和开头正文预览，而不是视频封面。

### Topic Title and Opening Excerpt
- **Definition**：帖子标题与帖子正文开头的一小段内容，作为首页卡片的主要预览内容。
- **Rules/Invariants**：标题和正文预览共同替代封面内容；正文以纯文本形式展示，卡片进入视口后按需加载，并按照预览区域的实际高度截断。

### Author Identity
- **Definition**：帖子的用户 ID 与头像组合，用于识别发帖人。
- **Rules/Invariants**：首版保留原有 ID 和头像，不用帖子内容替换身份信息。

### Adaptive Card Grid
- **Definition**：首页主题卡片按照可用桌面宽度自动排列的网格，单张卡片目标尺寸约为 350 × 350 像素。
- **Rules/Invariants**：网格优先保持卡片可读性和稳定比例，再根据可用宽度调整列数。

### Excerpt Failure State
- **Definition**：首帖正文无法读取时，首页卡片中对正文预览区域的可见替代状态。
- **Rules/Invariants**：保留帖子标题、作者和分区，并在正文区域展示占位状态；单个帖子失败不影响首页其他卡片。

### Card Navigation
- **Definition**：用户通过首页主题卡片进入对应原帖的行为。
- **Rules/Invariants**：整张卡片沿用原帖链接习惯，并保留右键、Ctrl/Cmd 点击和键盘新标签页等浏览器原生操作。

### Section Level
- **Definition**：帖子所属的一级分区名称，在作者 ID 下方以使用分区原色的 Material 3 风格 Chip 展示为帖子归属标识。
- **Rules/Invariants**：首版将参考图中原有的辅助标签位置改为展示一级分区名称；不把用户 Trust Level 当作分区信息。

### Visual Enhancement
- **Definition**：不改变帖子语义和身份信息，只改善页面视觉层次和氛围的效果集合。
- **Rules/Invariants**：首版默认启用可调整的背景图片、页面遮罩和模糊效果；背景图片的加载和呈现方式参考 BewlyCat；没有可用背景图片时仍保持可用的明暗对应渐变视觉。

### BewlyCat Wallpaper Selection
- **Definition**：首页背景图片的来源选择模型，包含网站随机图片、内置图片和用户自定义图片 3 类来源。
- **Rules/Invariants**：用户可以从 3 类来源中选择首页背景；网站随机图片每天固定一张；自定义图片同时支持远程图片和本地图片；来源失效时回退到明暗对应的内置渐变；背景来源属于视觉设置，不改变帖子内容、链接和身份信息。

### Automatic Color Mode
- **Definition**：根据 LinuxDo 当前主题和设备系统偏好确定 betterLD 首页的浅色或深色视觉模式。
- **Rules/Invariants**：优先跟随 LinuxDo 当前主题，无法识别时跟随设备系统偏好；主题变化时背景、遮罩、卡片和文字的对比度随之切换。

### Real LinuxDo Homepage
- **Definition**：用户访问 `https://linux.do/` 时的真实首页信息流，而不是仅用于开发验证的静态页面。
- **Rules/Invariants**：本轮首版改造只在真实首页启用；离开首页后恢复 LinuxDo 原页面结构。

### Reading Topic Card
- **Definition**：首页主题卡片的一种可选展示形式，以略长的桌面端圆角矩形集中呈现标题、作者、头像、标签、Markdown 正文预览、互动数据和详情入口。
- **Rules/Invariants**：它与现有主题卡片共享帖子语义、作者身份和原帖导航；用户可以在设置中选择展示形式；新安装或恢复默认时优先使用此形式。

### Markdown Opening Preview
- **Definition**：将主题首帖开头按 Markdown 语义呈现的卡片正文预览，保留段落、强调、链接、列表、引用和代码等内容层次。
- **Rules/Invariants**：核心范围包含标题、段落、加粗、斜体、链接、列表、引用、行内代码和围栏代码；预览服务于阅读和识别主题，不改变原帖内容；无法读取正文时保留标题、作者和分区信息，并展示可见占位状态。

### Card Presentation Style
- **Definition**：用户为首页主题信息流选择的卡片视觉呈现方式，包含现有卡片形式和 Reading Topic Card。
- **Rules/Invariants**：新安装或恢复默认时选择 Reading Topic Card；切换呈现方式只改变布局与视觉层次，不改变主题数据、互动语义、链接行为或原生列表恢复能力；互动数据缺失时不制造替代数值。

### Settings Window
- **Definition**：用户在 LinuxDo 页面上打开的 betterLD 设置界面，覆盖当前页面并集中呈现全部设置分类。
- **Rules/Invariants**：在当前页面内打开并保留页面上下文，用户不需要离开 LinuxDo；窗口承载全部设置分类，分类之间只切换视野，不改变已生效的设置值。

### Settings Category and Sub-category
- **Definition**：设置窗口内的两级分类，主分类界定设置所属的功能域，子分类在主分类内部进一步组织设置项。
- **Rules/Invariants**：每个设置项只属于一个子分类，并归属唯一主分类；分类只用于组织和定位设置项，不改变设置值、生效范围或保存结果。

### Settings Item
- **Definition**：设置窗口中最小的可调单元，由名称、说明和右侧控件组成。
- **Rules/Invariants**：名称与说明共同解释该项设置的作用；同一项设置在同一时刻只有一个控件，且控件始终反映当前生效值。

### Immediate Apply
- **Definition**：用户调整设置后立即作用于当前页面并持久化的生效方式。
- **Rules/Invariants**：任何设置项被调整后立即成为当前生效值，设置窗口不提供提交动作；破坏性操作（恢复默认、导入、清空搜索历史）必须保留独立确认；界面必须让「改动已生效」可见。

### Settings Search
- **Definition**：在设置窗口内按名称或关键词定位设置项的能力。
- **Rules/Invariants**：搜索只定位分类与设置项，不修改任何设置值；跨分类跳转后仍保留搜索关键字与结果上下文。

### Topic Filter
- **Definition**：在 betterLD 卡片层按规则隐藏、淡化或只显示主题的能力，不改变 LinuxDo 原始查询与分页。
- **Rules/Invariants**：规则分为标题、分类、标签、作者四轴，另有优先级最高的白名单；四轴共用一种匹配方式（包含关键词 / 完整词匹配 / 正则表达式）；命中行为为隐藏、淡化或只显示；规则组定义只在 `betterld.config.js` 的 `topicRuleGroups` 维护；正则模式下的非法表达式在保存时被拒绝；子分类页面行内可能不渲染标签，标签规则在那里天然不命中。
