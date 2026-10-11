/*
 * betterLD · 离线导出的资源归档规则
 *
 * 后台（Chrome service worker / Firefox 后台页）与内容脚本共用同一套判断，避免两处规则漂移：
 * - SVG 必须自包含：脚本、foreignObject、内联事件属性、DTD/实体、@import 与外部引用都显式失败；
 *   空值与 #fragment 是合法的内部引用，data: 引用按 MIME 递归检查；
 *   读不出真实引用时（CSS 转义、非 UTF-8 编码）显式拒绝，不当作已归档；
 * - 资源 MIME 必须满足引用它的全部用途，播放列表等非独立资源不能当作已归档音视频。
 */
(() => {
  "use strict";

  const SVG_MIME_TYPE = "image/svg+xml";
  const DEFAULT_DATA_MIME_TYPE = "text/plain";
  const DATA_MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
  const FONT_MIME_PATTERN = /^(?:font\/|application\/(?:font|vnd\.ms-fontobject|x-font))/i;
  const XML_DECLARATION_PATTERN = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i;
  const XML_DECLARATION_WINDOW = 512;

  const SCRIPT_PATTERN = /<script[\s>]/i;
  const FOREIGN_OBJECT_PATTERN = /<foreignObject[\s>]/i;
  const INLINE_EVENT_PATTERN = /\son[a-z]+\s*=/i;
  // DTD 与自定义实体可能引用外部资源，也会让引用扫描读不到真实地址。
  const DOCTYPE_PATTERN = /<!DOCTYPE|<!ENTITY/i;
  const ENTITY_REFERENCE_PATTERN = /&([^;\s&]{1,32});/g;
  const PREDEFINED_ENTITY_PATTERN = /^(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+)$/i;
  const HREF_PATTERN = /(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi;
  const URL_PATTERN = /url\(\s*["']?([^"')]*)["']?\s*\)/gi;
  const URL_CALL_PATTERN = /url\s*\(/gi;
  const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*["']([^"']*)["']/gi;
  const AT_IMPORT_PATTERN = /@import/i;

  // 分段流媒体播放列表不是独立资源，离线归档后无法播放。
  const PLAYLIST_MIME_TYPES = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
    "application/dash+xml"
  ]);

  const MIME_RULES = Object.freeze({
    image: Object.freeze({ test: (value) => value.startsWith("image/"), hint: "图片需要 image/* 类型" }),
    media: Object.freeze({
      test: (value) => (value.startsWith("video/") || value.startsWith("audio/")) && !PLAYLIST_MIME_TYPES.has(value),
      hint: "媒体需要 video/* 或 audio/* 的独立资源类型"
    }),
    track: Object.freeze({ test: (value) => value === "text/vtt", hint: "字幕轨需要 text/vtt 类型" }),
    font: Object.freeze({ test: isFontMimeType, hint: "字体需要 font/* 类型" }),
    attachment: Object.freeze({ test: () => true, hint: "附件需要非 HTML 内容" })
  });

  function shorten(value) {
    return String(value).slice(0, 64);
  }

  function isFontMimeType(mimeType) {
    return FONT_MIME_PATTERN.test(mimeType);
  }

  // RFC 2397：省略类型时是 text/plain；类型读不出来时显式失败，不猜。
  function dataUrlMimeType(dataUrl) {
    const separator = dataUrl.indexOf(",");
    if (separator < 0) throw new Error(`内嵌数据地址无法解析：${shorten(dataUrl)}`);
    const declared = dataUrl.slice(0, separator).replace(/^data:/i, "").split(";")[0].trim().toLowerCase();
    const mimeType = declared || DEFAULT_DATA_MIME_TYPE;
    if (!DATA_MIME_PATTERN.test(mimeType)) {
      throw new Error(`内嵌数据地址的类型无法解析：${shorten(dataUrl)}`);
    }
    return mimeType;
  }

  function base64ToBytes(payload, label) {
    let binary;
    try {
      binary = atob(payload);
    } catch (error) {
      throw new Error(`内嵌 SVG 数据地址无法解析：${label}（${error.message}）`);
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  // base64 与百分号编码都回到字节再按 UTF-8 读文本：atob 只给 latin1，读不出 UTF-16/BOM 里的真实引用。
  function svgBytesFromDataUrl(dataUrl, label) {
    const separator = dataUrl.indexOf(",");
    if (separator < 0) throw new Error(`内嵌 SVG 数据地址无法解析：${label}`);
    const meta = dataUrl.slice(0, separator);
    const payload = dataUrl.slice(separator + 1);
    if (/;base64/i.test(meta)) return base64ToBytes(payload, label);
    try {
      return new TextEncoder().encode(decodeURIComponent(payload));
    } catch (error) {
      throw new Error(`内嵌 SVG 数据地址无法解析：${label}（${error.message}）`);
    }
  }

  function styleSources(text) {
    const sources = [];
    for (const match of text.matchAll(STYLE_BLOCK_PATTERN)) sources.push(match[1]);
    for (const match of text.matchAll(STYLE_ATTRIBUTE_PATTERN)) sources.push(match[1]);
    return sources;
  }

  // 单个引用值：空值与 #fragment 是自包含的内部引用，data: 按字节递归，其余一律拒绝。
  function assertSvgReferenceSelfContained(rawValue, label) {
    const value = String(rawValue || "").trim();
    if (!value || value.startsWith("#")) return;
    // XML 实体（&#104;ttps、&#61;）会在解析后变成另一个地址，正则读不出真实值：显式拒绝，不做实体解码。
    if (value.includes("&")) {
      throw new Error(`SVG 资源的引用值包含 XML 实体，无法确认自包含：${label}（${shorten(value)}）`);
    }
    if (!/^data:/i.test(value)) {
      throw new Error(`SVG 资源包含外部引用，无法离线归档：${label}（${shorten(value)}）`);
    }
    if (dataUrlMimeType(value) !== SVG_MIME_TYPE) return;
    assertSelfContainedSvgBytes(svgBytesFromDataUrl(value, label), label);
  }

  function assertSvgTextSelfContained(text, label) {
    if (SCRIPT_PATTERN.test(text)) throw new Error(`SVG 资源包含脚本，无法离线归档：${label}`);
    if (FOREIGN_OBJECT_PATTERN.test(text)) throw new Error(`SVG 资源包含 foreignObject，无法离线归档：${label}`);
    if (INLINE_EVENT_PATTERN.test(text)) throw new Error(`SVG 资源包含内联事件属性，无法离线归档：${label}`);
    if (DOCTYPE_PATTERN.test(text)) throw new Error(`SVG 资源包含 DTD 或实体声明，无法确认自包含：${label}`);
    for (const match of text.matchAll(ENTITY_REFERENCE_PATTERN)) {
      if (!PREDEFINED_ENTITY_PATTERN.test(match[1])) {
        throw new Error(`SVG 资源引用了自定义 XML 实体 &${match[1]};，无法确认自包含：${label}`);
      }
    }
    // CSS 转义（\70、u\72l(...)）在样式与表现属性里都能出现，正则读不出真实地址：整个 SVG 出现反斜杠就拒绝。
    if (text.includes("\\")) {
      throw new Error(`SVG 资源包含 CSS 转义序列，无法确认自包含：${label}`);
    }
    for (const source of styleSources(text)) {
      if (AT_IMPORT_PATTERN.test(source)) throw new Error(`SVG 资源的样式包含 @import，无法离线归档：${label}`);
    }
    for (const match of [...text.matchAll(HREF_PATTERN), ...text.matchAll(URL_PATTERN)]) {
      assertSvgReferenceSelfContained(match[1], label);
    }
    // url() 数量与可解析数量不一致说明还有读不出的写法，不能当成没有引用。
    const declaredUrls = (text.match(URL_CALL_PATTERN) || []).length;
    const parsedUrls = [...text.matchAll(URL_PATTERN)].length;
    if (declaredUrls !== parsedUrls) {
      throw new Error(`SVG 资源的 url() 无法解析，无法确认自包含：${label}`);
    }
  }

  // 外部 SVG 只支持 UTF-8：其他编码读出的文本可能漏掉真实引用，显式拒绝而不是继续正则。
  function assertSelfContainedSvgBytes(bytes, label) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`SVG 资源不是有效的 UTF-8 编码，无法确认是否自包含：${label}`);
    }
    if (text.includes("\u0000")) throw new Error(`SVG 资源包含 NUL 字符，无法确认自包含：${label}`);
    const declared = XML_DECLARATION_PATTERN.exec(text.slice(0, XML_DECLARATION_WINDOW));
    if (declared && !/^utf-?8$/i.test(declared[1].trim())) {
      throw new Error(`SVG 资源声明的编码 ${declared[1]} 不是 UTF-8，无法确认是否自包含：${label}`);
    }
    assertSvgTextSelfContained(text, label);
  }

  // 正文里已经内嵌的 data:image/svg 同样可能有远程依赖，不能跳过检查。
  function assertSelfContainedSvgDataUrl(dataUrl) {
    const label = shorten(dataUrl);
    assertSelfContainedSvgBytes(svgBytesFromDataUrl(dataUrl, label), label);
  }

  function assertAssetMimeType(mimeType, kinds, label) {
    if (!Array.isArray(kinds) || !kinds.length) {
      throw new Error(`资源缺少用途说明，无法确认归档结果：${label}`);
    }
    for (const kind of kinds) {
      const rule = MIME_RULES[kind];
      if (!rule) throw new Error(`未知的资源用途 ${kind}：${label}`);
      if (!rule.test(mimeType)) throw new Error(`${label} 返回 ${mimeType}，${rule.hint}`);
    }
  }

  globalThis.BETTERLD_OFFLINE_ASSETS = Object.freeze({
    assertSelfContainedSvgBytes,
    assertSelfContainedSvgDataUrl,
    assertAssetMimeType,
    dataUrlMimeType,
    isFontMimeType
  });
})();
