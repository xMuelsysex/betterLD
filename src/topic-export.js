/*
 * betterLD · 帖子导出（HTML / Markdown）
 *
 * 转换模板、范围解析与 HTML→Markdown 渲染复用上游项目
 * Linux.do Export Markdown v1.1.1（commit 136e9d71b6f3e3c7c08a20aeffbdd3fedf7bcf15，
 * https://github.com/kai-wei-kfuse/Linuxdo-Export-Markdown），按 MIT 许可证使用，
 * 许可证全文如下：
 *
 * MIT License
 *
 * Copyright (c) 2026 kai-wei-kfuse
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * 相对上游的改动：
 * - 去掉 GM_download 与 fetch：主题数据由主会话通过 readTopic 提供，模块不再发请求；
 * - 去掉固定悬浮入口与 URL 轮询定时器，入口改由主会话 sync 驱动；
 * - 去掉下载失败回退（GM 失败后静默改用 a.download），只保留标准 Blob + a.download；
 * - 运行参数改读 config.topicExport；
 * - 入口与对话框在每个 frame 内就地渲染（预览 iframe 里也用同一个原生 dialog）；
 * - HTML 导出的 href / src / poster / srcset（含 template 内资源）按原主题 URL 解析绝对地址；
 * - Markdown 补 iframe / video / audio / table / details 的有意义表示。
 */
