/*
 * betterLD · 帖子分享图（Canvas 排版 PNG）
 *
 * 无依赖 / 无网络 / 无权限：模块只做 Canvas 排版与 PNG 编码。
 * 正文图片、媒体封面与头像统一经调用方传入的 loadImage(url) -> dataURL 取回，
 * 再由 Image 解码；模块自身不发起请求、不读扩展 API、不碰 storage。
 * 排版参数逐项读调用方传入的 settings（config.topicExport.imageShare），不设隐式默认值。
 * 头像 avatar_template 由调用方保证为绝对 URL，其中 {size} 占位替换为 avatarSize。
 *
 * render 契约：
 *   await render({ topic, posts, loadImage, signal, onProgress, settings }) => [{ blob, width, height }]
 *     topic     { id, title }
 *     posts     原站 post 对象数组（按楼层顺序）。必需：cooked（资源已绝对化的 cooked HTML）、
 *               post_number、post_url（绝对原帖地址）；可选：name、username、
 *               avatar_template（绝对 URL，可含 {size} 占位，也可为 dataURL）
 *     loadImage async (url) => dataURL，调用方桥接既有后台离线加载；模块自身不发请求
 *     signal    AbortSignal；取消抛 DOMException("AbortError")，不返回半结果
 *     onProgress ({ stage: "posts" | "pages", done, total }) => void
 *     settings  config.topicExport.imageShare，逐项显式读取，缺项直接报错，不设默认值：
 *               width maxHeight padding fontSize lineHeight titleFontSize headingFontSize
 *               avatarSize imageMaxHeight gap bg text primary muted
 *   返回一页一项，blob 为 image/png，单页高度不超过 maxHeight。
 *   失败一律 throw：图片加载/解码失败（含楼层与原帖 URL）、缺 post_url、
 *   maxHeight 容不下页头页脚与一行正文、canvas.toBlob 空结果、用户取消。
 *   超长内容拆页不截断：图片按源图切片，表格逐行且行内按文本行，段落/列表/代码块按行，
 *   标题行数超过单页头部容量时多余标题行转为首屏正文继续排页。
 *   已知限制：img.emoji 与宽高均 ≤ 32 的小图按 alt 文本行内呈现（不下载、不占块）；
 *   其余图片按块级排版，按原尺寸与内容宽度取小者，不放大；
 *   table 不合并 colspan/rowspan，每个 cell 等宽成列，正文块按行与图片切片排版（非原站截图）；
 *   imageMaxHeight 限制单个图片切片高度；正文图片保持宽度比例，不压缩整张长图的高度；
 *   代码块与引用块背景由 muted 低透明度叠加；
 *   grapheme 切分用 Intl.Segmenter（Chrome 87+ / Firefox 125+），不提供回退实现。
 */
