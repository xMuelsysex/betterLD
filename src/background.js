(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (typeof importScripts === "function") {
    if (!globalThis.BETTERLD_CONFIG) importScripts(api.runtime.getURL("betterld.config.js"));
    if (!globalThis.BETTERLD_OFFLINE_ASSETS) importScripts("offline-assets.js");
    if (!globalThis.BETTERLD_LIBRARY_ENTRY) importScripts("library-entry.js");
    if (!globalThis.BETTERLD_WEBDAV) importScripts("webdav.js");
    // 只借 searchUrl 构造引擎请求地址；后台没有 DOMParser，HTML 解析留在内容脚本
    if (!globalThis.BETTERLD_EXTERNAL_SEARCH) importScripts("external-search.js");
  }

  const config = globalThis.BETTERLD_CONFIG;
  const entry = globalThis.BETTERLD_LIBRARY_ENTRY;
  const externalSearch = globalThis.BETTERLD_EXTERNAL_SEARCH;
  const offlineAssets = globalThis.BETTERLD_OFFLINE_ASSETS;
  const webdav = globalThis.BETTERLD_WEBDAV.createWebdavApi(fetch);
  if (!api?.runtime?.onMessage || !api.tabs?.create) {
    return;
  }

  function isTrustedSender(sender) {
    const url = sender?.tab?.url || sender?.url;
    if (!url) {
      return true;
    }
    return isLinuxDoPage(url) || url.startsWith(api.runtime.getURL(""));
  }

  async function handleWebdav(message, sender) {
    if (!isTrustedSender(sender)) {
      return { ok: false, error: "请求来源无效" };
    }
    const originPattern = webdav.originPattern(message.url);
    if (!originPattern) {
      return { ok: false, error: "WebDAV 地址无效：只接受 https:// 地址，http:// 仅允许本机地址" };
    }
    const granted = await api.permissions.contains({ origins: [originPattern] });
    if (!granted) {
      return { ok: false, error: "缺少该地址的访问权限，请在设置窗口重新保存 WebDAV 地址" };
    }
    return webdav.request({
      method: message.method,
      url: message.url,
      username: message.username,
      password: message.password,
      body: message.body
    });
  }

  function isLinuxDoPage(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://linux.do" || url.origin === "https://www.linux.do";
    } catch {
      return false;
    }
  }

  function createTab(options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      const onCreated = (tab) => {
        if (api.runtime.lastError) {
          finish(reject, new Error(api.runtime.lastError.message));
          return;
        }
        finish(resolve, { ok: true, tabId: tab?.id ?? null });
      };
      try {
        const usePromiseApi = globalThis.browser && api === globalThis.browser;
        const result = usePromiseApi
          ? api.tabs.create(options)
          : api.tabs.create(options, onCreated);
        if (result?.then) {
          result.then(onCreated).catch((error) => finish(reject, error));
        }
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  // 只在设置界面主动点击时调用一次：比对 GitHub Releases 的最新 tag，不做自动轮询、不自动更新
  async function handleCheckUpdate(sender) {
    if (!isTrustedSender(sender)) {
      return { ok: false, error: "请求来源无效" };
    }
    const response = await fetch(config.versionCheckUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      return { ok: false, error: `版本接口返回 ${response.status}` };
    }
    const data = await response.json();
    const latestTag = String(data?.tag_name || "").trim();
    if (!latestTag) {
      return { ok: false, error: "版本接口没有返回 tag" };
    }
    return { ok: true, latestTag };
  }

  async function handleOpenExternalSearchSettings(sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    return createTab({ url: api.runtime.getURL("src/options.html#externalSearchEngine"), active: true });
  }

  // 外部搜索引擎兜底：只发 GET，不做解析、不自动申请权限、失败不换引擎
  async function handleExternalSearch(message, sender) {
    if (!isTrustedSender(sender)) {
      return { ok: false, error: "请求来源无效" };
    }
    const engine = String(message.engine || "");
    const searchUrl = externalSearch.searchUrl(engine, String(message.query || ""));
    const label = config.externalSearch?.engines?.[engine]?.label || engine;
    const granted = await api.permissions.contains({ origins: [`${new URL(searchUrl).origin}/*`] });
    if (!granted) {
      return { ok: false, error: `缺少 ${label} 的访问权限，请在设置 → 页面 → 搜索 → 外部搜索中打开扩展授权页，或点击「重新申请访问权限」` };
    }
    const timeoutMs = config.externalSearch.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(searchUrl, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal
      });
      if (!response.ok) {
        return { ok: false, error: `${label} 返回 HTTP ${response.status}` };
      }
      return { ok: true, html: await response.text(), searchUrl, engine };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, error: `${label} 请求超时（${timeoutMs}ms）` };
      }
      return { ok: false, error: `${label} 请求失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 完全离线 HTML 导出的资源归档 ----

  // 原站自有上传可能需要登录会话才能读取，其他资源域名一律不带凭据。
  const offlineCredentialOrigins = new Set(["https://linux.do", "https://www.linux.do"]);

  function offlinePermissionKey() {
    return config.topicExport.offlinePermissionStorageKey;
  }

  async function rememberOfflineOrigins(origins) {
    const key = offlinePermissionKey();
    const stored = await api.storage.local.get(key);
    const value = stored[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error("离线导出授权域名存储格式异常，原数据保持不变");
    }
    // 存储值同样按精确 https origin 校验，避免被改写的存储绕过请求范围。
    const known = new Set((value || []).map(offlineOrigin));
    const added = origins.map(offlineOrigin).filter((origin) => !known.has(origin));
    if (!added.length) return;
    await api.storage.local.set({ [key]: [...known, ...added] });
  }

  function offlineOrigin(value) {
    const origin = String(value);
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw new Error(`离线导出只接受 https 资源域名：${origin}`);
    }
    return origin;
  }

  function offlineOriginPattern(value) {
    return `${offlineOrigin(value)}/*`;
  }

  function offlineAssetMimeType(contentType, url) {
    const value = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) {
      throw new Error(`资源没有返回可用的 MIME 类型：${url}`);
    }
    if (value === "text/html" || value === "application/xhtml+xml") {
      throw new Error(`资源返回了 HTML 页面，可能是错误页：${url}`);
    }
    return value;
  }

  async function readBoundedBody(response, maxBytes, url) {
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error(`资源大小超过单文件上限 ${maxBytes} 字节：${url}`);
      return buffer;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`资源大小超过单文件上限 ${maxBytes} 字节：${url}`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  // 后台可能是 Chrome service worker 或 Firefox 后台页，两者都有 btoa，不能依赖 FileReader。
  function encodeBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  // 下载的 SVG 会作为 data URL 内嵌，必须自包含：脚本、foreignObject、事件属性与外部引用都显式失败。
  async function handleTopicExportCheckOrigins(message, sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    if (!Array.isArray(message.origins) || !message.origins.length) {
      return { ok: false, error: "离线导出没有提供资源域名清单" };
    }
    const patterns = message.origins.map((origin) => offlineOriginPattern(origin));
    const missing = [];
    for (const [index, pattern] of patterns.entries()) {
      if (!await api.permissions.contains({ origins: [pattern] })) missing.push(String(message.origins[index]));
    }
    if (missing.length) await rememberOfflineOrigins(missing);
    return { ok: true, missing };
  }

  async function handleTopicExportAsset(message, sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    const target = new URL(String(message.url || ""));
    if (target.protocol !== "https:") return { ok: false, error: `离线导出只接受 https 资源地址：${target.href}` };
    if (!await api.permissions.contains({ origins: [offlineOriginPattern(target.origin)] })) {
      await rememberOfflineOrigins([target.origin]);
      return { ok: false, missingOrigin: target.origin, error: `缺少 ${target.origin} 的访问权限` };
    }
    const { offlineFetchTimeoutMs, offlineMaxAssetBytes } = config.topicExport;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), offlineFetchTimeoutMs);
    try {
      const response = await fetch(target.href, {
        method: "GET",
        credentials: offlineCredentialOrigins.has(target.origin) ? "include" : "omit",
        // 跟随重定向会把归档目标换成别的地址（可能换域），这里直接失败并报告，不做多级抓取。
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const mimeType = offlineAssetMimeType(response.headers.get("content-type"), target.href);
      offlineAssets.assertAssetMimeType(mimeType, message.kinds, target.href);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > offlineMaxAssetBytes) {
        return { ok: false, error: `资源大小 ${declared} 字节超过单文件上限 ${offlineMaxAssetBytes} 字节` };
      }
      const bytes = await readBoundedBody(response, offlineMaxAssetBytes, target.href);
      if (mimeType === "image/svg+xml") offlineAssets.assertSelfContainedSvgBytes(bytes, target.href);
      return { ok: true, mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${encodeBase64(bytes)}` };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: `资源请求超时（${offlineFetchTimeoutMs}ms）` };
      // redirect: "error" 下要求重定向的地址只会以网络错误失败，明确报告而不是静默当成空资源。
      if (error instanceof TypeError) {
        return { ok: false, error: `资源需要重定向或无法直连，离线归档不跟随重定向：${target.href}` };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleOpenTopicExportSettings(sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    return createTab({ url: api.runtime.getURL("src/options.html#topicExportOffline"), active: true });
  }

  let libraryQueue = Promise.resolve();

  async function toggleLibrary(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (typeof message.remove !== "boolean") throw new Error("收藏增删意图必须为布尔值");
    if (!["later", "favorites"].includes(message.group)) throw new Error("未知收藏分类");
    const topic = message.topic;
    entry.validate(topic);
    if (message.group === "later" && topic.postNumber !== undefined) throw new Error("稍后再看只保存主题");
    const stored = await api.storage.local.get(config.libraryStorageKey);
    const library = stored[config.libraryStorageKey] ?? { later: [], favorites: [] };
    if (!Array.isArray(library.later) || !Array.isArray(library.favorites)) throw new Error("收藏存储格式异常，原数据保持不变");
    const items = library[message.group];
    const existing = items.findIndex((item) => entry.key(item) === entry.key(topic));
    if (message.remove) {
      if (existing >= 0) items.splice(existing, 1);
    } else if (existing < 0) {
      items.unshift({ id: String(topic.id), ...(topic.postNumber === undefined ? {} : { postNumber: topic.postNumber }), title: topic.title.trim().slice(0, config.libraryTitleMaxLength), href: entry.href(topic), savedAt: Date.now() });
    }
    await api.storage.local.set({ [config.libraryStorageKey]: library });
    return { ok: true, library };
  }

  async function handleOpenDnsSettings(sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    const guide = config.browserDnsGuides[/Firefox\//.test(navigator.userAgent) ? "firefox" : "chrome"];
    if (!guide.canOpen) return { ok: false, error: `${guide.label} 限制扩展打开此设置，请复制 ${guide.url} 到地址栏` };
    return createTab({ url: guide.url, active: true });
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "library-toggle") {
      const request = libraryQueue.then(() => toggleLibrary(message, sender));
      libraryQueue = request.then(() => undefined, () => undefined);
      request.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "open-dns-settings") {
      handleOpenDnsSettings(sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "open-external-search-settings") {
      handleOpenExternalSearchSettings(sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "open-topic-export-settings") {
      handleOpenTopicExportSettings(sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "topic-export-check-origins") {
      handleTopicExportCheckOrigins(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "资源域名权限检查失败" }));
      return true;
    }
    if (message?.type === "topic-export-asset") {
      handleTopicExportAsset(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "资源归档失败" }));
      return true;
    }
    if (message?.type === "external-search") {
      handleExternalSearch(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "外部搜索请求失败" }));
      return true;
    }
    if (message?.type === "webdav") {
      handleWebdav(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "WebDAV 请求失败" }));
      return true;
    }
    if (message?.type === "check-update") {
      handleCheckUpdate(sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "检查更新失败" }));
      return true;
    }
    if (message?.type !== "open-link") {
      return undefined;
    }
    const senderUrl = sender?.tab?.url;
    const targetUrl = message.url;
    if (!isLinuxDoPage(senderUrl) || !isLinuxDoPage(targetUrl)) {
      sendResponse({ ok: false, error: "请求来源或目标链接无效" });
      return undefined;
    }
    createTab({ url: targetUrl, active: message.active === true })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "标签页创建失败" }));
    return true;
  });
})();