(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;

  const FORMAT_OPTIONS = Object.freeze([
    Object.freeze({ value: "html", label: "HTML" }),
    Object.freeze({ value: "markdown", label: "Markdown" })
  ]);
  const RANGE_OPTIONS = Object.freeze([
    Object.freeze({ value: "all", label: "全部回复" }),
    Object.freeze({ value: "post", label: "只导出主帖" }),
    Object.freeze({ value: "custom", label: "自定义楼层" })
  ]);
  const RANGE_LABELS = Object.freeze({ all: "全部回复", post: "主帖" });
  const MIME_TYPES = Object.freeze({ html: "text/html;charset=utf-8", markdown: "text/markdown;charset=utf-8" });
  const FILE_EXTENSIONS = Object.freeze({ html: "html", markdown: "md" });
  const RESOURCE_ATTRIBUTES = Object.freeze(["href", "src", "poster"]);
  const EMPTY_RANGE_HINT = "自定义楼层不能为空，例如：1,3-8";
  const REMOTE_ASSET_NOTE = "图片与媒体保留原站远程地址，打开导出文件需要联网；需要登录才能访问的资源可能无法显示。";

  const state = {
    topicId: "",
    title: "",
    readTopic: null,
    button: null,
    dialog: null,
    previousFocus: null
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- 入口按钮 ----

  function createButton() {
    const button = element("button", "betterld-export-trigger btn btn-icon-text btn-default topic-footer-button");
    button.type = "button";
    button.title = "把当前主题导出为 HTML 或 Markdown";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "fa d-icon svg-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z");
    svg.append(path);
    button.append(svg, element("span", "d-button-label", "导出"));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openDialog();
    });
    return button;
  }

  function buttonHost() {
    // 原站页脚操作栏是首选位置；页脚尚未装载时退到标题块，避免帖子中间没有入口。
    return document.querySelector("#topic-footer-buttons .topic-footer-main-buttons")
      || document.querySelector("#topic-title .title-wrapper");
  }

  function syncButton() {
    const host = buttonHost();
    if (!host) {
      state.button?.remove();
      state.button = null;
      return;
    }
    if (!state.button) state.button = createButton();
    state.button.dataset.betterldExportHost = host.matches(".title-wrapper") ? "title" : "footer";
    if (state.button.parentElement !== host) host.append(state.button);
  }

  // ---- 对话框 ----

  function selectControl(options) {
    const node = element("select", "betterld-export-select");
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      node.append(item);
    }
    return node;
  }

  function fieldControl(labelText, control) {
    const wrapper = element("label", "betterld-export-field");
    wrapper.append(element("span", "betterld-export-label", labelText), control);
    return wrapper;
  }

  function createDialogNodes() {
    const dialog = element("dialog", "betterld-export-dialog");
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-labelledby", "betterld-export-dialog-title");
    dialog.setAttribute("aria-describedby", "betterld-export-dialog-note");

    const form = element("form", "betterld-export-form");
    form.method = "dialog";
    form.noValidate = true;

    const title = element("h2", "betterld-export-title", "导出主题");
    title.id = "betterld-export-dialog-title";
    const subject = element("p", "betterld-export-subject", state.title);

    const formatSelect = selectControl(FORMAT_OPTIONS);
    const rangeSelect = selectControl(RANGE_OPTIONS);
    const customInput = element("input", "betterld-export-input");
    customInput.type = "text";
    customInput.placeholder = "例如：1,3-8";
    customInput.autocomplete = "off";
    customInput.setAttribute("aria-describedby", "betterld-export-dialog-error");
    const customField = fieldControl("自定义楼层", customInput);
    customField.hidden = true;

    const note = element("p", "betterld-export-note", REMOTE_ASSET_NOTE);
    note.id = "betterld-export-dialog-note";
    const progress = element("p", "betterld-export-progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    const error = element("p", "betterld-export-error");
    error.id = "betterld-export-dialog-error";
    error.setAttribute("role", "alert");

    const actions = element("div", "betterld-export-actions");
    const closeButton = element("button", "betterld-export-button", "关闭");
    closeButton.type = "button";
    const confirmButton = element("button", "betterld-export-button betterld-export-button--primary", "导出");
    confirmButton.type = "submit";
    actions.append(closeButton, confirmButton);

    form.append(title, subject, fieldControl("导出格式", formatSelect), fieldControl("导出范围", rangeSelect),
      customField, note, progress, error, actions);
    dialog.append(form);

    return {
      dialog,
      form,
      formatSelect,
      rangeSelect,
      customInput,
      customField,
      progress,
      error,
      closeButton,
      confirmButton,
      busy: false
    };
  }

  function syncCustomField(refs) {
    refs.customField.hidden = refs.rangeSelect.value !== "custom";
    refs.error.textContent = "";
    if (!refs.customField.hidden) refs.customInput.focus();
  }

  function setBusy(refs, busy) {
    refs.confirmButton.disabled = busy;
    refs.formatSelect.disabled = busy;
    refs.rangeSelect.disabled = busy;
    refs.customInput.disabled = busy;
    refs.dialog.setAttribute("aria-busy", String(busy));
  }

  function closeDialog() {
    if (state.dialog?.open) state.dialog.close();
    else state.dialog?.remove();
  }

  function openDialog() {
    state.dialog?.remove();
    const refs = createDialogNodes();
    const { dialog } = refs;
    state.dialog = dialog;
    state.previousFocus = document.activeElement;
    dialog.addEventListener("close", () => {
      if (state.dialog !== dialog) return;
      state.dialog = null;
      dialog.remove();
      if (state.previousFocus?.isConnected) state.previousFocus.focus();
      state.previousFocus = null;
    });
    refs.rangeSelect.addEventListener("change", () => syncCustomField(refs));
    refs.customInput.addEventListener("input", () => { refs.error.textContent = ""; });
    refs.closeButton.addEventListener("click", closeDialog);
    refs.form.addEventListener("submit", (event) => {
      event.preventDefault();
      runExport(refs);
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.focus();
  }

  // ---- 导出流程 ----

  function selectionFromDialog(refs) {
    const custom = refs.rangeSelect.value === "custom";
    if (custom && !refs.customInput.value.trim()) throw new Error(EMPTY_RANGE_HINT);
    const rangeText = custom ? refs.customInput.value.trim() : refs.rangeSelect.value;
    const parsed = parseRange(rangeText);
    if (custom && parsed.kind !== "range") throw new Error("自定义楼层请输入数字或范围，例如：1,3-8");
    return {
      scope: parsed.kind === "post" ? "main" : parsed.kind,
      rangeText,
      postNumbers: parsed.postNumbers ? [...parsed.postNumbers] : null,
      rangeLabel: parsed.kind === "range" ? parsed.label : RANGE_LABELS[parsed.kind],
      rangeToken: parsed.kind === "range"
        ? `range-${parsed.label.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "")}`
        : parsed.kind,
      format: refs.formatSelect.value
    };
  }

  function formatProgress(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value.message !== "string") {
      throw new Error("readTopic 的 onProgress 需要字符串或 {message, loaded, total}");
    }
    const counts = Number.isFinite(value.loaded) && Number.isFinite(value.total) ? `（${value.loaded}/${value.total}）` : "";
    return `${value.message}${counts}`;
  }

  async function runExport(refs) {
    if (refs.busy) return;
    refs.error.textContent = "";
    let selection;
    try {
      selection = selectionFromDialog(refs);
    } catch (error) {
      refs.error.textContent = error.message;
      refs.customInput.focus();
      return;
    }
    const { dialog } = refs;
    const isActive = () => state.dialog === dialog && dialog.open;
    refs.busy = true;
    setBusy(refs, true);
    refs.progress.textContent = "正在读取主题…";
    try {
      const result = await state.readTopic({
        scope: selection.scope,
        rangeText: selection.rangeText,
        postNumbers: selection.postNumbers,
        onProgress: (value) => { refs.progress.textContent = formatProgress(value); },
        isActive
      });
      if (!isActive()) return;
      const output = buildOutput(result, selection);
      downloadText(output.filename, output.content, MIME_TYPES[selection.format]);
      refs.progress.textContent = `已生成 ${output.filename}，已提交给浏览器下载，请在浏览器下载列表确认结果。`;
    } catch (error) {
      if (!isActive()) return;
      refs.error.textContent = `导出失败：${error.message}`;
      console.error("[betterLD] topic export failed", error);
    } finally {
      refs.busy = false;
      setBusy(refs, false);
    }
  }

  function validateResult(result) {
    if (!result || typeof result !== "object") throw new Error("读取主题没有返回结果");
    const { topic, topicInfo, exportMode } = result;
    if (!topic || typeof topic !== "object") throw new Error("读取结果缺少 topic");
    if (typeof topic.title !== "string" || !topic.title.trim()) throw new Error("读取结果缺少主题标题");
    if (!Array.isArray(topic.posts) || !topic.posts.length) throw new Error("读取结果没有任何楼层");
    for (const post of topic.posts) {
      if (!Number.isInteger(post?.post_number) || post.post_number < 1) throw new Error("楼层缺少 post_number");
      if (typeof post.cooked !== "string") throw new Error(`第 ${post.post_number} 楼缺少 cooked 内容`);
    }
    if (!topicInfo || typeof topicInfo !== "object") throw new Error("读取结果缺少 topicInfo");
    if (!/^[1-9]\d*$/.test(String(topicInfo.id))) throw new Error("topicInfo.id 不是正整数");
    if (typeof topicInfo.origin !== "string" || !topicInfo.origin) throw new Error("topicInfo 缺少 origin");
    if (typeof topicInfo.originalUrl !== "string" || !topicInfo.originalUrl) throw new Error("topicInfo 缺少 originalUrl");
    if (exportMode !== "flat" && exportMode !== "nest") throw new Error(`导出模式无法识别：${exportMode}`);
  }

  function selectPosts(posts, postNumbers) {
    const numbers = postNumbers === null ? null : new Set(postNumbers);
    return posts
      .filter((post) => numbers === null || numbers.has(post.post_number))
      .sort((first, second) => first.post_number - second.post_number);
  }

  function buildOutput(result, selection) {
    validateResult(result);
    const { topic, topicInfo, exportMode } = result;
    const base = topicInfo.originalUrl;
    const isHtml = selection.format === "html";
    const convert = isHtml
      ? (cooked) => resolveResourceUrls(cooked, base)
      : (cooked) => htmlToMarkdown(cooked, base);

    const posts = selectPosts(topic.posts, selection.postNumbers);
    if (!posts.length) throw new Error("所选范围内没有可导出的楼层");
    if (selection.postNumbers !== null) {
      const returned = new Set(topic.posts.map((post) => post.post_number));
      const missing = selection.postNumbers.filter((number) => !returned.has(number)).sort((first, second) => first - second);
      if (missing.length) throw new Error(`主题数据缺少所选楼层：${missing.join(", ")}`);
    }

    const visiblePosts = posts.map((post) => {
      const body = convert(post.cooked).trim();
      if (!body) throw new Error(`第 ${post.post_number} 楼转换后没有可导出的正文`);
      return { post, body };
    });

    const buildOptions = { topic, topicInfo, posts: visiblePosts, exportMode, rangeLabel: selection.rangeLabel };
    return {
      filename: makeFilename(topicInfo.id, topic.title, exportMode, selection),
      content: isHtml ? buildHtml(buildOptions) : buildMarkdown(buildOptions)
    };
  }

  // ---- 上游复用：范围解析 ----

  const POST_ONLY_ALIASES = new Set(["post", "main", "主帖"]);

  function parseRange(input) {
    const raw = String(input || "").trim();
    const normalized = raw.toLowerCase();

    if (!raw || normalized === "all" || raw === "全部") {
      return { kind: "all", label: raw || "all", postNumbers: null };
    }

    if (POST_ONLY_ALIASES.has(normalized) || POST_ONLY_ALIASES.has(raw)) {
      return { kind: "post", label: raw, postNumbers: new Set([1]) };
    }

    const postNumbers = new Set();
    const segments = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (!segments.length) {
      throw new Error("范围格式为空。");
    }

    for (const segment of segments) {
      const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
      const numberMatch = segment.match(/^\d+$/);

      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1 || start > end) {
          throw new Error(`范围无效：${segment}`);
        }
        if (end - start + 1 > config.topicExport.maxRangePosts) throw new Error(`一次自定义范围最多 ${config.topicExport.maxRangePosts} 楼，请使用全部回复或缩小范围`);
        for (let value = start; value <= end; value += 1) {
          postNumbers.add(value);
        }
      } else if (numberMatch) {
        const value = Number(segment);
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`楼层无效：${segment}`);
        postNumbers.add(value);
      } else {
        throw new Error(`无法识别范围：${segment}`);
      }
    }

    if (postNumbers.size > config.topicExport.maxRangePosts) throw new Error(`一次自定义范围最多 ${config.topicExport.maxRangePosts} 楼`);
    return { kind: "range", label: raw, postNumbers };
  }

  // ---- 上游复用：导出模板 ----

  function buildMarkdown({ topic, topicInfo, posts, exportMode, rangeLabel }) {
    const lines = [
      `# ${escapeMarkdownLine(topic.title)}`,
      "",
      `- 原始链接: ${topicInfo.originalUrl}`,
      `- 导出模式: ${exportMode}`,
      `- 导出时间: ${new Date().toLocaleString()}`,
      `- 楼层范围: ${rangeLabel}`,
      "",
      "---",
      ""
    ];

    lines.push(exportMode === "nest" ? renderNestedPosts(posts) : renderFlatPosts(posts));

    return normalizeMarkdown(lines.join("\n"));
  }

  function buildHtml({ topic, topicInfo, posts, exportMode, rangeLabel }) {
    const content = exportMode === "nest"
      ? renderNestedPostsHtml(posts)
      : renderFlatPostsHtml(posts);

    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(topic.title)}</title>`,
      `<style>${htmlExportCss()}</style>`,
      "</head>",
      "<body>",
      '<main class="page">',
      `<h1>${escapeHtml(topic.title)}</h1>`,
      '<section class="topic-meta">',
      `<div><strong>原始链接:</strong> <a href="${escapeHtmlAttribute(topicInfo.originalUrl)}">${escapeHtml(topicInfo.originalUrl)}</a></div>`,
      `<div><strong>导出模式:</strong> ${escapeHtml(exportMode)}</div>`,
      `<div><strong>导出格式:</strong> HTML</div>`,
      `<div><strong>导出时间:</strong> ${escapeHtml(new Date().toLocaleString())}</div>`,
      `<div><strong>楼层范围:</strong> ${escapeHtml(rangeLabel)}</div>`,
      "</section>",
      '<section class="posts">',
      content,
      "</section>",
      "</main>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  function renderFlatPosts(items) {
    return items.map(({ post, body }) => {
      return [
        renderPostLabel(post),
        "",
        renderPostMeta(post),
        "",
        body,
        "",
      ].join("\n");
    }).join("\n");
  }

  function renderFlatPostsHtml(items) {
    return items.map(({ post, body }) => renderPostHtml({ post, body, depth: 0 })).join("\n");
  }

  function renderNestedPosts(items) {
    const byNumber = new Map(items.map((item) => [item.post.post_number, { ...item, children: [] }]));
    const roots = [];
    const outOfRangeParents = [];

    const mainPostNode = byNumber.get(1);

    for (const node of byNumber.values()) {
      const parentNumber = Number(node.post.reply_to_post_number || 0);
      if (parentNumber && byNumber.has(parentNumber)) {
        byNumber.get(parentNumber).children.push(node);
      } else if (parentNumber && !byNumber.has(parentNumber)) {
        outOfRangeParents.push(node);
      } else if (mainPostNode && node.post.post_number !== 1) {
        mainPostNode.children.push(node);
      } else {
        roots.push(node);
      }
    }

    for (const node of byNumber.values()) {
      node.children.sort((first, second) => first.post.post_number - second.post.post_number);
    }

    roots.sort((first, second) => first.post.post_number - second.post.post_number);
    outOfRangeParents.sort((first, second) => first.post.post_number - second.post.post_number);

    const lines = [];
    for (const root of roots) {
      renderNestedNode(root, 2, lines);
    }

    if (outOfRangeParents.length) {
      lines.push("## 范围外父级回复", "");
      for (const node of outOfRangeParents) {
        renderNestedNode(node, 3, lines);
      }
    }

    return lines.join("\n");
  }

  function renderNestedPostsHtml(items) {
    const byNumber = new Map(items.map((item) => [item.post.post_number, { ...item, children: [] }]));
    const roots = [];
    const outOfRangeParents = [];
    const mainPostNode = byNumber.get(1);

    for (const node of byNumber.values()) {
      const parentNumber = Number(node.post.reply_to_post_number || 0);
      if (parentNumber && byNumber.has(parentNumber)) {
        byNumber.get(parentNumber).children.push(node);
      } else if (parentNumber && !byNumber.has(parentNumber)) {
        outOfRangeParents.push(node);
      } else if (mainPostNode && node.post.post_number !== 1) {
        mainPostNode.children.push(node);
      } else {
        roots.push(node);
      }
    }

    for (const node of byNumber.values()) {
      node.children.sort((first, second) => first.post.post_number - second.post.post_number);
    }

    roots.sort((first, second) => first.post.post_number - second.post.post_number);
    outOfRangeParents.sort((first, second) => first.post.post_number - second.post.post_number);

    const html = [];
    for (const root of roots) {
      renderNestedNodeHtml(root, 0, html);
    }

    if (outOfRangeParents.length) {
      html.push('<h2 class="section-title">范围外父级回复</h2>');
      for (const node of outOfRangeParents) {
        renderNestedNodeHtml(node, 1, html);
      }
    }

    return html.join("\n");
  }

  function renderNestedNode(node, depth, lines) {
    lines.push(renderPostLabel(node.post));
    lines.push("");
    lines.push(renderPostMeta(node.post));
    lines.push("");
    lines.push(node.body);
    lines.push("");

    for (const child of node.children) {
      renderNestedNode(child, depth + 1, lines);
    }
  }

  function renderNestedNodeHtml(node, depth, html) {
    html.push(renderPostHtml({ post: node.post, body: node.body, depth }));

    for (const child of node.children) {
      renderNestedNodeHtml(child, depth + 1, html);
    }
  }

  function renderPostHtml({ post, body, depth }) {
    const safeDepth = Math.min(Math.max(depth, 0), config.topicExport.htmlMaxDepth);
    const meta = [
      `<span>时间: ${escapeHtml(formatDate(post.created_at))}</span>`,
    ];

    if (post.reply_to_post_number) {
      meta.push(`<span>回复: #${escapeHtml(post.reply_to_post_number)}</span>`);
    }

    return [
      `<article class="post depth-${safeDepth}" style="--depth:${safeDepth}">`,
      '<header class="post-header">',
      `<div class="post-title">#${escapeHtml(post.post_number)} ${escapeHtml(formatAuthor(post))}</div>`,
      `<div class="post-meta">${meta.join("")}</div>`,
      "</header>",
      `<div class="post-body">${body}</div>`,
      "</article>",
    ].join("\n");
  }

  function renderPostMeta(post) {
    const parts = [
      `时间: ${formatDate(post.created_at)}`,
    ];

    if (post.reply_to_post_number) {
      parts.push(`回复: #${post.reply_to_post_number}`);
    }

    return parts.map((part) => `- ${part}`).join("\n");
  }

  function renderPostLabel(post) {
    return `**#${post.post_number} ${formatAuthor(post)}**`;
  }

  function formatAuthor(post) {
    const display = post.display_username || post.name || post.username || "unknown";
    return post.username && post.username !== display ? `${display} (@${post.username})` : display;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  // ---- 上游复用：HTML → Markdown ----

  function htmlToMarkdown(html, base) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    return normalizeMarkdown(renderChildren(root, { listDepth: 0, base }).trim());
  }

  function renderChildren(node, context) {
    return [...node.childNodes].map((child) => renderNode(child, context)).join("");
  }

  function renderNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue.replace(/\s+/g, " ");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tag = node.tagName.toLowerCase();
    if (node.classList.contains("video-placeholder-container")) {
      const src = node.dataset.videoSrc;
      if (!src) throw new Error("上传视频缺少原站媒体地址");
      return `\n\n[视频](${absoluteUrl(src, context.base)})\n\n`;
    }
    const text = () => renderChildren(node, context).trim();
    const block = (content) => `\n\n${content.trim()}\n\n`;

    switch (tag) {
      case "br":
        return "\n";
      case "p":
        return block(text());
      case "strong":
      case "b":
        return `**${text()}**`;
      case "em":
      case "i":
        return `*${text()}*`;
      case "code":
        if (node.closest("pre")) return node.textContent || "";
        return `\`${(node.textContent || "").replace(/`/g, "\\`")}\``;
      case "pre": {
        const code = node.textContent.replace(/\n+$/, "");
        return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
      }
      case "blockquote": {
        const content = normalizeMarkdown(text());
        return block(content.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"));
      }
      case "a": {
        const href = node.getAttribute("href");
        const linkedImage = findLinkedImageAttachment(node);
        if (href && linkedImage) {
          const emojiText = imageToEmojiText(linkedImage);
          if (emojiText) return emojiText;

          const hrefIsImage = isImageUrl(href);
          const imageMarkdown = renderImageMarkdown(linkedImage, context, hrefIsImage ? href : null);
          if (!imageMarkdown) return "";

          const src = linkedImage.getAttribute("src") || "";
          if (urlsPointToSameResource(href, src, context.base) || hrefIsImage) return imageMarkdown;
          return `[${imageMarkdown}](${absoluteUrl(href, context.base)})`;
        }

        const label = plainTextContent(node) || href || "";
        if (!href) return label;
        return `[${escapeMarkdownLinkText(label)}](${absoluteUrl(href, context.base)})`;
      }
      case "img": {
        return renderImageMarkdown(node, context);
      }
      case "iframe": {
        const src = node.getAttribute("src");
        if (!src) return text();
        return block(`[嵌入页面：${escapeMarkdownLinkText(src)}](${absoluteUrl(src, context.base)})`);
      }
      case "video":
      case "audio": {
        const label = tag === "video" ? "视频" : "音频";
        const src = node.getAttribute("src") || node.querySelector("source")?.getAttribute("src");
        const poster = node.getAttribute("poster");
        const lines = [];
        if (src) lines.push(`[${label}：${escapeMarkdownLinkText(src)}](${absoluteUrl(src, context.base)})`);
        if (poster) lines.push(`![${label}封面](${absoluteUrl(poster, context.base)})`);
        if (!lines.length) return text();
        return block(lines.join("\n\n"));
      }
      case "table":
        return block(renderTable(node, context));
      case "details": {
        const summary = node.querySelector(":scope > summary");
        const label = summary ? plainTextContent(summary) : "";
        const body = normalizeMarkdown([...node.childNodes]
          .filter((child) => child !== summary)
          .map((child) => renderNode(child, context))
          .join(""));
        if (!label && !body) return "";
        return block([label ? `**${escapeMarkdownLinkText(label)}**` : "", body].filter(Boolean).join("\n\n"));
      }
      case "ul":
      case "ol":
        return renderList(node, context, tag === "ol");
      case "li":
        return text();
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag.slice(1)) + 1;
        return block(`${"#".repeat(Math.min(level, 6))} ${text()}`);
      }
      case "div":
      case "section":
      case "article":
      case "aside":
        return block(text());
      case "span":
        return text();
      default:
        return text();
    }
  }

  function renderTable(node, context) {
    const rows = [...node.querySelectorAll("tr")].map((row) => [...row.children]
      .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
      .map((cell) => renderCell(cell, context)));
    if (!rows.length) return "";

    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const pad = (row) => [...row, ...Array(columns - row.length).fill("")];
    const lines = [
      `| ${pad(rows[0]).join(" | ")} |`,
      `| ${Array(columns).fill("---").join(" | ")} |`
    ];
    for (const row of rows.slice(1)) {
      lines.push(`| ${pad(row).join(" | ")} |`);
    }
    return lines.join("\n");
  }

  function renderCell(cell, context) {
    return normalizeMarkdown(renderChildren(cell, context))
      .replace(/\n+/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  }

  function renderList(node, context, ordered) {
    const depth = context.listDepth || 0;
    const lines = [];
    let index = 1;

    for (const child of [...node.children].filter((element) => element.tagName.toLowerCase() === "li")) {
      const marker = ordered ? `${index}.` : "-";
      const prefix = "  ".repeat(depth) + marker + " ";
      const rendered = renderChildren(child, { ...context, listDepth: depth + 1 }).trim();
      const [firstLine, ...restLines] = rendered.split("\n");
      lines.push(prefix + firstLine);
      for (const line of restLines) {
        lines.push("  ".repeat(depth + 1) + line);
      }
      index += 1;
    }

    return `\n${lines.join("\n")}\n`;
  }

  function absoluteUrl(value, base) {
    const text = String(value).trim();
    if (!text) return text;
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("//")) {
      // 协议相对地址在本地文件里会落到 file://，必须按站点协议补齐。
      return text.startsWith("//") ? new URL(text, base).href : text;
    }
    try {
      return new URL(text, base).href;
    } catch {
      throw new Error(`无法把相对地址解析为绝对地址：${text}`);
    }
  }

  function renderImageMarkdown(node, context, preferredSrc) {
    const emojiText = imageToEmojiText(node);
    if (emojiText) return emojiText;

    const src = preferredSrc || node.getAttribute("src");
    if (!src) return "";
    const alt = node.getAttribute("alt") || node.getAttribute("title") || "image";
    return `![${escapeMarkdownLinkText(alt)}](${absoluteUrl(src, context.base)})`;
  }

  function findLinkedImageAttachment(node) {
    const meaningfulChildren = [...node.childNodes].filter((child) => {
      if (child.nodeType === Node.TEXT_NODE) return child.nodeValue.trim();
      if (child.nodeType === Node.ELEMENT_NODE) return true;
      return false;
    });

    const imageChildren = meaningfulChildren.filter((child) => {
      return child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "img";
    });

    if (imageChildren.length !== 1) return null;

    const onlyImage = imageChildren[0];
    const nonImageText = meaningfulChildren
      .filter((child) => child !== onlyImage)
      .map((child) => plainTextContent(child))
      .join(" ")
      .trim();

    if (!nonImageText || looksLikeImageAttachmentInfo(nonImageText)) {
      return onlyImage;
    }

    return null;
  }

  function looksLikeImageAttachmentInfo(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) return true;

    return /^(?:image|图片)?\s*\d+\s*[x×]\s*\d+(?:\s+\d+(?:\.\d+)?\s*(?:KB|MB|B))?$/i.test(normalized);
  }

  function plainTextContent(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isImageUrl(value) {
    return /\.(?:apng|avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(String(value || ""));
  }

  function urlsPointToSameResource(first, second, base) {
    if (!first || !second) return false;

    try {
      return new URL(first, base).href === new URL(second, base).href;
    } catch {
      return String(first) === String(second);
    }
  }

  function imageToEmojiText(node) {
    const src = node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || "";
    const title = node.getAttribute("title") || "";
    const ariaLabel = node.getAttribute("aria-label") || "";
    const className = node.getAttribute("class") || "";
    const haystack = `${className} ${src} ${alt} ${title} ${ariaLabel}`.toLowerCase();
    const looksLikeEmoji =
      /\b(custom-)?emoji\b/.test(className.toLowerCase()) ||
      /\bemoticon\b/.test(className.toLowerCase()) ||
      /^:[^:\s][^:]*:$/.test(alt.trim()) ||
      /^:[^:\s][^:]*:$/.test(title.trim()) ||
      /^:[^:\s][^:]*:$/.test(ariaLabel.trim()) ||
      haystack.includes("/emoji/") ||
      haystack.includes("emoji") ||
      haystack.includes("emoticon");

    if (!looksLikeEmoji) return "";

    const rawName = alt || title || ariaLabel || filenameFromUrl(src);
    const name = cleanEmojiName(rawName);
    return name ? `:${name}:` : "";
  }

  function filenameFromUrl(value) {
    const filename = String(value || "").split(/[/?#]/).filter(Boolean).pop() || "";
    return filename.replace(/\.[a-z0-9]+$/i, "");
  }

  function cleanEmojiName(value) {
    return String(value || "")
      .trim()
      .replace(/^:+|:+$/g, "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/\s+/g, "_")
      .replace(/[^\w+\-.]/g, "")
      .replace(/^_+|_+$/g, "");
  }

  function escapeMarkdownLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeMarkdownLinkText(value) {
    return String(value || "").replace(/]/g, "\\]").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeHtmlAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function htmlExportCss() {
    return `
      :root {
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8fafc;
        color: #0f172a;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: #f8fafc; }
      .page { width: min(980px, calc(100vw - 32px)); margin: 32px auto; }
      h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.25; letter-spacing: 0; }
      a { color: #0f766e; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .topic-meta {
        display: grid;
        gap: 6px;
        margin: 0 0 20px;
        padding: 14px 16px;
        border: 1px solid #dbe3ea;
        border-radius: 8px;
        background: #ffffff;
        color: #334155;
        font-size: 14px;
      }
      .posts { display: grid; gap: 12px; }
      .post {
        margin-left: min(calc(var(--depth) * 28px), 224px);
        border: 1px solid #dbe3ea;
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }
      .post-header {
        display: grid;
        gap: 6px;
        padding: 12px 14px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
      }
      .post-title { font-weight: 700; line-height: 1.35; }
      .post-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        color: #64748b;
        font-size: 13px;
      }
      .post-body {
        padding: 14px;
        line-height: 1.65;
        overflow-wrap: anywhere;
      }
      .post-body img {
        max-width: 100%;
        height: auto;
      }
      .post-body iframe,
      .post-body video {
        max-width: 100%;
      }
      .post-body table {
        max-width: 100%;
        border-collapse: collapse;
      }
      .post-body :is(th, td) {
        padding: 6px 10px;
        border: 1px solid #dbe3ea;
      }
      .post-body pre {
        max-width: 100%;
        overflow: auto;
        padding: 12px;
        border-radius: 6px;
        background: #0f172a;
        color: #e2e8f0;
      }
      .post-body blockquote {
        margin: 12px 0;
        padding: 8px 12px;
        border-left: 3px solid #94a3b8;
        background: #f8fafc;
        color: #334155;
      }
      .section-title { margin: 22px 0 10px; font-size: 18px; letter-spacing: 0; }
    `;
  }

  // ---- 上游复用：HTML 导出资源地址 ----

  function resolveResourceUrls(html, base) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    root.querySelectorAll(".video-placeholder-container").forEach((placeholder) => {
      const src = placeholder.dataset.videoSrc;
      if (!src) throw new Error("上传视频缺少原站媒体地址");
      const video = doc.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = absoluteUrl(src, base);
      if (placeholder.dataset.thumbnailSrc) video.poster = absoluteUrl(placeholder.dataset.thumbnailSrc, base);
      placeholder.replaceWith(video);
    });
    resolveResourceNodes(root, base);
    return root.innerHTML;
  }

  function resolveResourceNodes(root, base) {
    root.querySelectorAll("template").forEach((template) => resolveResourceNodes(template.content, base));
    for (const node of root.querySelectorAll("[href], [src], [poster], [srcset]")) {
      for (const name of RESOURCE_ATTRIBUTES) {
        const value = node.getAttribute(name);
        if (value) node.setAttribute(name, absoluteUrl(value, base));
      }
      const srcset = node.getAttribute("srcset");
      if (srcset) node.setAttribute("srcset", resolveSrcset(srcset, base));
    }
  }

  function resolveSrcset(value, base) {
    return value.split(",").map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return [absoluteUrl(url, base), ...descriptor].join(" ");
    }).join(", ");
  }

  function normalizeMarkdown(markdown) {
    return markdown
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim()
      + "\n";
  }

  // ---- 下载与文件名 ----

  function makeFilename(topicId, title, exportMode, selection) {
    const { filenamePrefix, filenameTitleMaxLength } = config.topicExport;
    const safeTitle = title
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, filenameTitleMaxLength) || "topic";

    return `${filenamePrefix}-${topicId}-${exportMode}-${selection.rangeToken}-${safeTitle}.${FILE_EXTENSIONS[selection.format]}`;
  }

  function downloadText(filename, text, mimeType) {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), config.topicExport.objectUrlRevokeMs);
  }

  // ---- 对外契约 ----

  function teardown() {
    closeDialog();
    state.button?.remove();
    state.button = null;
    state.topicId = "";
    state.title = "";
    state.readTopic = null;
  }

  function sync({ topicId, title, readTopic } = {}) {
    const id = topicId ? String(topicId) : "";
    if (!id) {
      teardown();
      return;
    }
    if (typeof title !== "string") throw new Error("导出模块需要主题标题字符串");
    if (typeof readTopic !== "function") throw new Error("导出模块需要 readTopic 函数");
    // 路由变更：同一个对话框不能跨主题继续导出。
    if (state.dialog?.open && state.topicId !== id) closeDialog();
    state.topicId = id;
    state.title = title;
    state.readTopic = readTopic;
    syncButton();
  }

  globalThis.BETTERLD_EXPORT = Object.freeze({ sync });
})();
