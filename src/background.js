(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (!api?.runtime?.getURL) {
    return;
  }

  importScripts(api.runtime.getURL("betterld.config.js"));
  importScripts("webdav.js");

  const config = globalThis.BETTERLD_CONFIG;
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
      const onCreated = (tab) => finish(resolve, { ok: true, tabId: tab?.id ?? null });
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

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