(() => {
  "use strict";

  const FONT_FAMILY = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  const MONO_FAMILY = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
  const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const SKIP_TAGS = new Set(["script", "style", "nav", "button"]);
  const BREAK_AFTER = /[\s\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFF60\uAC00-\uD7AF]/;
  const AVATAR_SIZE_KEY = "{size}";
  const INLINE_IMAGE_MAX_SIZE = 32;
  const SPOILER_TEXT = "【剧透内容】";
  const COLLAPSED_HINT = "（折叠内容未展开）";
  const MEDIA_LABELS = Object.freeze({ video: "视频", audio: "音频", iframe: "嵌入页面" });
  const BLOCK_QUOTE_TAGS = new Set(["blockquote", "aside"]);
  const BLOCK_TAGS = new Set(["p", "div", "section", "article", "figure", "figcaption"]);
  const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
  const INLINE_TAGS = new Set(["span", "small", "mark", "u", "del", "s", "strike", "sub", "sup", "abbr", "time", "font"]);
  const BOLD_TAGS = new Set(["strong", "b"]);
  const ITALIC_TAGS = new Set(["em", "i"]);
  const MONO_TAGS = new Set(["code", "kbd", "samp", "tt"]);
  const BOX_ALPHA = 0.12;
  const GRID_ALPHA = 0.5;
  const RULE_ALPHA = 0.35;

  function checkAborted(signal) {
    if (signal && signal.aborted) throw new DOMException("分享图生成已取消", "AbortError");
  }

  // 取消立即结束本地等待；调用方的后台请求生命周期仍归调用方管理。
  function waitForAbort(promise, signal, onAbort) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        onAbort?.();
        reject(new DOMException("分享图生成已取消", "AbortError"));
      };
      promise.then((value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      }, (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  function graphemes(text) {
    const parts = [];
    for (const part of SEGMENTER.segment(text)) parts.push(part.segment);
    return parts;
  }

  function fontOf(item) {
    const family = item.mono ? MONO_FAMILY : FONT_FAMILY;
    return `${item.italic ? "italic " : ""}${item.bold ? "700" : "400"} ${item.size}px ${family}`;
  }

  function textWidth(ctx, style, text) {
    ctx.font = fontOf(style);
    return ctx.measureText(text).width;
  }

  function baseStyle(layout) {
    return { bold: false, italic: false, mono: false, size: layout.fontSize, color: layout.text, underline: false };
  }

  function run(layout, text, overrides) {
    return { ...baseStyle(layout), ...overrides, text };
  }

  function buildLayout(settings) {
    const { width, maxHeight, padding, fontSize, lineHeight, titleFontSize, headingFontSize, avatarSize, imageMaxHeight, gap, bg, text, primary, muted } = settings;
    const ratio = lineHeight / fontSize;
    const quoteBarWidth = Math.round(gap / 4);
    return {
      width, maxHeight, padding, fontSize, lineHeight, titleFontSize, headingFontSize, avatarSize, imageMaxHeight, gap, bg, text, primary, muted,
      ratio,
      contentWidth: width - padding * 2,
      titleLineHeight: Math.round(titleFontSize * ratio),
      headingLineHeight: Math.round(headingFontSize * ratio),
      cellPadding: Math.round(gap / 2),
      codePadding: Math.round(gap / 2),
      blockGap: Math.round(gap / 2),
      quoteBarWidth,
      quoteIndent: quoteBarWidth + Math.round(gap / 2),
      listIndent: Math.round(fontSize * 1.5),
      footerHeight: lineHeight,
      boxAlpha: BOX_ALPHA,
      gridAlpha: GRID_ALPHA,
      ruleAlpha: RULE_ALPHA
    };
  }

  // ---- 文本排版 ----

  function unitsOf(runs) {
    const units = [];
    for (const style of runs) {
      if (style.br) {
        units.push({ style, text: "\n" });
        continue;
      }
      for (const part of graphemes(style.text)) units.push({ style, text: part });
    }
    return units;
  }

  function mergeUnits(units) {
    const merged = [];
    for (const unit of units) {
      const last = merged[merged.length - 1];
      if (last && last.style === unit.style) last.text += unit.text;
      else merged.push({ style: unit.style, text: unit.text });
    }
    return merged;
  }

  function wrapRuns(ctx, runs, maxWidth) {
    const lines = [];
    let current = [];
    let currentWidth = 0;
    for (const unit of unitsOf(runs)) {
      if (unit.text === "\n") {
        lines.push(current);
        current = [];
        currentWidth = 0;
        continue;
      }
      const unitWidth = textWidth(ctx, unit.style, unit.text);
      if (unitWidth > maxWidth) throw new Error("分享图：文本区域过窄，无法完整绘制字符");
      while (current.length && currentWidth + unitWidth > maxWidth) {
        let cut = -1;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (BREAK_AFTER.test(current[index].text)) {
            cut = index + 1;
            break;
          }
        }
        if (cut <= 0) cut = current.length;
        const head = current.slice(0, cut);
        while (head.length && !head[head.length - 1].text.trim()) head.pop();
        lines.push(head);
        current = current.slice(cut);
        currentWidth = current.reduce((sum, item) => sum + textWidth(ctx, item.style, item.text), 0);
      }
      current.push(unit);
      currentWidth += unitWidth;
    }
    lines.push(current);
    return lines.map(mergeUnits);
  }

  function wrapCode(ctx, text, maxWidth, style) {
    const lines = [];
    for (const source of text.replace(/\n+$/, "").split("\n")) {
      let current = [];
      let currentWidth = 0;
      for (const part of graphemes(source)) {
        const partWidth = textWidth(ctx, style, part);
        if (partWidth > maxWidth) throw new Error("分享图：代码区域过窄，无法完整绘制字符");
        if (current.length && currentWidth + partWidth > maxWidth) {
          lines.push(current);
          current = [];
          currentWidth = 0;
        }
        current.push({ style, text: part });
        currentWidth += partWidth;
      }
      lines.push(current);
    }
    return lines.map(mergeUnits);
  }

  function runsWidth(ctx, runs) {
    return runs.reduce((sum, piece) => sum + textWidth(ctx, piece.style, piece.text), 0);
  }

  // ---- cooked HTML 解析 ----

  function createBuilder() {
    return { blocks: [], runs: [], quote: false, indent: 0, heading: false };
  }

  function flush(builder) {
    if (builder.runs.some((style) => style.text.trim())) {
      builder.blocks.push({ type: "text", runs: builder.runs, quote: builder.quote, indent: builder.indent, heading: builder.heading });
    }
    builder.runs = [];
  }

  function pushText(builder, text, style) {
    if (!text) return;
    builder.runs.push({ ...style, text });
  }

  function isInlineImage(node) {
    if (node.classList.contains("emoji")) return true;
    return ["width", "height"].every((attribute) => {
      const value = Number(node.getAttribute(attribute));
      return value > 0 && value <= INLINE_IMAGE_MAX_SIZE;
    });
  }

  function parseCooked(html, layout, postRef, postUrl) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    const builder = createBuilder();
    builder.postRef = postRef;
    builder.postUrl = postUrl;
    walkChildren(doc.body.firstElementChild, builder, baseStyle(layout), layout);
    flush(builder);
    return builder.blocks;
  }

  function walkChildren(node, builder, style, layout) {
    for (const child of [...node.childNodes]) walkNode(child, builder, style, layout);
  }

  function isOmitted(node) {
    return node.hidden || node.getAttribute("aria-hidden") === "true"
      || node.style.display === "none" || node.style.visibility === "hidden"
      || SKIP_TAGS.has(node.tagName.toLowerCase());
  }

  // pre 保留空白，同时复用隐藏语义，避免 textContent 穿透隐藏子节点。
  function visibleText(node, includeImageAlt = true) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE || isOmitted(node)) return "";
    if (node.classList.contains("spoiler")) return SPOILER_TEXT;
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return includeImageAlt ? node.getAttribute("alt") || "" : "";
    if (node.tagName === "DETAILS") {
      const summary = node.querySelector(":scope > summary");
      return (summary ? visibleText(summary, includeImageAlt) : "") + COLLAPSED_HINT;
    }
    return [...node.childNodes].map((child) => visibleText(child, includeImageAlt)).join("");
  }

  function resourceUrl(value, builder) {
    return new URL(value, builder.postUrl).href;
  }

  function imageSource(node, builder) {
    const direct = node.getAttribute("data-src") || node.getAttribute("src");
    if (direct) return resourceUrl(direct, builder);
    const sources = node.closest("picture")?.querySelectorAll("source") || [];
    const candidates = [node, ...sources].flatMap((source) => {
      const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
      return srcset.split(",").map((candidate) => {
        const [url, descriptor] = candidate.trim().split(/\s+/);
        return { url, weight: Number.parseFloat(descriptor || "0") };
      }).filter((candidate) => candidate.url);
    });
    candidates.sort((first, second) => second.weight - first.weight);
    if (candidates.length) return resourceUrl(candidates[0].url, builder);
    throw new Error(`分享图：图片缺少资源地址（${builder.postRef}）`);
  }

  function walkNode(node, builder, style, layout) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(builder, node.nodeValue.replace(/\s+/g, " "), style);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (isOmitted(node)) return;

    const tag = node.tagName.toLowerCase();
    if (node.classList.contains("spoiler")) {
      pushText(builder, SPOILER_TEXT, { ...style, bold: true, color: layout.muted });
      return;
    }
    if (node.classList.contains("video-placeholder-container")) {
      const src = node.dataset.videoSrc;
      if (!src) throw new Error(`分享图：上传视频缺少原站媒体地址（${builder.postRef}）`);
      flush(builder);
      builder.blocks.push({ type: "media", label: MEDIA_LABELS.video, url: resourceUrl(src, builder),
        poster: node.dataset.thumbnailSrc ? resourceUrl(node.dataset.thumbnailSrc, builder) : "" });
      return;
    }

    if (node.matches(".lazy-video, .lazy-video-container, .lazyYT, .lazyYT-container")) {
      const src = node.getAttribute("data-video-src") || node.getAttribute("data-src")
        || node.getAttribute("href") || node.querySelector("a[href]")?.getAttribute("href");
      if (!src) throw new Error(`分享图：外部播放器缺少媒体链接（${builder.postRef}）`);
      flush(builder);
      const thumbnail = node.querySelector("img");
      builder.blocks.push({ type: "media", label: MEDIA_LABELS.video, url: resourceUrl(src, builder),
        poster: thumbnail && !isOmitted(thumbnail) && !thumbnail.classList.contains("spoiler")
          ? imageSource(thumbnail, builder) : "" });
      return;
    }

    if (tag === "br") {
      pushText(builder, "\n", style);
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush(builder);
      walkChildren(node, builder, style, layout);
      flush(builder);
      return;
    }
    if (BLOCK_QUOTE_TAGS.has(tag)) {
      flush(builder);
      const quote = builder.quote;
      builder.quote = true;
      walkChildren(node, builder, { ...style, color: layout.muted }, layout);
      flush(builder);
      builder.quote = quote;
      return;
    }
    if (HEADING_TAGS.has(tag)) {
      flush(builder);
      const heading = builder.heading;
      builder.heading = true;
      walkChildren(node, builder, { ...style, bold: true, size: layout.headingFontSize, color: layout.primary }, layout);
      flush(builder);
      builder.heading = heading;
      return;
    }
    if (tag === "ul" || tag === "ol") {
      flush(builder);
      renderList(node, builder, style, layout, tag === "ol", 0);
      flush(builder);
      return;
    }
    if (tag === "img") {
      if (isInlineImage(node)) {
        const alt = (node.getAttribute("alt") || "").trim();
        if (alt) pushText(builder, alt, style);
        return;
      }
      const src = imageSource(node, builder);
      flush(builder);
      builder.blocks.push({ type: "image", src });
      return;
    }
    if (tag === "pre") {
      flush(builder);
      builder.blocks.push({ type: "code", text: visibleText(node) });
      return;
    }
    if (tag === "table") {
      flush(builder);
      builder.blocks.push({ type: "table", rows: readTable(node, style, layout, builder) });
      return;
    }
    if (tag === "details") {
      flush(builder);
      const summary = node.querySelector(":scope > summary");
      if (summary) walkNode(summary, builder, { ...style, bold: true }, layout);
      pushText(builder, COLLAPSED_HINT, { ...style, color: layout.muted });
      flush(builder);
      return;
    }
    if (tag === "video" || tag === "audio") {
      const childSource = node.querySelector("source");
      const source = node.getAttribute("data-src") || node.getAttribute("src")
        || childSource?.getAttribute("data-src") || childSource?.getAttribute("src");
      if (!source) throw new Error(`分享图：${MEDIA_LABELS[tag]}缺少资源地址（${builder.postRef}）`);
      flush(builder);
      const poster = node.getAttribute("poster");
      builder.blocks.push({ type: "media", label: MEDIA_LABELS[tag], url: resourceUrl(source, builder),
        poster: poster ? resourceUrl(poster, builder) : "" });
      return;
    }
    if (tag === "iframe") {
      const src = node.getAttribute("data-src") || node.getAttribute("src");
      if (!src) throw new Error(`分享图：嵌入页面缺少资源地址（${builder.postRef}）`);
      flush(builder);
      builder.blocks.push({ type: "media", label: MEDIA_LABELS.iframe, url: resourceUrl(src, builder), poster: "" });
      return;
    }
    if (tag === "a") {
      const href = node.getAttribute("href");
      if (!href) {
        walkChildren(node, builder, style, layout);
        return;
      }
      walkChildren(node, builder, { ...style, color: layout.primary, underline: true }, layout);
      const label = visibleText(node, false).replace(/\s+/g, " ").trim();
      if (!(node.querySelector("img") && !label) && label !== href
        && !node.matches(".lightbox")) {
        pushText(builder, ` ${resourceUrl(href, builder)}`, { ...style, color: layout.muted });
      }
      return;
    }
    if (BOLD_TAGS.has(tag)) {
      walkChildren(node, builder, { ...style, bold: true }, layout);
      return;
    }
    if (ITALIC_TAGS.has(tag)) {
      walkChildren(node, builder, { ...style, italic: true }, layout);
      return;
    }
    if (MONO_TAGS.has(tag)) {
      walkChildren(node, builder, { ...style, mono: true }, layout);
      return;
    }
    if (INLINE_TAGS.has(tag)) {
      walkChildren(node, builder, style, layout);
      return;
    }
    walkChildren(node, builder, style, layout);
  }

  function renderList(list, builder, style, layout, ordered, depth) {
    const startAttr = list.getAttribute("start");
    let markerIndex = startAttr ? Number(startAttr) : 1;
    const outerIndent = builder.indent;
    for (const item of list.children) {
      if (item.tagName.toLowerCase() !== "li") continue;
      if (isOmitted(item)) { markerIndex += 1; continue; }
      if (item.classList.contains("spoiler")) {
        pushText(builder, SPOILER_TEXT, { ...style, color: layout.muted });
        flush(builder);
        markerIndex += 1;
        continue;
      }
      builder.indent = layout.listIndent * (depth + 1);
      pushText(builder, ordered ? `${markerIndex}. ` : "• ", style);
      markerIndex += 1;
      for (const child of [...item.childNodes]) {
        const childTag = child.nodeType === Node.ELEMENT_NODE ? child.tagName.toLowerCase() : "";
        if (childTag === "ul" || childTag === "ol") continue;
        walkNode(child, builder, style, layout);
      }
      flush(builder);
      for (const child of [...item.children]) {
        const childTag = child.tagName.toLowerCase();
        if (childTag === "ul" || childTag === "ol") {
          if (isOmitted(child)) continue;
          if (child.classList.contains("spoiler")) {
            pushText(builder, SPOILER_TEXT, { ...style, color: layout.muted });
            flush(builder);
          } else renderList(child, builder, style, layout, childTag === "ol", depth + 1);
        }
      }
      builder.indent = outerIndent;
    }
  }

  function readTable(table, style, layout, parentBuilder) {
    const rows = [];
    for (const row of table.querySelectorAll("tr")) {
      if (row.closest("table") !== table || isOmitted(row)
        || row.parentElement !== table && isOmitted(row.parentElement)) continue;
      const cells = [];
      for (const cell of row.children) {
        const tag = cell.tagName.toLowerCase();
        if (tag !== "td" && tag !== "th") continue;
        const cellBuilder = createBuilder();
        cellBuilder.postRef = parentBuilder.postRef;
        cellBuilder.postUrl = parentBuilder.postUrl;
        if (!isOmitted(cell)) {
          if (cell.classList.contains("spoiler") || row.classList.contains("spoiler")
            || row.parentElement.classList.contains("spoiler")) {
            pushText(cellBuilder, SPOILER_TEXT, { ...style, color: layout.muted });
          } else walkChildren(cell, cellBuilder, tag === "th" ? { ...style, bold: true } : style, layout);
        }
        flush(cellBuilder);
        cells.push({ blocks: cellBuilder.blocks, align: cell.getAttribute("align") || "left" });
      }
      if (cells.length) rows.push({ cells });
    }
    return rows;
  }

  // ---- 内容项 ----

  async function decode(deps, url, postRef) {
    if (!deps.images.has(url)) {
      deps.images.set(url, (async () => {
        let dataUrl;
        try {
          checkAborted(deps.signal);
          dataUrl = await waitForAbort(deps.loadImage(url), deps.signal);
        } catch (error) {
          if (error.name === "AbortError") throw error;
          error.message = `分享图：图片加载失败 ${url}（${postRef}）：${error.message}`;
          throw error;
        }
        checkAborted(deps.signal);
        const image = new Image();
        const decoding = new Promise((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`分享图：图片解码失败 ${url}（${postRef}）`));
          image.src = dataUrl;
        });
        try {
          await waitForAbort(decoding, deps.signal, () => image.removeAttribute("src"));
          checkAborted(deps.signal);
        } finally {
          image.onload = null;
          image.onerror = null;
        }
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          throw new Error(`分享图：图片没有可绘制尺寸 ${url}（${postRef}）`);
        }
        return image;
      })());
    }
    return deps.images.get(url);
  }

  function imageItem(view, image) {
    const { layout } = view;
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    const width = Math.min(layout.contentWidth, naturalWidth);
    const height = Math.max(1, Math.round(naturalHeight * (width / naturalWidth)));
    return {
      kind: "image", image, width, height, srcY: 0, srcHeight: naturalHeight,
      scale: naturalHeight / height, x: layout.padding + Math.round((layout.contentWidth - width) / 2)
    };
  }

  function lineItems(lines, options) {
    return lines.map((line) => ({
      kind: "line", runs: line, height: options.height, indent: options.indent, quote: options.quote, box: options.box
    }));
  }

  async function blockItems(view, block, deps, postRef) {
    const { layout, measure } = view;
    if (block.type === "text") {
      const indent = (block.quote ? layout.quoteIndent : 0) + block.indent;
      const lines = wrapRuns(measure, block.runs, layout.contentWidth - indent);
      const height = block.heading ? layout.headingLineHeight : layout.lineHeight;
      return lineItems(lines, { height, indent, quote: block.quote, box: null });
    }
    if (block.type === "code") {
      const codeStyle = run(layout, "", { mono: true });
      const lines = wrapCode(measure, block.text, layout.contentWidth - layout.codePadding * 2, codeStyle);
      return lineItems(lines, { height: layout.lineHeight, indent: layout.codePadding, quote: false, box: "code" });
    }
    if (block.type === "image") {
      let item = imageItem(view, await decode(deps, block.src, postRef));
      const slices = [];
      while (item.height > layout.imageMaxHeight) {
        checkAborted(deps.signal);
        const [head, tail] = splitImage(item, layout.imageMaxHeight);
        slices.push(head);
        item = tail;
      }
      slices.push(item);
      return slices;
    }
    if (block.type === "media") {
      const runs = [run(layout, `【${block.label}】`, { bold: true, color: layout.primary }), run(layout, block.url, { color: layout.muted })];
      const items = lineItems(wrapRuns(measure, runs, layout.contentWidth), { height: layout.lineHeight, indent: 0, quote: false, box: null });
      if (block.poster) items.push(...await blockItems(view, { type: "image", src: block.poster }, deps, postRef));
      return items;
    }
    if (block.type === "table") {
      return tableItems(view, block.rows, deps, postRef);
    }
    return [];
  }

  async function tableItems(view, rows, deps, postRef) {
    const { layout } = view;
    const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
    if (!columnCount) return [];
    const columnWidth = layout.contentWidth / columnCount;
    const cellLayout = { ...layout, width: columnWidth, padding: layout.cellPadding,
      contentWidth: columnWidth - layout.cellPadding * 2 };
    if (cellLayout.contentWidth <= 0) throw new Error(`分享图：表格列数过多，单元格没有正文宽度（${postRef}）`);
    const cellView = { ...view, layout: cellLayout };
    const items = [];
    for (const row of rows) {
      const cells = [];
      for (const [column, cell] of row.cells.entries()) {
        const contents = [];
        for (const block of cell.blocks) {
          checkAborted(deps.signal);
          if (contents.length) contents.push({ kind: "spacer", height: layout.blockGap });
          contents.push(...await blockItems(cellView, block, deps, postRef));
        }
        cells.push({ x: layout.padding + column * columnWidth, width: columnWidth,
          align: cell.align, contents, index: 0, layout: cellLayout });
      }
      const emptyCells = () => cells.map((cell) => ({ ...cell, item: null }));
      items.push({ kind: "table-line", cells: emptyCells(), height: layout.cellPadding, top: true, bottom: false });
      while (cells.some((cell) => cell.index < cell.contents.length)) {
        const current = cells.map((cell) => cell.contents[cell.index]);
        const height = Math.max(layout.lineHeight, ...current.filter((item) => item && item.kind !== "image").map((item) => item.height));
        const band = cells.map((cell, index) => {
          let item = current[index];
          if (item?.kind === "image" && item.height > height) {
            const [head, tail] = splitImage(item, height);
            item = head;
            cell.contents[cell.index] = tail;
          } else if (item) cell.index += 1;
          return { ...cell, item };
        });
        items.push({ kind: "table-line", cells: band, height, top: false, bottom: false });
      }
      items.push({ kind: "table-line", cells: emptyCells(), height: layout.cellPadding, top: false, bottom: true });
    }
    return items;
  }

  async function buildPostItems(view, post, deps) {
    const { layout, measure } = view;
    if (!post.post_url) throw new Error(`分享图：第 ${post.post_number} 楼缺少原站 post_url，无法生成原帖链接`);
    const postUrl = post.post_url;
    const postRef = `第 ${post.post_number} 楼 ${postUrl}`;
    const avatar = post.avatar_template
      ? await decode(deps, post.avatar_template.split(AVATAR_SIZE_KEY).join(String(layout.avatarSize)), postRef)
      : null;
    const textX = avatar ? layout.avatarSize + layout.gap : 0;
    const meta = [run(layout, post.name ? post.name : post.username, { bold: true })];
    if (post.username) meta.push(run(layout, ` @${post.username}`, { color: layout.muted }));
    meta.push(run(layout, ` · 第 ${post.post_number} 楼`, { color: layout.muted }));
    const lines = [
      ...wrapRuns(measure, meta, layout.contentWidth - textX),
      ...wrapRuns(measure, [run(layout, postUrl, { color: layout.muted })], layout.contentWidth - textX)
    ];
    const items = [{
      kind: "post-header", avatar, lines, textX,
      height: Math.max(layout.avatarSize, lines.length * layout.lineHeight) + layout.gap
    }];
    let first = true;
    for (const block of parseCooked(post.cooked, layout, postRef, postUrl)) {
      checkAborted(deps.signal);
      if (!first) items.push({ kind: "spacer", height: layout.blockGap });
      first = false;
      items.push(...await blockItems(view, block, deps, postRef));
    }
    return items;
  }

  async function buildItems(view, posts, deps) {
    const items = [];
    for (let index = 0; index < posts.length; index += 1) {
      checkAborted(deps.signal);
      items.push(...await buildPostItems(view, posts[index], deps));
      deps.onProgress?.({ stage: "posts", done: index + 1, total: posts.length });
    }
    return items;
  }

  // ---- 分页 ----

  function splitImage(item, height) {
    const sourceHeight = height * item.scale;
    return [
      { ...item, height, srcHeight: sourceHeight },
      { ...item, height: item.height - height, srcY: item.srcY + sourceHeight, srcHeight: item.srcHeight - sourceHeight }
    ];
  }

  function paginate(items, contentHeight, minSlice) {
    const pages = [];
    let page = [];
    let used = 0;
    let index = 0;
    while (index < items.length) {
      const item = items[index];
      const remaining = contentHeight - used;
      if (item.height <= remaining) {
        page.push(item);
        used += item.height;
        index += 1;
        continue;
      }
      if (item.kind === "image" && remaining >= minSlice) {
        const [head, tail] = splitImage(item, remaining);
        page.push(head);
        pages.push(page);
        page = [];
        used = 0;
        items[index] = tail;
        continue;
      }
      if (page.length) {
        pages.push(page);
        page = [];
        used = 0;
        continue;
      }
      if (item.kind === "image") {
        const [head, tail] = splitImage(item, contentHeight);
        pages.push([head]);
        items[index] = tail;
        continue;
      }
      throw new Error(`分享图：内容块高度 ${item.height}px 超过单页容量 ${contentHeight}px，无法排版`);
    }
    if (page.length) pages.push(page);
    return pages;
  }

  // ---- 绘制 ----

  function drawRuns(ctx, runs, x, baseline) {
    let cursor = x;
    ctx.textBaseline = "middle";
    for (const piece of runs) {
      ctx.font = fontOf(piece.style);
      ctx.fillStyle = piece.style.color;
      ctx.fillText(piece.text, cursor, baseline);
      const width = ctx.measureText(piece.text).width;
      if (piece.style.underline) ctx.fillRect(cursor, baseline + piece.style.size * 0.35, width, 1);
      cursor += width;
    }
  }

  function drawItem(ctx, item, y, layout) {
    if (item.kind === "line") {
      if (item.box === "code") {
        ctx.save();
        ctx.globalAlpha = layout.boxAlpha;
        ctx.fillStyle = layout.muted;
        ctx.fillRect(layout.padding, y, layout.contentWidth, item.height);
        ctx.restore();
      }
      if (item.quote) {
        ctx.fillStyle = layout.muted;
        ctx.fillRect(layout.padding, y, layout.quoteBarWidth, item.height);
      }
      drawRuns(ctx, item.runs, layout.padding + item.indent, y + item.height / 2);
      return;
    }
    if (item.kind === "image") {
      ctx.drawImage(item.image, 0, item.srcY, item.image.naturalWidth, item.srcHeight, item.x, y, item.width, item.height);
      return;
    }
    if (item.kind === "post-header") {
      if (item.avatar) ctx.drawImage(item.avatar, layout.padding, y, layout.avatarSize, layout.avatarSize);
      let cursor = y;
      for (const line of item.lines) {
        drawRuns(ctx, line, layout.padding + item.textX, cursor + layout.lineHeight / 2);
        cursor += layout.lineHeight;
      }
      ctx.save();
      ctx.globalAlpha = layout.ruleAlpha;
      ctx.fillStyle = layout.muted;
      ctx.fillRect(layout.padding, y + item.height - 1, layout.contentWidth, 1);
      ctx.restore();
      return;
    }
    if (item.kind === "table-line") {
      const left = layout.padding;
      const right = layout.padding + layout.contentWidth;
      ctx.save();
      ctx.globalAlpha = layout.gridAlpha;
      ctx.strokeStyle = layout.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const cell of item.cells) {
        ctx.moveTo(cell.x + 0.5, y);
        ctx.lineTo(cell.x + 0.5, y + item.height);
      }
      ctx.moveTo(right - 0.5, y);
      ctx.lineTo(right - 0.5, y + item.height);
      if (item.top) {
        ctx.moveTo(left, y + 0.5);
        ctx.lineTo(right, y + 0.5);
      }
      if (item.bottom) {
        ctx.moveTo(left, y + item.height - 0.5);
        ctx.lineTo(right, y + item.height - 0.5);
      }
      ctx.stroke();
      ctx.restore();
      ctx.textBaseline = "middle";
      for (const cell of item.cells) {
        if (!cell.item) continue;
        let offset = 0;
        if (cell.item.kind === "line") {
          const width = runsWidth(ctx, cell.item.runs);
          if (cell.align === "center") offset = (cell.layout.contentWidth - width) / 2 - cell.item.indent;
          if (cell.align === "right") offset = cell.layout.contentWidth - width - cell.item.indent;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(cell.x, y, cell.width, item.height);
        ctx.clip();
        ctx.translate(cell.x, y);
        const content = cell.item.kind === "line" ? { ...cell.item, indent: cell.item.indent + offset } : cell.item;
        drawItem(ctx, content, 0, cell.layout);
        ctx.restore();
      }
    }
  }

  function drawPage(view, page, titleLines, headerHeight, pageIndex, totalPages) {
    const { layout, canvas, ctx } = view;
    const contentHeight = page.reduce((sum, item) => sum + item.height, 0);
    const height = layout.padding * 2 + headerHeight + contentHeight + layout.gap * 2 + layout.footerHeight;
    canvas.width = layout.width;
    canvas.height = height;
    ctx.fillStyle = layout.bg;
    ctx.fillRect(0, 0, layout.width, height);
    let cursor = layout.padding;
    for (const line of titleLines) {
      drawRuns(ctx, line, layout.padding, cursor + layout.titleLineHeight / 2);
      cursor += layout.titleLineHeight;
    }
    ctx.save();
    ctx.globalAlpha = layout.ruleAlpha;
    ctx.fillStyle = layout.muted;
    ctx.fillRect(layout.padding, cursor + layout.gap / 2, layout.contentWidth, 1);
    ctx.restore();
    cursor = layout.padding + headerHeight + layout.gap;
    for (const item of page) {
      drawItem(ctx, item, cursor, layout);
      cursor += item.height;
    }
    ctx.font = fontOf(run(layout, "", { color: layout.muted }));
    ctx.fillStyle = layout.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`第 ${pageIndex + 1} / ${totalPages} 页`, layout.padding + layout.contentWidth, cursor + layout.gap + layout.footerHeight / 2);
    ctx.textAlign = "left";
    return height;
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("分享图：canvas.toBlob 返回空结果"));
      }, "image/png");
    });
  }

  async function render({ topic, posts, loadImage, signal, onProgress, settings }) {
    const layout = buildLayout(settings);
    const canvas = document.createElement("canvas");
    const view = { layout, canvas, ctx: canvas.getContext("2d"), measure: document.createElement("canvas").getContext("2d") };
    const images = new Map();
    const deps = { loadImage, signal, onProgress, images };
    try {
      checkAborted(signal);
      const items = await buildItems(view, posts, deps);
      const minContentHeight = items.reduce((height, item) => item.kind === "image" ? height : Math.max(height, item.height),
        Math.max(layout.lineHeight, layout.titleLineHeight));
      const titleLines = wrapRuns(view.measure, [run(layout, topic.title, { bold: true, size: layout.titleFontSize, color: layout.primary })], layout.contentWidth);
      // 页头还包含一段 gap；保留作者栏和溢出标题行的完整高度。
      const titleBudget = Math.max(1, Math.floor((layout.maxHeight - layout.padding * 2 - layout.gap * 3 - layout.footerHeight - minContentHeight) / layout.titleLineHeight));
      const headerLines = titleLines.slice(0, titleBudget);
      const headerHeight = headerLines.length * layout.titleLineHeight + layout.gap;
      const contentHeight = layout.maxHeight - layout.padding * 2 - headerHeight - layout.gap * 2 - layout.footerHeight;
      if (contentHeight < minContentHeight) throw new Error(`分享图：maxHeight ${layout.maxHeight}px 容不下页头、页脚与完整正文行或作者栏`);
      const overflowLines = titleLines.slice(titleBudget).map((line) => ({ kind: "line", runs: line, height: layout.titleLineHeight, indent: 0, quote: false, box: null }));
      const pages = paginate([...overflowLines, ...items], contentHeight, layout.lineHeight);
      const results = [];
      for (let index = 0; index < pages.length; index += 1) {
        checkAborted(signal);
        const height = drawPage(view, pages[index], headerLines, headerHeight, index, pages.length);
        const blob = await waitForAbort(toBlob(canvas), signal);
        checkAborted(signal);
        results.push({ blob, width: layout.width, height });
        onProgress?.({ stage: "pages", done: index + 1, total: pages.length });
      }
      return results;
    } finally {
      images.clear();
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  globalThis.BETTERLD_SHARE_IMAGE = Object.freeze({ render });
})();
