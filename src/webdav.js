(() => {
  "use strict";

  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
  const maxBodyLength = 1024 * 1024;

  function webdavUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol === "https:") {
        return url;
      }
      return url.protocol === "http:" && loopbackHosts.includes(url.hostname) ? url : null;
    } catch {
      return null;
    }
  }

  function basicAuthorization(username, password) {
    if (!username && !password) {
      return "";
    }
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return `Basic ${btoa(binary)}`;
  }

  function requestHeaders(message) {
    const headers = { Accept: "application/json, text/plain, */*" };
    const authorization = basicAuthorization(message.username, message.password);
    if (authorization) {
      headers.Authorization = authorization;
    }
    if (message.method === "PUT") {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    return headers;
  }

  async function webdavRequest(message, fetchImpl) {
    const url = webdavUrl(message.url);
    if (!url) {
      return { ok: false, error: "WebDAV 地址无效：只接受 https:// 地址，http:// 仅允许本机地址" };
    }
    if (message.method !== "PUT" && message.method !== "GET") {
      return { ok: false, error: "WebDAV 只支持读取与写入" };
    }
    const body = typeof message.body === "string" ? message.body : "";
    if (message.method === "PUT" && body.length > maxBodyLength) {
      return { ok: false, error: "上传内容超过 1MB 限制" };
    }
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: message.method,
        headers: requestHeaders(message),
        body: message.method === "PUT" ? body : undefined,
        credentials: "omit",
        cache: "no-store"
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "WebDAV 请求失败" };
    }
    if (!response.ok) {
      return { ok: false, error: `WebDAV 请求失败（HTTP ${response.status}）` };
    }
    return { ok: true, text: message.method === "PUT" ? "" : await response.text() };
  }

  function createWebdavApi(fetchImpl) {
    return {
      request: (message) => webdavRequest(message, fetchImpl),
      originPattern: (value) => {
        const url = webdavUrl(value);
        return url ? `${url.origin}/*` : "";
      }
    };
  }

  globalThis.BETTERLD_WEBDAV = { createWebdavApi, webdavUrl, basicAuthorization };
})();
