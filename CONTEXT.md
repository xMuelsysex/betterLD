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
- **Definition**：不改变帖子语义和身份信息，只改善页面视觉层次与氛围的效果集合。
- **Rules/Invariants**：首版默认启用可调整的背景图片、页面遮罩和模糊效果；背景图片的加载与呈现方式参考 BewlyCat；没有背景图片时仍保持可用的纯色视觉。
