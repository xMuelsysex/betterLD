(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (typeof importScripts === "function") {
    if (!globalThis.BETTERLD_CONFIG) importScripts(api.runtime.getURL("betterld.config.js"));
    if (!globalThis.BETTERLD_WEBDAV) importScripts("webdav.js");
    // 只借 searchUrl 构造引擎请求地址；后台没有 DOMParser，HTML 解析留在内容脚本
    if (!globalThis.BETTERLD_EXTERNAL_SEARCH) importScripts("external-search.js");
  }

  const config = globalThis.BETTERLD_CONFIG;
  const externalSearch = globalThis.BETTERLD_EXTERNAL_SEARCH;
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
      return { ok: false, error: `缺少 ${label} 的访问权限，请在设置窗口重新保存外部搜索引擎` };
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

  let libraryQueue = Promise.resolve();

  async function toggleLibrary(message, sender) {
    if (!isTrustedSender(sender)) throw new Error("请求来源无效");
    if (typeof message.remove !== "boolean") throw new Error("收藏增删意图必须为布尔值");
    if (!["later", "favorites"].includes(message.group)) throw new Error("未知收藏分类");
    const topic = message.topic;
    if (!topic || !/^\d+$/.test(String(topic.id)) || typeof topic.title !== "string" || !topic.title.trim()) throw new Error("主题信息不完整");
    if (!isLinuxDoPage(topic.href)) throw new Error("收藏链接必须是 LinuxDo 主题");
    const url = new URL(topic.href);
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.exec(url.pathname);
    if (match?.[1] !== String(topic.id)) throw new Error("收藏链接与主题编号不一致");
    const stored = await api.storage.local.get(config.libraryStorageKey);
    const library = stored[config.libraryStorageKey] ?? { later: [], favorites: [] };
    if (!Array.isArray(library.later) || !Array.isArray(library.favorites)) throw new Error("收藏存储格式异常，原数据保持不变");
    const items = library[message.group];
    const existing = items.findIndex((item) => String(item.id) === String(topic.id));
    if (message.remove) {
      if (existing >= 0) items.splice(existing, 1);
    } else if (existing < 0) {
      items.unshift({ id: String(topic.id), title: topic.title.trim().slice(0, config.libraryTitleMaxLength), href: `${url.origin}/t/topic/${topic.id}`, savedAt: Date.now() });
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
