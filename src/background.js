(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (!api?.runtime?.onMessage || !api.tabs?.create) {
    return;
  }

  function isLinuxDoPage(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://linux.do" || url.origin === "https://www.linux.do";
    } catch {
      return false;
    }
  }

  function isTopicUrl(value) {
    try {
      const url = new URL(value);
      return isLinuxDoPage(value) && /^\/t\/[^/]+\/\d+(?:\/|$)/.test(url.pathname);
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

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "open-topic") {
      return undefined;
    }
    const senderUrl = sender?.tab?.url;
    const targetUrl = message.url;
    if (!isLinuxDoPage(senderUrl) || !isTopicUrl(targetUrl)) {
      sendResponse({ ok: false, error: "请求来源或主题目标无效" });
      return undefined;
    }
    createTab({ url: targetUrl, active: message.active === true })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "标签页创建失败" }));
    return true;
  });
})();
