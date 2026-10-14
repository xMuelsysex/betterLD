(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (typeof importScripts === "function") {
    if (!globalThis.BETTERLD_CONFIG) importScripts(api.runtime.getURL("betterld.config.js"));
    if (!globalThis.BETTERLD_OFFLINE_ASSETS) importScripts("offline-assets.js");
    if (!globalThis.BETTERLD_LIBRARY_ENTRY) importScripts("library-entry.js");
    if (!globalThis.BETTERLD_LIBRARY_STORE) importScripts("library-store.js");
    if (!globalThis.BETTERLD_USER_MARKS) importScripts("user-marks.js");
    if (!globalThis.BETTERLD_STICKER_STORE) importScripts("sticker-store.js");
    if (!globalThis.BETTERLD_STICKER_DB) importScripts("sticker-db.js");
    if (!globalThis.BETTERLD_WEBDAV) importScripts("webdav.js");
    // 只借 searchUrl 构造引擎请求地址；后台没有 DOMParser，HTML 解析留在内容脚本
    if (!globalThis.BETTERLD_EXTERNAL_SEARCH) importScripts("external-search.js");
  }

  const config = globalThis.BETTERLD_CONFIG;
  const offlineAssets = globalThis.BETTERLD_OFFLINE_ASSETS;
  const entry = globalThis.BETTERLD_LIBRARY_ENTRY;
  const libraryStore = globalThis.BETTERLD_LIBRARY_STORE;
  const userMarks = globalThis.BETTERLD_USER_MARKS;
  const stickerStore = globalThis.BETTERLD_STICKER_STORE;
  const sticker = config.stickerLibrary;
  const stickerDb = globalThis.BETTERLD_STICKER_DB.createStickerDb(indexedDB);
  const externalSearch = globalThis.BETTERLD_EXTERNAL_SEARCH;
  const webdav = globalThis.BETTERLD_WEBDAV.createWebdavApi(fetch, config.webdavMaxBodyLength);
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

  // 设置页深链只接受已知字段，避免任意 hash 被当成定位目标
  const settingsHashTargets = new Set(["externalSearchEngine", "libraryWebdavUrl", "stickerOrigins"]);

  async function handleOpenSettingsAt(message, sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    const hash = String(message.hash || "");
    if (!settingsHashTargets.has(hash)) return { ok: false, error: "未知的设置定位目标" };
    return createTab({ url: api.runtime.getURL(`src/options.html#${hash}`), active: true });
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
  let userMarksQueue = Promise.resolve();

  async function readStoredLibrary() {
    const stored = await api.storage.local.get(config.libraryStorageKey);
    return libraryStore.read(stored[config.libraryStorageKey]);
  }

  async function writeStoredLibrary(library) {
    await api.storage.local.set({ [config.libraryStorageKey]: library });
    return library;
  }

  // 私人标记的增删跨标签串行：先读当前存储，校验后写回完整对象。
  async function writeUserMark(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const stored = await api.storage.local.get(config.userMarksStorageKey);
    const marks = userMarks.normalize(stored[config.userMarksStorageKey]);
    const next = message.remove ? userMarks.remove(marks, message.userId) : userMarks.upsert(marks, message.mark);
    await api.storage.local.set({ [config.userMarksStorageKey]: next });
    return { ok: true, marks: next };
  }

  async function toggleLibrary(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (typeof message.remove !== "boolean") throw new Error("收藏增删意图必须为布尔值");
    if (!["later", "favorites"].includes(message.group)) throw new Error("未知收藏分类");
    const topic = message.topic;
    entry.validate(topic);
    if (message.group === "later" && topic.postNumber !== undefined) throw new Error("稍后再看只保存主题");
    const library = await readStoredLibrary();
    const items = library[message.group];
    const existing = items.findIndex((item) => entry.key(item) === entry.key(topic));
    if (message.remove) {
      if (existing >= 0) items.splice(existing, 1);
    } else if (existing < 0) {
      items.unshift(libraryStore.record(topic));
    }
    return { ok: true, library: await writeStoredLibrary(library) };
  }

  async function createFolder(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const name = libraryStore.folderName(message.name);
    const library = await readStoredLibrary();
    if (library.folders.length >= config.libraryFoldersMax) throw new Error(`收藏分组数量已达上限 ${config.libraryFoldersMax}`);
    library.folders.push({ id: libraryStore.uniqueFolderId(library), name });
    return { ok: true, library: await writeStoredLibrary(library) };
  }

  async function renameFolder(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const name = libraryStore.folderName(message.name);
    const library = await readStoredLibrary();
    const folder = library.folders.find((item) => item.id === message.id);
    if (!folder) throw new Error("收藏分组不存在");
    folder.name = name;
    return { ok: true, library: await writeStoredLibrary(library) };
  }

  // 删除分组只移除分组本身，收藏回到未分类，收藏条目与原站书签都不动。
  async function deleteFolder(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const library = await readStoredLibrary();
    const index = library.folders.findIndex((item) => item.id === message.id);
    if (index < 0) throw new Error("收藏分组不存在");
    library.folders.splice(index, 1);
    library.favorites.forEach((item) => {
      if (item.folderId === message.id) delete item.folderId;
    });
    return { ok: true, library: await writeStoredLibrary(library) };
  }

  async function moveLibraryItem(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (message.folderId !== null && typeof message.folderId !== "string") throw new Error("收藏目标分组无效");
    const topic = message.topic;
    entry.validate(topic);
    const library = await readStoredLibrary();
    const item = library.favorites.find((entryItem) => entry.key(entryItem) === entry.key(topic));
    if (!item) throw new Error("收藏条目不存在");
    if (message.folderId === null) {
      delete item.folderId;
    } else {
      if (!library.folders.some((folder) => folder.id === message.folderId)) throw new Error("收藏分组不存在");
      item.folderId = message.folderId;
    }
    return { ok: true, library: await writeStoredLibrary(library) };
  }

  // 导入按当前最新数据追加去重；dryRun 只预览摘要，不写存储。
  async function importLibrary(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const incoming = libraryStore.readImport(message.payload);
    const current = await readStoredLibrary();
    const { library, summary } = libraryStore.merge(current, incoming);
    if (message.dryRun === true) {
      return { ok: true, summary };
    }
    return { ok: true, summary, library: await writeStoredLibrary(library) };
  }

  const libraryHandlers = {
    "library-toggle": toggleLibrary,
    "library-folder-create": createFolder,
    "library-folder-rename": renameFolder,
    "library-folder-delete": deleteFolder,
    "library-item-move": moveLibraryItem,
    "library-import": importLibrary
  };

  // ---- 个人表情库 ----

  // 面板、右键保存与设置页备份都经由同一个后台串行队列或同一事务写入，多标签并发不会丢数据。
  let stickerQueue = Promise.resolve();

  async function stickerCapacity() {
    const stored = await api.storage.local.get(config.storageKey);
    return stickerStore.limits(stored[config.storageKey]);
  }

  function stickerMessage(message) {
    return { type: "sticker-notice", message: message.message, status: message.status || "", refresh: message.refresh === true, openSettings: message.openSettings || "" };
  }

  function sendToTab(tabId, message, frameId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      try {
        const options = typeof frameId === "number" ? { frameId } : undefined;
        const result = options ? api.tabs.sendMessage(tabId, message, options, onResponse) : api.tabs.sendMessage(tabId, message, onResponse);
        if (result?.then) {
          result.then((response) => finish(resolve, response)).catch((error) => finish(reject, error));
        }
      } catch (error) {
        finish(reject, error);
      }
      function onResponse(response) {
        const error = api.runtime.lastError;
        if (error) {
          finish(reject, new Error(error.message));
          return;
        }
        finish(resolve, response);
      }
    });
  }

  function notifyStickerTab(tabId, frameId, message) {
    if (typeof tabId !== "number") {
      return;
    }
    sendToTab(tabId, stickerMessage(message), frameId).catch((error) => {
      console.warn("[betterLD] 表情库提示发送失败", error);
    });
  }

  // 跨标签一致性：表情库写入后广播一次，其他标签打开的面板从同一数据源重新读取。
  let stickerBroadcastTimer = 0;

  function scheduleStickerBroadcast() {
    if (stickerBroadcastTimer) {
      return;
    }
    stickerBroadcastTimer = setTimeout(() => {
      stickerBroadcastTimer = 0;
      broadcastStickerChange().catch((error) => console.warn("[betterLD] 表情库变更广播失败", error));
    }, sticker.broadcastDebounceMs);
  }

  function queryStickerTabs() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      try {
        const result = api.tabs.query({ url: ["https://linux.do/*", "https://www.linux.do/*"] }, (tabs) => {
          const error = api.runtime.lastError;
          if (error) {
            finish(reject, new Error(error.message));
            return;
          }
          finish(resolve, tabs || []);
        });
        if (result?.then) {
          result.then((tabs) => finish(resolve, tabs || [])).catch((error) => finish(reject, error));
        }
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function broadcastStickerChange() {
    const tabs = await queryStickerTabs();
    for (const tab of tabs) {
      if (typeof tab?.id === "number") {
        sendToTab(tab.id, { type: "sticker-changed" }).catch(() => undefined);
      }
    }
  }

  // 表情库只申请精确图片域名，实际保存前仍核对浏览器授权。
  async function stickerOriginAllowed(origin) {
    return api.permissions.contains({ origins: [`${origin}/*`] });
  }

  async function rememberStickerOrigin(origin) {
    const key = sticker.pendingOriginsStorageKey;
    const stored = await api.storage.local.get(key);
    const value = stored[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error("表情库待授权域名存储格式异常，原数据保持不变");
    }
    const known = new Set((value || []).map((item) => String(item)));
    known.delete(origin);
    known.add(origin);
    const list = [...known].slice(-sticker.pendingOriginsMax);
    await api.storage.local.set({ [key]: list });
  }

  const stickerPermissionHint = "请在扩展设置页的「高级 → 表情包 → 图片域名授权」中授权该域名后重试";

  function stickerDownloadName(name, url) {
    const extension = stickerStore.extensionOf(new URL(url).pathname);
    // 地址里没有扩展名时交给浏览器按响应头命名，不猜格式。
    return extension ? stickerStore.downloadName(name, extension) : undefined;
  }

  async function handleStickerMenuSave(target) {
    const url = new URL(target.url);
    if (url.protocol !== "https:") {
      return { status: "error", message: `只接受 https 图片地址：${url.href}` };
    }
    const capacity = await stickerCapacity();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.topicExport.offlineFetchTimeoutMs);
    try {
      if (!await stickerOriginAllowed(url.origin)) {
        await rememberStickerOrigin(url.origin);
        return { status: "error", message: `缺少 ${url.origin} 的访问权限，未保存。${stickerPermissionHint}`, openSettings: "stickerOrigins" };
      }
      const response = await fetch(url.href, {
        method: "GET",
        credentials: offlineCredentialOrigins.has(url.origin) ? "include" : "omit",
        signal: controller.signal
      });
      if (!response.ok) {
        return { status: "error", message: `读取图片失败：HTTP ${response.status}` };
      }
      const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const extension = stickerStore.extensionForMime(mime) || stickerStore.extensionOf(url.pathname);
      if (!extension) {
        return { status: "error", message: `无法确认图片格式（响应类型 ${mime || "未知"}）` };
      }
      const classified = stickerStore.classify(`${target.name}.${extension}`, mime);
      if (!classified.ok) {
        return { status: "error", message: classified.reason };
      }
      const bytes = await readBoundedBody(response, capacity.itemBytes, url.href);
      const result = await stickerDb.add({ name: target.name, folderId: null, type: classified.mime, bytes, capacity });
      scheduleStickerBroadcast();
      if (result.status === "duplicate") {
        return { status: "success", message: `表情库里已有相同图片，保留原有「${result.item.name}」`, refresh: true };
      }
      return { status: "success", message: `已保存「${result.item.name}」到表情库`, refresh: true };
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: "error", message: `读取图片超时（${config.topicExport.offlineFetchTimeoutMs}ms）` };
      }
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleStickerMenuDownload(target) {
    try {
      const filename = stickerDownloadName(target.name, target.url);
      await api.downloads.download({
        url: target.url,
        saveAs: false,
        ...(filename ? { filename } : {})
      });
      return { status: "success", message: `已开始下载「${target.name}」` };
    } catch (error) {
      return { status: "error", message: `下载失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 右键只认帖子正文图片：目标校验在内容脚本里按真实 DOM 完成，头像与界面图标不进入这里。
  async function handleStickerMenuClick(info, tab, save) {
    const tabId = tab?.id;
    const frameId = info.frameId;
    if (typeof tabId !== "number") {
      return;
    }
    if (save) {
      try {
        const imageUrl = new URL(info.srcUrl);
        if (imageUrl.protocol !== "https:") {
          throw new Error("只接受 https 图片地址");
        }
        const origins = [...new Set([...sticker.defaultOrigins, imageUrl.origin])];
        // 菜单点击是扩展用户手势；必须在任何 await、页面回查和队列等待之前调用。
        const granted = await api.permissions.request({ origins: origins.map((origin) => `${origin}/*`) });
        if (!granted) {
          notifyStickerTab(tabId, frameId, { status: "error", message: "浏览器未授予图片域名访问权限，图片未保存；再次点击「保存到表情包面板」可重新申请。" });
          return;
        }
      } catch (error) {
        console.error("[betterLD] 表情库右键授权失败", error);
        notifyStickerTab(tabId, frameId, { status: "error", message: `图片域名授权失败，未保存：${error.message || String(error)}` });
        return;
      }
    }
    let target;
    try {
      target = await sendToTab(tabId, { type: "sticker-context-image", srcUrl: info.srcUrl || "" }, frameId);
    } catch (error) {
      // 插件入口只在顶层页面与主题预览 iframe 里运行：其他帧无法回查时明确说明，不静默失败。
      console.warn("[betterLD] 表情库右键目标读取失败", error);
      notifyStickerTab(tabId, 0, { status: "error", message: "无法读取这张图片所在的页面，未保存；请在主题主页面重试" });
      return;
    }
    if (!target?.ok) {
      notifyStickerTab(tabId, frameId, { status: "error", message: target?.error || "这里不是帖子正文里的图片，未保存" });
      return;
    }
    let result;
    if (save) {
      const operation = stickerQueue.then(() => handleStickerMenuSave(target));
      stickerQueue = operation.then(() => undefined, () => undefined);
      result = await operation;
    } else {
      result = await handleStickerMenuDownload(target);
    }
    notifyStickerTab(tabId, frameId, result);
  }

  function updateStickerMenu(id, title, visible) {
    return new Promise((resolve, reject) => {
      api.contextMenus.update(id, { visible }, () => {
        const error = api.runtime.lastError;
        if (!error) {
          resolve();
          return;
        }
        // 临时重载没有菜单时创建；已有菜单由 update 保留，后台重新唤醒不会清空菜单。
        if (!/cannot find|could not find|not found|does not exist/i.test(error.message)) {
          reject(new Error(error.message));
          return;
        }
        api.contextMenus.create({ id, title, contexts: ["image"], documentUrlPatterns: ["https://linux.do/*", "https://www.linux.do/*"], visible }, () => {
          const createError = api.runtime.lastError;
          if (createError) reject(new Error(createError.message));
          else resolve();
        });
      });
    });
  }

  let stickerMenuQueue = Promise.resolve();
  function setStickerMenuVisible(visible) {
    const operation = stickerMenuQueue.then(async () => {
      const ids = sticker.contextMenuIds;
      await updateStickerMenu(ids.save, "保存到表情包面板", visible);
      await updateStickerMenu(ids.download, "下载图片", visible);
    });
    stickerMenuQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  if (api.contextMenus?.create) {
    const initialize = () => setStickerMenuVisible(false).catch((error) => console.error("[betterLD] 表情库右键菜单初始化失败", error));
    api.runtime.onInstalled?.addListener(initialize);
    api.runtime.onStartup?.addListener(initialize);
    // Firefox 在菜单显示时刷新，避免页面到后台的异步消息晚于原生菜单创建。
    api.contextMenus.onShown?.addListener(async (info, tab) => {
      try {
        const target = info.mediaType === "image"
          ? await sendToTab(tab.id, { type: "sticker-context-image", srcUrl: info.srcUrl || "" }, info.frameId)
          : null;
        await setStickerMenuVisible(target?.ok === true);
        await api.contextMenus.refresh();
      } catch (error) {
        console.error("[betterLD] 表情库右键菜单刷新失败", error);
      }
    });
    api.contextMenus.onClicked.addListener((info, tab) => {
      const ids = sticker.contextMenuIds;
      if (info.menuItemId !== ids.save && info.menuItemId !== ids.download) {
        return;
      }
      handleStickerMenuClick(info, tab, info.menuItemId === ids.save).catch((error) => {
        console.error("[betterLD] 表情库右键操作失败", error);
      });
    });
  }

  async function stickerList(sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const data = await stickerDb.list();
    return { ok: true, folders: data.folders, items: data.items, totalBytes: data.totalBytes };
  }

  async function stickerThumbs(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (!Array.isArray(message.ids) || !message.ids.length) throw new Error("没有提供缩略图请求的图片");
    if (message.ids.length > sticker.thumbBatchSize) throw new Error(`一次最多读取 ${sticker.thumbBatchSize} 张缩略图`);
    return { ok: true, thumbs: await stickerDb.thumbs(message.ids.map(String)) };
  }

  async function stickerBlob(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const record = await stickerDb.record(String(message.id || ""));
    if (!record) throw new Error("这张表情已不在表情库里");
    return { ok: true, dataUrl: record.dataUrl, name: record.name, type: record.type, size: record.size };
  }

  async function stickerSave(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const capacity = await stickerCapacity();
    const result = await stickerDb.add({
      name: message.name,
      folderId: message.folderId ? String(message.folderId) : null,
      // 消息字段用 mime，避免与消息自身的 type 字段撞名
      type: String(message.mime || ""),
      bytes: stickerStore.base64ToBytes(message.base64, capacity.itemBytes),
      capacity
    });
    return { ok: true, status: result.status, item: result.item };
  }

  async function stickerFolderEnsure(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    return { ok: true, folder: await stickerDb.createFolderIfMissing(message.name) };
  }

  async function stickerRename(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    return { ok: true, item: await stickerDb.rename(String(message.id || ""), message.name) };
  }

  async function stickerMove(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (!Array.isArray(message.ids) || !message.ids.length) throw new Error("没有选择要移动的表情");
    if (message.folderId !== null && typeof message.folderId !== "string") throw new Error("目标分组无效");
    const result = await stickerDb.move(message.ids.map(String), message.folderId === null ? null : String(message.folderId));
    return { ok: true, moved: result.moved };
  }

  async function stickerDelete(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (!Array.isArray(message.ids) || !message.ids.length) throw new Error("没有选择要删除的表情");
    const result = await stickerDb.remove(message.ids.map(String));
    return { ok: true, removed: result.removed };
  }

  async function stickerFolderCreate(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    return { ok: true, folder: await stickerDb.createFolder(message.name) };
  }

  async function stickerFolderRename(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    return { ok: true, folder: await stickerDb.renameFolder(String(message.id || ""), message.name) };
  }

  async function stickerFolderDelete(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    const result = await stickerDb.deleteFolder(String(message.id || ""));
    return { ok: true, movedItems: result.movedItems };
  }

  const stickerHandlers = {
    "sticker-list": stickerList,
    "sticker-thumbs": stickerThumbs,
    "sticker-blob": stickerBlob,
    "sticker-save": stickerSave,
    "sticker-rename": stickerRename,
    "sticker-move": stickerMove,
    "sticker-delete": stickerDelete,
    "sticker-folder-create": stickerFolderCreate,
    "sticker-folder-ensure": stickerFolderEnsure,
    "sticker-folder-rename": stickerFolderRename,
    "sticker-folder-delete": stickerFolderDelete
  };

  async function handleOpenDnsSettings(sender) {
    if (!isTrustedSender(sender)) return { ok: false, error: "请求来源无效" };
    const guide = config.browserDnsGuides[/Firefox\//.test(navigator.userAgent) ? "firefox" : "chrome"];
    if (!guide.canOpen) return { ok: false, error: `${guide.label} 限制扩展打开此设置，请复制 ${guide.url} 到地址栏` };
    return createTab({ url: guide.url, active: true });
  }

  const stickerMutationTypes = new Set([
    "sticker-save",
    "sticker-rename",
    "sticker-move",
    "sticker-delete",
    "sticker-folder-create",
    "sticker-folder-rename",
    "sticker-folder-delete"
  ]);

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "sticker-context-menu") {
      if (!isTrustedSender(sender)) {
        sendResponse({ ok: false, error: "请求来源无效" });
        return true;
      }
      setStickerMenuVisible(message.visible === true)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    const stickerHandler = stickerHandlers[message?.type];
    if (stickerHandler) {
      const request = stickerQueue.then(async () => {
        const result = await stickerHandler(message, sender);
        if (stickerMutationTypes.has(message.type)) {
          scheduleStickerBroadcast();
        }
        return result;
      });
      stickerQueue = request.then(() => undefined, () => undefined);
      request.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    const libraryHandler = libraryHandlers[message?.type];
    if (libraryHandler) {
      const request = libraryQueue.then(() => libraryHandler(message, sender));
      libraryQueue = request.then(() => undefined, () => undefined);
      request.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
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
    if (message?.type === "open-settings-at") {
      handleOpenSettingsAt(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "user-marks-write") {
      const request = userMarksQueue.then(() => writeUserMark(message, sender));
      userMarksQueue = request.then(() => undefined, () => undefined);
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
