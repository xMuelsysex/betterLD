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
 * - HTML 导出改为完全离线单文件：正文图片、媒体、附件与作者头像由后台串行下载后内嵌 data URL，
 *   生成前完整遍历被动依赖，无法无损归档的嵌入内容显式失败并报楼层、类型与地址；
 * - HTML 导出用真实父子嵌套与 CSS 伪元素连线，Markdown 仍保留远程地址。
 * - 分享图片（PNG）复用同一套楼层范围解析：主帖、全部回复、已加载回复与自定义楼层都可生成；
 *   全部回复按无筛选的完整楼层流核对数量，缺正文或数量不一致时明确失败，不输出部分结果。
 * - Markdown 补 iframe / video / audio / table / details 的有意义表示。
 */
(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const offlineAssets = globalThis.BETTERLD_OFFLINE_ASSETS;

  const FORMAT_OPTIONS = Object.freeze([
    Object.freeze({ value: "html", label: "HTML" }),
    Object.freeze({ value: "markdown", label: "Markdown" }),
    Object.freeze({ value: "png", label: "分享图片（PNG）" })
  ]);
  const HTML_RESOURCE_OPTIONS = Object.freeze([
    Object.freeze({ value: "offline", label: "完全离线内嵌" }),
    Object.freeze({ value: "remote", label: "远程引用" })
  ]);
  const RANGE_OPTIONS = Object.freeze([
    Object.freeze({ value: "all", label: "全部回复" }),
    Object.freeze({ value: "loaded", label: "已加载回复" }),
    Object.freeze({ value: "post", label: "只导出主帖" }),
    Object.freeze({ value: "custom", label: "自定义楼层" })
  ]);
  const RANGE_LABELS = Object.freeze({ all: "全部回复", loaded: "已加载回复", post: "主帖" });
  const MIME_TYPES = Object.freeze({ html: "text/html;charset=utf-8", markdown: "text/markdown;charset=utf-8" });
  const FILE_EXTENSIONS = Object.freeze({ html: "html", markdown: "md" });
  const EMPTY_RANGE_HINT = "自定义楼层不能为空，例如：1,3-8";
  const MARKDOWN_ASSET_NOTE = "Markdown 保留原站远程地址，打开文档需要联网；需要登录才能访问的资源可能无法显示。";
  const OFFLINE_ASSET_NOTE = "HTML 导出为完全离线的单文件：正文图片、媒体、附件与作者头像会内嵌，打开不再需要联网；归档需要这些资源域名的访问权限。";
  const REMOTE_ASSET_NOTE = "HTML 只保留资源的远程地址：作者头像、正文图片和媒体需联网加载，不下载资源或申请归档权限；原帖删除或资源失效后，远程内容可能无法显示。外部播放器仍不支持导出，文件不执行脚本。";
  const OFFLINE_LINK_NOTE = "离线归档已内嵌全部正文资源与作者头像，导出文件不执行任何脚本；页面里的出处与导航链接点击后仍需联网。";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
  const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const CSS_URL_CALL_PATTERN = /url\s*\(/gi;
  const NAVIGATION_PROTOCOLS = Object.freeze(["http:", "https:", "mailto:"]);
  // 只允许内嵌 data: 与内联样式，阻止导出文件发出任何意外请求或执行脚本。
  const OFFLINE_CSP = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:";
  const REMOTE_CSP = "default-src 'none'; img-src https: data:; media-src https: data:; style-src 'unsafe-inline'; font-src https: data:";
  const FONT_EXTENSIONS = /^.*\.(?:woff2?|ttf|otf|eot)$/i;
  const RESOURCE_KIND_LABELS = Object.freeze({
    image: "图片",
    media: "媒体",
    track: "字幕轨",
    attachment: "附件",
    font: "字体"
  });
  const SHELL_FLOOR_LABEL = "主题外壳";

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
    node.dataset.betterldOwned = "true";
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
    const htmlResourceSelect = selectControl(HTML_RESOURCE_OPTIONS);
    htmlResourceSelect.value = config.topicExport.htmlResourceMode;
    htmlResourceSelect.setAttribute("aria-label", "HTML 资源保存方式");
    const htmlResourceField = fieldControl("HTML 资源保存方式", htmlResourceSelect);
    const rangeSelect = selectControl(RANGE_OPTIONS);
    const customInput = element("input", "betterld-export-input");
    customInput.type = "text";
    customInput.placeholder = "例如：1,3-8";
    customInput.autocomplete = "off";
    customInput.setAttribute("aria-describedby", "betterld-export-dialog-error");
    const customField = fieldControl("自定义楼层", customInput);
    customField.hidden = true;

    const note = element("p", "betterld-export-note", OFFLINE_ASSET_NOTE);
    note.id = "betterld-export-dialog-note";
    const progress = element("p", "betterld-export-progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    const error = element("p", "betterld-export-error");
    error.id = "betterld-export-dialog-error";
    error.setAttribute("role", "alert");

    const preview = element("div", "betterld-export-image-preview");
    preview.hidden = true;
    const actions = element("div", "betterld-export-actions");
    const permissionButton = element("button", "betterld-export-button betterld-export-button--tonal", "打开扩展授权页");
    permissionButton.type = "button";
    permissionButton.hidden = true;
    const closeButton = element("button", "betterld-export-button", "关闭");
    closeButton.type = "button";
    const confirmButton = element("button", "betterld-export-button betterld-export-button--primary", "导出");
    confirmButton.type = "submit";
    actions.append(permissionButton, closeButton, confirmButton);

    form.append(title, subject, fieldControl("导出格式", formatSelect), htmlResourceField, fieldControl("导出范围", rangeSelect),
      customField, note, progress, error, preview, actions);
    dialog.append(form);

    return {
      dialog,
      form,
      formatSelect,
      htmlResourceSelect,
      htmlResourceField,
      rangeSelect,
      customInput,
      customField,
      note,
      progress,
      error,
      permissionButton,
      preview,
      imageUrls: [],
      controller: null,
      closeButton,
      confirmButton,
      busy: false
    };
  }

  function syncFormatNote(refs) {
    clearImagePreview(refs);
    const isImage = refs.formatSelect.value === "png";
    syncCustomField(refs);
    refs.confirmButton.textContent = isImage ? "生成图片预览" : "导出";
    const isHtml = refs.formatSelect.value === "html";
    refs.htmlResourceField.hidden = !isHtml;
    refs.note.textContent = isHtml
      ? (refs.htmlResourceSelect.value === "offline" ? OFFLINE_ASSET_NOTE : REMOTE_ASSET_NOTE)
      : isImage ? "预览后下载 PNG，超长内容自动拆页。视频保留链接，折叠内容与剧透保持隐藏；图片和头像需要资源访问权限。" : MARKDOWN_ASSET_NOTE;
    refs.error.textContent = "";
    refs.progress.textContent = "";
    refs.permissionButton.hidden = true;
  }

  function syncCustomField(refs) {
    refs.customField.hidden = refs.rangeSelect.value !== "custom";
    refs.error.textContent = "";
    refs.permissionButton.hidden = true;
    if (!refs.customField.hidden) refs.customInput.focus();
  }

  function setBusy(refs, busy) {
    refs.confirmButton.disabled = busy;
    refs.formatSelect.disabled = busy;
    refs.htmlResourceSelect.disabled = busy;
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
      refs.controller?.abort();
      clearImagePreview(refs);
      state.dialog = null;
      dialog.remove();
      if (state.previousFocus?.isConnected) state.previousFocus.focus();
      state.previousFocus = null;
    });
    refs.rangeSelect.addEventListener("change", () => { clearImagePreview(refs); syncCustomField(refs); });
    refs.formatSelect.addEventListener("change", () => syncFormatNote(refs));
    refs.htmlResourceSelect.addEventListener("change", () => syncFormatNote(refs));
    syncFormatNote(refs);
    refs.customInput.addEventListener("input", () => { clearImagePreview(refs); refs.error.textContent = ""; });
    refs.closeButton.addEventListener("click", closeDialog);
    refs.permissionButton.addEventListener("click", () => openOfflinePermissionSettings(refs));
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
      format: refs.formatSelect.value,
      htmlResourceMode: refs.htmlResourceSelect.value
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
    refs.permissionButton.hidden = true;
    let selection;
    try {
      selection = selectionFromDialog(refs);
    } catch (error) {
      refs.error.textContent = error.message;
      refs.customInput.focus();
      return;
    }
    clearImagePreview(refs);
    refs.controller = new AbortController();
    const { dialog } = refs;
    const isActive = () => state.dialog === dialog && dialog.open;
    const assertActive = () => {
      if (!isActive()) throw new DOMException("导出已取消或主题已切换", "AbortError");
    };
    refs.busy = true;
    setBusy(refs, true);
    refs.progress.textContent = "正在读取主题…";
    try {
      const result = await state.readTopic({
        scope: selection.scope,
        rangeText: selection.rangeText,
        postNumbers: selection.postNumbers,
        onProgress: (value) => { refs.progress.textContent = formatProgress(value); },
        isActive,
        signal: refs.controller.signal
      });
      assertActive();
      if (selection.format === "png") {
        await buildImagePreview(refs, result, selection, assertActive);
        return;
      }
      const output = await buildOutput(result, selection, {
        assertActive,
        onProgress: (value) => { refs.progress.textContent = formatProgress(value); }
      });
      assertActive();
      downloadText(output.filename, output.content, MIME_TYPES[selection.format]);
      refs.progress.textContent = `${output.summary} 已生成 ${output.filename}，已提交给浏览器下载，请在浏览器下载列表确认结果。`;
    } catch (error) {
      if (!isActive()) return;
      refs.error.textContent = `导出失败：${error.message}`;
      if (Array.isArray(error.missingOrigins) && error.missingOrigins.length) refs.permissionButton.hidden = false;
      console.error("[betterLD] topic export failed", error);
    } finally {
      refs.busy = false;
      setBusy(refs, false);
    }
  }

  function clearImagePreview(refs) {
    for (const url of refs.imageUrls) URL.revokeObjectURL(url);
    refs.imageUrls = [];
    refs.preview.replaceChildren();
    refs.preview.hidden = true;
  }

  // 图卡只准备可见正文，媒体保留链接，不套用完全离线 HTML 对外部播放器的归档限制。
  function imagePost(post, topicInfo) {
    const root = new DOMParser().parseFromString(post.cooked, "text/html").body;
    for (const image of root.querySelectorAll("img[data-src]")) {
      if (!image.getAttribute("src")) image.setAttribute("src", image.getAttribute("data-src"));
    }
    for (const node of root.querySelectorAll("[src], [href], [poster], [data-video-src], [data-thumbnail-src], source")) {
      for (const attr of ["src", "href", "poster", "data-video-src", "data-thumbnail-src"]) {
        const value = node.getAttribute(attr);
        if (value) node.setAttribute(attr, absoluteUrl(value, topicInfo.originalUrl));
      }
    }
    return { ...post, cooked: root.innerHTML,
      post_url: new URL(`/t/topic/${topicInfo.id}/${post.post_number}`, topicInfo.origin).href,
      avatar_template: postAvatarUrl(post) };
  }

  async function buildImagePreview(refs, result, selection, assertActive) {
    validateResult(result);
    const posts = selectPosts(result.topic.posts, selection.postNumbers).map((post) => imagePost(post, result.topicInfo));
    const cache = new Map();
    let bytes = 0;
    const loadImage = async (url) => {
      assertActive();
      if (cache.has(url)) return cache.get(url);
      if (/^data:/i.test(url)) {
        bytes += url.length;
        if (bytes > config.topicExport.offlineMaxTotalBytes) throw new Error(`图片资源总量超过 ${formatBytes(config.topicExport.offlineMaxTotalBytes)}`);
        offlineAssets.assertAssetMimeType(offlineAssets.dataUrlMimeType(url), ["image"], url.slice(0,80));
        if (offlineAssets.dataUrlMimeType(url) === "image/svg+xml") offlineAssets.assertSelfContainedSvgDataUrl(url);
        cache.set(url, url);
        return url;
      }
      const response = await sendRuntimeMessage({ type: "topic-export-asset", url, kinds: ["image"] });
      assertActive();
      if (!response?.ok) {
        const error = new Error(`图片读取失败：${url} —— ${response?.error || "后台没有返回资源"}`);
        if (response?.missingOrigin) error.missingOrigins = [response.missingOrigin];
        throw error;
      }
      bytes += response.dataUrl.length;
      if (bytes > config.topicExport.offlineMaxTotalBytes) throw new Error(`图片资源总量超过 ${formatBytes(config.topicExport.offlineMaxTotalBytes)}`);
      cache.set(url, response.dataUrl);
      return response.dataUrl;
    };
    const pages = await globalThis.BETTERLD_SHARE_IMAGE.render({
      topic: {id: result.topicInfo.id, title: result.topic.title}, posts,
      loadImage, signal: refs.controller.signal, settings: config.topicExport.imageShare,
      onProgress: ({ stage, done, total }) => { assertActive(); refs.progress.textContent = `${stage === "posts" ? "正在排版楼层" : "正在生成 PNG"}（${done}/${total}）`; }
    });
    assertActive();
    for (const [index, page] of pages.entries()) {
      const url = URL.createObjectURL(page.blob);
      refs.imageUrls.push(url);
      const figure = element("figure", "betterld-export-image-page");
      const image = element("img", "betterld-export-image");
      image.src = url;
      image.alt = `分享图片第 ${index + 1} / ${pages.length} 页`;
      const link = element("a", "betterld-export-button betterld-export-button--tonal", `下载第 ${index + 1} / ${pages.length} 页（${page.width}×${page.height}）`);
      link.href = url;
      link.download = `${config.topicExport.filenamePrefix}-${result.topicInfo.id}-${selection.rangeToken}-${index + 1}.png`;
      figure.append(image, link);
      refs.preview.append(figure);
    }
    refs.preview.hidden = false;
    refs.progress.textContent = `已生成 ${pages.length} 张 PNG。请查看预览并点击每页下载。`;
  }

  async function openOfflinePermissionSettings(refs) {
    refs.permissionButton.disabled = true;
    try {
      const response = await sendRuntimeMessage({ type: "open-topic-export-settings" });
      if (!response?.ok) throw new Error(response?.error || "扩展授权页未能打开");
      refs.progress.textContent = "已打开扩展授权页：高级 → 导入与导出 → HTML 导出离线归档。HTML 归档与分享图片共用资源授权；授权缺失域名后回到主题页重新生成。";
    } catch (error) {
      refs.progress.textContent = `打开扩展授权页失败：${error.message}。可在浏览器工具栏打开 betterLD 设置，进入「高级 → 导入与导出」。`;
      console.error("[betterLD] topic export permission page failed", error);
    } finally {
      refs.permissionButton.disabled = false;
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

  async function buildOutput(result, selection, context) {
    validateResult(result);
    const { topic, topicInfo, exportMode } = result;
    const base = topicInfo.originalUrl;
    const isHtml = selection.format === "html";

    const posts = selectPosts(topic.posts, selection.postNumbers);
    if (!posts.length) throw new Error("所选范围内没有可导出的楼层");
    if (selection.postNumbers !== null) {
      const returned = new Set(topic.posts.map((post) => post.post_number));
      const missing = selection.postNumbers.filter((number) => !returned.has(number)).sort((first, second) => first - second);
      if (missing.length) throw new Error(`主题数据缺少所选楼层：${missing.join(", ")}`);
    }

    const filename = makeFilename(topicInfo.id, topic.title, exportMode, selection);
    if (!isHtml) {
      const visiblePosts = posts.map((post) => {
        const body = htmlToMarkdown(post.cooked, base).trim();
        if (!body) throw new Error(`第 ${post.post_number} 楼转换后没有可导出的正文`);
        return { post, body };
      });
      return {
        filename,
        content: buildMarkdown({ topic, topicInfo, posts: visiblePosts, exportMode, rangeLabel: selection.rangeLabel }),
        summary: "Markdown 导出保留原站远程地址。"
      };
    }

    const options = { topic, topicInfo, posts, exportMode, rangeLabel: selection.rangeLabel };
    if (selection.htmlResourceMode === "remote") {
      context.assertActive();
      context.onProgress("正在生成远程引用 HTML…");
      return { filename, content: buildRemoteHtml(options), summary: "HTML 远程引用导出完成，头像与正文媒体需要联网加载。" };
    }
    if (selection.htmlResourceMode !== "offline") throw new Error("HTML 资源保存方式无法识别");
    const offline = await buildOfflineHtml(options, context);
    return { filename, content: offline.content, summary: offline.summary };
  }

  function buildRemoteHtml({ topic, topicInfo, posts, exportMode, rangeLabel }) {
    const base = topicInfo.originalUrl;
    const items = posts.map((post) => {
      try {
        const item = prepareHtmlPost(post, base);
        if (!item.body) throw new Error("转换后没有可导出的正文");
        return item;
      } catch (error) {
        throw new Error(`第 ${post.post_number} 楼：${error.message}`);
      }
    });
    const removedScripts = items.reduce((total, item) => total + item.removedScripts, 0);
    const doc = new DOMParser().parseFromString(buildHtml({
      topic, topicInfo, posts: items, exportMode, rangeLabel, resourceMode: "remote", removedScripts
    }), "text/html");
    importSvgSymbols(doc);
    assertArchivable(doc.documentElement);
    normalizeMedia(doc.documentElement, base);
    eachResource(doc.documentElement, base, ({ url, apply }) => {
      if (new URL(url).protocol !== "https:") throw new Error(`远程资源不是 https 地址：${url}`);
      apply(url);
    });
    absolutizeNavigationLinks(doc.documentElement, base);
    return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
  }

  // ---- HTML 资源转换与离线归档 ----

  function resourceLocation(floor) {
    return floor ? `#${floor}` : SHELL_FLOOR_LABEL;
  }

  function resourceKindLabel(kind) {
    return RESOURCE_KIND_LABELS[kind] || "资源";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function cssResourceKind(url) {
    // data: 地址没有扩展名，按声明的 MIME 判断字体，避免把内嵌字体当图片拒绝或反之。
    if (/^data:/i.test(url)) {
      return offlineAssets.isFontMimeType(offlineAssets.dataUrlMimeType(url)) ? "font" : "image";
    }
    return FONT_EXTENSIONS.test(url) ? "font" : "image";
  }

  // template 的内容不在文档树里，querySelectorAll 看不到：统一从这入口取节点，避免漏掉 template 内的资源。
  function queryAllDeep(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    root.querySelectorAll("template").forEach((template) => found.push(...queryAllDeep(template.content, selector)));
    return found;
  }

  // 只有装饰性脚本可以移除并写明；带 src 的脚本可能是内容嵌入，必须拒绝。
  function stripScripts(root) {
    let removed = 0;
    root.querySelectorAll("template").forEach((template) => { removed += stripScripts(template.content); });
    root.querySelectorAll("script").forEach((node) => {
      const src = node.getAttribute("src");
      if (src) throw new Error(`script 嵌入内容无法离线归档：${src}`);
      node.remove();
      removed += 1;
    });
    return removed;
  }

  // 无法无损归档的被动依赖与活动属性必须在下载前失败，不用外链占位伪装成功，也不靠 CSP 掩盖漏存。
  function assertArchivable(root) {
    const fail = (type, address) => {
      throw new Error(`${type}无法离线归档${address ? `：${address}` : ""}`);
    };
    queryAllDeep(root, "iframe, object, embed").forEach((node) => {
      fail(`${node.tagName.toLowerCase()} 嵌入内容`, node.getAttribute("src") || node.getAttribute("data") || "");
    });
    queryAllDeep(root, "link").forEach((node) => fail("link 外部引用", node.getAttribute("href") || ""));
    // 正文装饰脚本已在 stripScripts 移除并写明；最终文档里剩下的脚本（含克隆进来的 SVG symbol）一律拒绝。
    queryAllDeep(root, "script").forEach((node) => {
      fail("script 脚本", node.getAttribute("src") || node.textContent.trim().slice(0, 64) || "内联脚本");
    });
    // 活动属性会自己发请求，CSP 只能阻止执行、不能算已归档，必须在导出前明确失败。
    queryAllDeep(root, "meta").forEach((node) => {
      if (/^refresh$/i.test(node.getAttribute("http-equiv") || "")) fail("meta refresh 跳转", node.getAttribute("content") || "");
    });
    queryAllDeep(root, "base").forEach((node) => fail("base 基准地址", node.getAttribute("href") || ""));
    queryAllDeep(root, "form").forEach((node) => fail("form 表单提交", node.getAttribute("action") || ""));
    queryAllDeep(root, "[ping]").forEach((node) => fail("ping 链接跟踪", node.getAttribute("ping") || ""));
    queryAllDeep(root, "*").forEach((node) => {
      for (const attribute of node.attributes) {
        if (/^on[a-z]/i.test(attribute.name)) fail(`内联事件属性 ${attribute.name}`, attribute.value.slice(0, 64));
        if (node.namespaceURI === SVG_NAMESPACE && attribute.name !== "style"
          && /url\s*\(|\\/.test(attribute.value)) {
          fail(`SVG 表现属性 ${attribute.name} 的资源依赖`, attribute.value.slice(0, 120));
        }
        if (["background", "lowsrc", "dynsrc"].includes(attribute.name.toLowerCase())) {
          fail(`旧式媒体属性 ${attribute.name}`, attribute.value);
        }
      }
    });
    // 远程播放器容器（YouTube/B 站等 onebox 与 lazy-video）：原站靠脚本拉起外部播放器，无法归档。
    // 上传视频的 .video-placeholder-container 由媒体归档处理，不算外部播放器。
    queryAllDeep(root, ".lazy-video, .lazy-video-container, .lazyYT, .lazyYT-container").forEach((node) => {
      if (node.closest(".video-placeholder-container") || node.querySelector(".video-placeholder-container")) return;
      const address = node.getAttribute("data-video-src") || node.getAttribute("href")
        || node.querySelector("a[href]")?.getAttribute("href") || "";
      fail("外部播放器", address);
    });
    queryAllDeep(root, "use").forEach((node) => {
      const value = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
      if (value && !value.startsWith("#")) fail("SVG use 外部引用", value);
    });
  }

  function srcsetCandidates(value) {
    return String(value || "").split(",").map((candidate) => {
      const [url, descriptor] = candidate.trim().split(/\s+/);
      const weight = Number.parseFloat(String(descriptor || "").replace(/[wx]$/i, ""));
      return { url, weight: Number.isFinite(weight) ? weight : 0 };
    }).filter((candidate) => candidate.url);
  }

  // srcset 与 picture 只保留一个可归档的 src，删掉会隐式联网的候选。
  function collapseSrcset(node) {
    const picture = node.closest("picture");
    const sources = picture ? [...picture.querySelectorAll("source")] : [];
    const srcset = node.getAttribute("srcset");
    if (!srcset && !sources.length) return;
    if (!node.getAttribute("src")) {
      const candidates = [];
      if (srcset) candidates.push(...srcsetCandidates(srcset));
      for (const source of sources) {
        candidates.push(...srcsetCandidates(source.getAttribute("srcset") || source.getAttribute("src") || ""));
      }
      candidates.sort((first, second) => second.weight - first.weight);
      if (!candidates.length) throw new Error("图片缺少可归档的地址");
      node.setAttribute("src", candidates[0].url);
    }
    node.removeAttribute("srcset");
    for (const source of sources) source.remove();
  }

  function normalizeMedia(root, base) {
    root.querySelectorAll("template").forEach((template) => normalizeMedia(template.content, base));
    root.querySelectorAll(".video-placeholder-container").forEach((placeholder) => {
      const src = placeholder.dataset.videoSrc;
      if (!src) throw new Error("上传视频缺少原站媒体地址");
      const video = root.ownerDocument.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("src", absoluteUrl(src, base));
      if (placeholder.dataset.thumbnailSrc) video.setAttribute("poster", absoluteUrl(placeholder.dataset.thumbnailSrc, base));
      placeholder.replaceWith(video);
    });
    root.querySelectorAll("img").forEach((node) => {
      const lazy = node.getAttribute("data-src");
      if (lazy) {
        node.setAttribute("src", absoluteUrl(lazy, base));
        node.removeAttribute("data-src");
      }
      collapseSrcset(node);
    });
    root.querySelectorAll("picture > source").forEach((node) => node.remove());
  }

  // 单一遍历入口：收集与内嵌共用，保证归档集合与最终文档里的被动依赖一致。
  function eachResource(root, base, visit) {
    // 已内嵌的 data: 也要按引用用途复核 MIME（播放列表不能当成已归档音视频），SVG 再查自包含。
    const handleData = (kind, url) => {
      const mimeType = offlineAssets.dataUrlMimeType(url);
      offlineAssets.assertAssetMimeType(mimeType, [kind], `${resourceKindLabel(kind)}内嵌数据地址`);
      if (mimeType === "image/svg+xml") offlineAssets.assertSelfContainedSvgDataUrl(url);
    };
    const handle = (kind, rawValue, apply) => {
      const value = String(rawValue || "").trim();
      if (!value || value.startsWith("#")) return;
      const url = absoluteUrl(value, base);
      if (/^data:/i.test(url)) {
        handleData(kind, url);
        return;
      }
      visit({ kind, url, apply });
    };
    // 内联样式用显式扫描：剥注释后检查 @import，url() 数量与可解析数量不一致时直接拒绝，不靠 CSP 掩盖。
    const handleCss = (text, applyText) => {
      if (!text) return;
      const source = text.replace(CSS_COMMENT_PATTERN, "");
      if (/@import/i.test(source)) throw new Error("内联样式包含 @import，无法离线归档");
      if (/image-set\s*\(/i.test(source)) {
        throw new Error("内联样式包含 image-set 图片候选，无法确认全部资源已归档");
      }
      // CSS 转义（\70、@im\70ort）读不出真实地址：保守拒绝这处样式，正文代码块不受影响。
      if (source.includes("\\")) {
        throw new Error(`样式包含 CSS 转义，无法解析其中的资源引用，已停止导出：${source.slice(0, 120)}`);
      }
      const matches = [...source.matchAll(CSS_URL_PATTERN)];
      const declared = (source.match(CSS_URL_CALL_PATTERN) || []).length;
      if (matches.length !== declared) {
        throw new Error(`内联样式的 url() 无法解析，已停止导出：${source.slice(0, 120)}`);
      }
      let next = source;
      for (const match of matches) {
        const raw = match[2].trim();
        if (!raw || raw.startsWith("#")) continue;
        const url = absoluteUrl(raw, base);
        if (/^data:/i.test(url)) {
          handleData(cssResourceKind(url), url);
          continue;
        }
        visit({ kind: cssResourceKind(url), url, apply: (value) => {
          next = next.replace(match[0], `url("${value}")`);
          applyText(next);
        } });
      }
      if (next !== text) applyText(next);
    };

    root.querySelectorAll("template").forEach((template) => eachResource(template.content, base, visit));

    root.querySelectorAll("img").forEach((node) => handle("image", node.getAttribute("src"), (value) => node.setAttribute("src", value)));
    root.querySelectorAll("video, audio").forEach((node) => {
      handle("media", node.getAttribute("src"), (value) => node.setAttribute("src", value));
      handle("image", node.getAttribute("poster"), (value) => node.setAttribute("poster", value));
    });
    root.querySelectorAll("source").forEach((node) => {
      const parent = node.parentElement?.tagName.toLowerCase();
      if (parent !== "video" && parent !== "audio") throw new Error("图片 <source> 未被折叠，无法确定归档地址");
      handle("media", node.getAttribute("src"), (value) => node.setAttribute("src", value));
    });
    root.querySelectorAll("track").forEach((node) => handle("track", node.getAttribute("src"), (value) => node.setAttribute("src", value)));
    root.querySelectorAll("image").forEach((node) => {
      for (const name of ["href", "xlink:href"]) {
        handle("image", node.getAttribute(name), (value) => node.setAttribute(name, value));
      }
    });
    root.querySelectorAll("a.attachment, a.lightbox").forEach((node) => {
      handle("attachment", node.getAttribute("href"), (value) => node.setAttribute("href", value));
    });
    root.querySelectorAll("[style]").forEach((node) => {
      handleCss(node.getAttribute("style"), (value) => node.setAttribute("style", value));
    });
    root.querySelectorAll("style").forEach((node) => {
      handleCss(node.textContent, (value) => { node.textContent = value; });
    });
  }

  function prepareHtmlPost(post, base) {
    const doc = new DOMParser().parseFromString(`<div>${post.cooked || ""}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    const removedScripts = stripScripts(root);
    assertArchivable(root);
    normalizeMedia(root, base);
    const resources = [];
    eachResource(root, base, ({ kind, url }) => resources.push({ kind, url }));
    return { post, body: root.innerHTML.trim(), avatarUrl: postAvatarUrl(post), resources, removedScripts };
  }

  // 头像按原站 avatar_template 的 {size} 与页面 Discourse CDN 配置解析：缺模板不虚构头像，
  // 存在但无效的模板显式失败；合法的 https 外域头像按精确域名授权后归档。
  function postAvatarUrl(post) {
    const template = post.avatar_template;
    if (!template) return "";
    const cdn = document.getElementById("data-discourse-setup")?.dataset.cdn;
    const base = new URL(cdn || location.origin);
    const url = new URL(String(template).replace("{size}", String(config.topicExport.avatarSize)), base);
    if (url.protocol !== "https:") throw new Error(`头像模板不是 https 地址：${url.href}`);
    return url.href;
  }

  async function requestMissingOrigins(origins, assertActive) {
    assertActive();
    const response = await sendRuntimeMessage({ type: "topic-export-check-origins", origins });
    if (!response?.ok) throw new Error(response?.error || "资源域名权限检查失败");
    return Array.isArray(response.missing) ? response.missing : [];
  }

  async function downloadOfflineAssets(registry, { assertActive, onProgress }) {
    const { offlineMaxTotalBytes } = config.topicExport;
    const assets = new Map();
    let embeddedBytes = 0;
    let index = 0;
    for (const [url, info] of registry) {
      assertActive();
      index += 1;
      const kinds = [...info.kinds];
      const kindLabel = kinds.map(resourceKindLabel).join(" / ");
      onProgress({ message: `正在归档 ${kindLabel}（${resourceLocation(info.floor)}）${url}`, loaded: index, total: registry.size });
      const response = await sendRuntimeMessage({ type: "topic-export-asset", url, kinds });
      if (!response?.ok) {
        if (response?.missingOrigin) {
          const error = new Error(`缺少 ${response.missingOrigin} 的访问权限（${resourceLocation(info.floor)} ${kindLabel}：${url}）。请在扩展授权页授权后重新导出。`);
          error.missingOrigins = [response.missingOrigin];
          throw error;
        }
        throw new Error(`${resourceLocation(info.floor)} ${kindLabel}归档失败：${url} —— ${response?.error || "后台没有返回归档结果"}`);
      }
      // 预算按最终文件实际写入量计算：base64 后的长度乘以引用次数（同一资源被多处引用会重复写入）。
      embeddedBytes += response.dataUrl.length * info.references;
      if (embeddedBytes > offlineMaxTotalBytes) {
        throw new Error(`内嵌资源总量超过上限 ${formatBytes(offlineMaxTotalBytes)}（已按 base64 与重复引用估算），已停止导出`);
      }
      assets.set(url, response.dataUrl);
    }
    return { assets, embeddedBytes };
  }

  async function buildOfflineHtml({ topic, topicInfo, posts, exportMode, rangeLabel }, { assertActive, onProgress }) {
    const base = topicInfo.originalUrl;
    const items = posts.map((post) => {
      try {
        return prepareHtmlPost(post, base);
      } catch (error) {
        throw new Error(`第 ${post.post_number} 楼：${error.message}`);
      }
    });
    for (const item of items) {
      if (!item.body) throw new Error(`第 ${item.post.post_number} 楼转换后没有可导出的正文`);
    }

    const removedScripts = items.reduce((total, item) => total + item.removedScripts, 0);
    const floors = new Map();
    for (const item of items) {
      for (const resource of item.resources) {
        if (!floors.has(resource.url)) floors.set(resource.url, item.post.post_number);
      }
      if (item.avatarUrl && !floors.has(item.avatarUrl)) floors.set(item.avatarUrl, item.post.post_number);
    }

    assertActive();
    onProgress("正在生成离线 HTML…");
    const html = buildHtml({ topic, topicInfo, posts: items, exportMode, rangeLabel, resourceMode: "offline", removedScripts });
    const doc = new DOMParser().parseFromString(html, "text/html");
    importSvgSymbols(doc);
    // 图标定义与 template 内容同样要过一遍被动依赖检查，不让 CSP 掩盖漏存。
    assertArchivable(doc.documentElement);
    normalizeMedia(doc.documentElement, base);

    // 生成前完整遍历被动依赖：外壳、图标定义里的资源同样必须归档，并记录引用次数与所属域名。
    const registry = new Map();
    const originSamples = new Map();
    eachResource(doc.documentElement, base, ({ kind, url }) => {
      const target = new URL(url);
      const floor = floors.get(url) || 0;
      if (target.protocol !== "https:") {
        throw new Error(`${resourceLocation(floor)} ${resourceKindLabel(kind)}不是 https 资源，无法离线归档：${url}`);
      }
      const entry = registry.get(url);
      if (entry) {
        entry.references += 1;
        entry.kinds.add(kind);
        return;
      }
      registry.set(url, { floor, references: 1, kinds: new Set([kind]) });
      if (!originSamples.has(target.origin)) originSamples.set(target.origin, { url, floor, kind });
    });

    // 纯文字、无头像的主题不需要任何权限检查。
    const origins = [...originSamples.keys()];
    const missing = origins.length ? await requestMissingOrigins(origins, assertActive) : [];
    if (missing.length) {
      const details = missing.map((origin) => {
        const sample = originSamples.get(origin);
        return `${origin}（${resourceLocation(sample.floor)} ${resourceKindLabel(sample.kind)}：${sample.url}）`;
      });
      const error = new Error(`缺少资源域名的访问权限：${details.join("；")}。请在扩展授权页授权后重新导出。`);
      error.missingOrigins = missing;
      throw error;
    }

    const { assets, embeddedBytes } = await downloadOfflineAssets(registry, { assertActive, onProgress });
    assertActive();
    onProgress("正在内嵌资源并生成单文件…");
    inlineOfflineResources(doc, base, assets);
    doc.title = topic.title;
    const summaryNode = doc.getElementById("offline-summary");
    summaryNode.innerHTML = `<strong>离线归档:</strong> ${escapeHtml(assets.size
      ? `已内嵌 ${assets.size} 个资源（base64 合计 ${formatBytes(embeddedBytes)}，已计入重复引用开销）`
      : "正文没有需要内嵌的外部资源")}`;
    const content = `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
    // 序列化后的最终文件再巡检一次：残留的远程被动依赖说明归档集合与最终文档不一致。
    const finalDoc = new DOMParser().parseFromString(content, "text/html");
    eachResource(finalDoc.documentElement, base, ({ kind, url }) => {
      throw new Error(`导出文件仍有未归档的远程被动依赖：${resourceKindLabel(kind)} ${url}`);
    });
    // 序列化后按最终单文件字节复核一次，文本与结构开销一并计入。
    const fileBytes = new Blob([content]).size;
    const { offlineMaxTotalBytes } = config.topicExport;
    if (fileBytes > offlineMaxTotalBytes) {
      throw new Error(`导出文件 ${formatBytes(fileBytes)} 超过单文件上限 ${formatBytes(offlineMaxTotalBytes)}，已停止导出`);
    }
    return {
      content,
      summary: `离线归档完成：内嵌 ${assets.size} 个资源（base64 合计 ${formatBytes(embeddedBytes)}），导出文件 ${formatBytes(fileBytes)}，无脚本、无外部依赖。`
    };
  }

  // 内联 SVG 图标（如 hashtag 的 <use href="#square-full">）依赖原站 symbol 定义，只复制真实存在的定义；
  // 克隆进来的 symbol 可能再引用其他 symbol，用队列拉平整个依赖闭包，已导入的 id 使循环终止。
  function importSvgSymbols(doc) {
    const missing = [];
    const pending = queryAllDeep(doc.documentElement, "use");
    let host = null;
    while (pending.length) {
      const node = pending.shift();
      const value = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
      if (!value.startsWith("#")) continue;
      const id = value.slice(1);
      if (!id || doc.getElementById(id)) continue;
      const source = document.getElementById(id);
      if (!source || !["symbol", "svg"].includes(source.tagName.toLowerCase())) {
        missing.push(value);
        continue;
      }
      if (!host) {
        host = document.createElementNS(SVG_NAMESPACE, "svg");
        host.setAttribute("class", "offline-symbols");
        host.setAttribute("aria-hidden", "true");
        host.setAttribute("width", "0");
        host.setAttribute("height", "0");
        doc.body.prepend(host);
      }
      const clone = source.cloneNode(true);
      host.append(clone);
      pending.push(...queryAllDeep(clone, "use"));
    }
    if (missing.length) {
      throw new Error(`SVG 图标定义在原站页面中不存在，无法离线归档：${[...new Set(missing)].join("、")}`);
    }
  }

  function absolutizeNavigationLinks(root, base) {
    queryAllDeep(root, "a[href]").forEach((node) => {
      if (node.matches("a.attachment, a.lightbox")) return;
      const value = node.getAttribute("href");
      if (!value || value.startsWith("#")) return;
      const url = new URL(absoluteUrl(value, base));
      if (!NAVIGATION_PROTOCOLS.includes(url.protocol)) {
        throw new Error(`导出文件不支持该链接协议：${url.protocol}（${value}）`);
      }
      node.setAttribute("href", url.href);
    });
  }

  function attachmentFilename(node, url) {
    const declared = node.getAttribute("download");
    if (declared) return declared;
    const name = new URL(url).pathname.split("/").filter(Boolean).pop() || "attachment";
    return decodeURIComponent(name);
  }

  function inlineOfflineResources(doc, base, assets) {
    const attachments = new Map();
    eachResource(doc.documentElement, base, ({ kind, url, apply }) => {
      const dataUrl = assets.get(url);
      if (!dataUrl) throw new Error(`离线导出生成了未归档的被动依赖：${resourceKindLabel(kind)} ${url}`);
      apply(dataUrl);
      if (kind === "attachment") attachments.set(url, dataUrl);
    });
    for (const [url, dataUrl] of attachments) {
      for (const node of queryAllDeep(doc.documentElement, "a.attachment, a.lightbox")) {
        if (node.getAttribute("href") !== dataUrl) continue;
        node.setAttribute("download", attachmentFilename(node, url));
      }
    }
    absolutizeNavigationLinks(doc.documentElement, base);
  }

  function sendRuntimeMessage(message) {
    const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== "function") {
      return Promise.reject(new Error("扩展后台消息 API 不可用"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const onResponse = (response) => {
        const error = runtime.lastError;
        if (error) {
          settle(reject, new Error(error.message));
          return;
        }
        settle(resolve, response);
      };
      try {
        const usePromiseApi = Boolean(globalThis.browser);
        const result = usePromiseApi ? runtime.sendMessage(message) : runtime.sendMessage(message, onResponse);
        if (result?.then) result.then((response) => settle(resolve, response)).catch((error) => settle(reject, error));
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  // ---- 上游复用：范围解析 ----

  const POST_ONLY_ALIASES = new Set(["post", "main", "主帖"]);

  function parseRange(input) {
    const raw = String(input || "").trim();
    const normalized = raw.toLowerCase();

    if (!raw || normalized === "all" || raw === "全部") {
      return { kind: "all", label: raw || "all", postNumbers: null };
    }

    // 已加载回复只导出页面里已有的楼层，不补读服务端。
    if (normalized === "loaded" || raw === "已加载回复") {
      return { kind: "loaded", label: raw || "loaded", postNumbers: null };
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

  function buildHtml({ topic, topicInfo, posts, exportMode, rangeLabel, resourceMode, removedScripts }) {
    const isOffline = resourceMode === "offline";
    const content = exportMode === "nest"
      ? renderNestedPostsHtml(posts)
      : renderFlatPostsHtml(posts);
    const meta = [
      `<div><strong>原始链接:</strong> <a href="${escapeHtmlAttribute(topicInfo.originalUrl)}">${escapeHtml(topicInfo.originalUrl)}</a></div>`,
      `<div><strong>导出模式:</strong> ${escapeHtml(exportMode)}</div>`,
      `<div><strong>导出格式:</strong> HTML（${isOffline ? "完全离线内嵌" : "远程引用"}）</div>`,
      `<div><strong>导出时间:</strong> ${escapeHtml(new Date().toLocaleString())}</div>`,
      `<div><strong>楼层范围:</strong> ${escapeHtml(rangeLabel)}</div>`,
      isOffline ? '<div id="offline-summary"></div>' : "<div><strong>资源保存:</strong> 远程地址，未下载内嵌</div>",
    ];
    if (removedScripts) {
      meta.push(`<div><strong>已移除脚本:</strong> ${removedScripts} 个，导出文件不执行任何脚本</div>`);
    }

    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="${isOffline ? OFFLINE_CSP : REMOTE_CSP}">`,
      `<title>${escapeHtml(topic.title)}</title>`,
      `<style>${htmlExportCss()}</style>`,
      "</head>",
      "<body>",
      '<main class="page">',
      `<h1>${escapeHtml(topic.title)}</h1>`,
      '<section class="topic-meta">',
      ...meta,
      `<p class="export-note">${escapeHtml(isOffline ? OFFLINE_LINK_NOTE : REMOTE_ASSET_NOTE)}</p>`,
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
    return items.map((item) => renderPostNodeHtml(item, 0, "")).join("\n");
  }

  // 嵌套保持真实父子结构；超出 htmlMaxDepth 只停止继续缩进，不断开父子关系。
  function renderPostNodeHtml(item, depth, childrenHtml) {
    const capped = depth >= config.topicExport.htmlMaxDepth;
    const meta = [`<span>时间: ${escapeHtml(formatDate(item.post.created_at))}</span>`];
    if (item.post.reply_to_post_number) {
      meta.push(`<span>回复: #${escapeHtml(item.post.reply_to_post_number)}</span>`);
    }
    const avatar = item.avatarUrl
      ? `<img class="post-avatar" src="${escapeHtmlAttribute(item.avatarUrl)}" alt="" width="26" height="26">`
      : "";

    return [
      `<div class="post-node${capped ? " post-node--capped" : ""}${childrenHtml ? " post-node--parent" : ""}" data-depth="${depth}">`,
      `<article class="post" id="post-${escapeHtml(item.post.post_number)}">`,
      '<header class="post-header">',
      avatar,
      '<div class="post-identity">',
      `<div class="post-title">#${escapeHtml(item.post.post_number)} ${escapeHtml(formatAuthor(item.post))}</div>`,
      `<div class="post-meta">${meta.join("")}</div>`,
      "</div>",
      "</header>",
      `<div class="post-body">${item.body}</div>`,
      "</article>",
      childrenHtml ? `<div class="post-children">${childrenHtml}</div>` : "",
      "</div>",
    ].filter(Boolean).join("\n");
  }

  function renderNestedNodeHtml(node, depth) {
    const children = node.children.map((child) => renderNestedNodeHtml(child, depth + 1)).join("\n");
    return renderPostNodeHtml(node, depth, children);
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

    const html = roots.map((root) => renderNestedNodeHtml(root, 0));
    if (outOfRangeParents.length) {
      // 范围外父级是独立根节点，不连到虚假父级上。
      html.push('<h2 class="section-title">范围外父级回复</h2>');
      for (const node of outOfRangeParents) html.push(renderNestedNodeHtml(node, 0));
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
      .export-note { margin: 6px 0 0; color: #64748b; font-size: 13px; line-height: 1.6; }
      .offline-symbols { position: absolute; width: 0; height: 0; overflow: hidden; }
      .posts { display: grid; gap: 14px; }
      .post-node { position: relative; min-width: 0; }
      .post {
        position: relative;
        min-width: 0;
        border: 1px solid #dbe3ea;
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }
      /* 有子回复的楼层：从头像中心（卡内 26px）向下贯穿正文与下间隙，压在正文之下 */
      .post-node--parent > .post { isolation: isolate; }
      .post-node--parent > .post::after {
        content: "";
        position: absolute;
        left: 28px;
        top: 26px;
        bottom: 0;
        border-left: 1px solid #cbd5e1;
        z-index: -1;
      }
      .post-header {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid #e2e8f0;
      }
      .post-avatar {
        flex: none;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #e2e8f0;
        object-fit: cover;
      }
      .post-identity { display: grid; gap: 6px; min-width: 0; }
      /* 回复树连线：容器竖干与子分支弧线由伪元素绘制
         几何：子节点 padding-top 14 + 卡边框 1 + header padding 12 + 头像半高 13 = 头像中心 40px
         容器竖干与父头像中心对齐（28px），末位兄弟的竖干止于自身头像中心 */
      .post-children {
        position: relative;
        display: grid;
        margin-left: 28px;
        margin-top: 12px;
        padding-left: 22px;
      }
      .post-children::before {
        content: "";
        position: absolute;
        left: 0;
        top: -12px;
        height: 12px;
        border-left: 1px solid #cbd5e1;
      }
      .post-children > .post-node { padding-top: 14px; }
      .post-children > .post-node::before {
        content: "";
        position: absolute;
        left: -22px;
        top: 0;
        bottom: 0;
        border-left: 1px solid #cbd5e1;
      }
      /* 弧线水平段从容器竖干延伸到子头像左缘（经卡边框与左 padding 14px） */
      .post-children > .post-node::after {
        content: "";
        position: absolute;
        left: -22px;
        top: 28px;
        width: 37px;
        height: 12px;
        border-left: 1px solid #cbd5e1;
        border-bottom: 1px solid #cbd5e1;
        border-bottom-left-radius: 12px;
      }
      .post-children > .post-node:last-child::before { bottom: auto; height: 28px; }
      /* 超过缩进上限后保留真实父子结构，不再继续缩进也不画连线 */
      .post-node--capped > .post::after { display: none; }
      .post-node--capped > .post-children { margin-left: 0; padding-left: 0; }
      .post-node--capped > .post-children > .post-node { padding-top: 8px; }
      .post-node--capped > .post-children::before,
      .post-node--capped > .post-children > .post-node::before,
      .post-node--capped > .post-children > .post-node::after { display: none; }
      /* 窄屏：嵌套到第 3 层后同样停止缩进与连线（保留真实父子结构），避免缩进吃掉正文宽度 */
      @media (max-width: 600px) {
        .post-children .post-children .post-children { margin-left: 0; padding-left: 0; }
        .post-children .post-children .post-children > .post-node { padding-top: 8px; }
        .post-children .post-children .post-children::before,
        .post-children .post-children .post-children > .post-node::before,
        .post-children .post-children .post-children > .post-node::after { display: none; }
      }
      .post-title { font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
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
      /* 有子回复的楼层：正文为左侧竖线（落在头像中心 28px）留出 gutter，线不穿正文文字 */
      .post-node--parent > .post > .post-body { padding-left: 44px; }
      /* 只约束原站图标 class：hashtag 等内联图标没有宽高，默认按 300x150 渲染成黑块 */
      .post-body svg.d-icon {
        width: 1em;
        height: 1em;
        fill: currentColor;
        vertical-align: middle;
      }
      .post-body .hashtag-cooked {
        display: inline-flex;
        align-items: center;
        gap: 0.25em;
      }
      .post-body img {
        max-width: 100%;
        height: auto;
      }
      .post-body iframe,
      .post-body video,
      .post-body audio {
        max-width: 100%;
      }
      .post-body table {
        display: block;
        width: max-content;
        max-width: 100%;
        overflow-x: auto;
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
