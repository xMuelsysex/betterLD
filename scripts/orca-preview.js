#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_URL = "https://linux.do/";
const POLL_MS = 1000;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const ORCA_COMMAND = resolveOrcaCommand();

let server;
let previewPort;
let pageId;
let monitorTimer;
let monitorBusy = false;
let stopping = false;
let lastError = "";

function resolveOrcaCommand() {
  const configured = process.env.ORCA_CLI_COMMAND?.trim();
  if (configured) {
    return configured.split(/\s+/);
  }
  if (process.env.ORCA_DEV_REPO_ROOT?.trim()) {
    return ["orca-dev"];
  }
  return process.platform === "linux" ? ["orca-ide"] : ["orca"];
}

function formatProcessError(error) {
  return [
    error.message,
    error.stderr?.trim(),
    error.stdout?.trim()
  ].filter(Boolean).join("\n");
}

async function runOrca(args) {
  let output;
  try {
    output = await execFileAsync(
      ORCA_COMMAND[0],
      [...ORCA_COMMAND.slice(1), ...args, "--json"],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (error) {
    throw new Error(formatProcessError(error));
  }

  let payload;
  try {
    payload = JSON.parse(output.stdout);
  } catch (error) {
    throw new Error(`Orca returned invalid JSON: ${error.message}\n${output.stdout}`);
  }

  if (payload.ok === false) {
    const message = payload.error?.message || payload.error?.code || "Orca command failed";
    throw new Error(message);
  }

  return payload;
}

function unwrapResult(payload) {
  let value = payload?.result?.result ?? payload?.result;
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function targetUrl(input) {
  const url = new URL(input.startsWith("/") ? input : input || DEFAULT_URL, DEFAULT_URL);
  if (url.protocol !== "https:" || !["linux.do", "www.linux.do"].includes(url.hostname)) {
    throw new Error("Target URL must be an HTTPS linux.do URL");
  }
  url.searchParams.set("betterld_preview", `orca-${Date.now()}`);
  return url.href;
}

function sendResponse(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0"
  });
  response.end(body);
}

const PREVIEW_STORAGE_ROUTE = "/__betterld/storage";
const PREVIEW_OPTIONS_ROUTE = "/__betterld/options";
const PREVIEW_OPEN_OPTIONS_ROUTE = "/__betterld/open-options";
const MAX_PREVIEW_BODY_BYTES = 8 * 1024 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PREVIEW_BODY_BYTES) {
      throw new Error("Preview request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Preview request body is invalid JSON");
  }
}

function parseStorageKeys(requestUrl) {
  const encoded = requestUrl.searchParams.get("keys");
  if (!encoded) {
    throw new Error("Preview storage keys are required");
  }
  let keys;
  try {
    keys = JSON.parse(encoded);
  } catch (error) {
    throw new Error("Preview storage keys are invalid JSON");
  }
  if (typeof keys === "string") {
    keys = [keys];
  }
  if (!Array.isArray(keys) || keys.length > 32 || keys.some((key) => typeof key !== "string" || key.length > 256)) {
    throw new Error("Preview storage keys are invalid");
  }
  return keys;
}

function validateStorageValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Preview storage values are invalid");
  }
  if (Object.keys(value).some((key) => key.length > 256)) {
    throw new Error("Preview storage key is too long");
  }
}

function buildOptionsBridge() {
  return `<script>
(() => {
  const endpoint = "/__betterld/storage";
  const data = {};
  const listeners = [];

  async function request(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || "Preview storage request failed");
    }
    return payload;
  }

  function reportError(callback, error) {
    queueMicrotask(() => {
      globalThis.chrome.runtime.lastError = { message: error.message };
      try {
        callback?.({});
      } finally {
        globalThis.chrome.runtime.lastError = null;
      }
    });
  }

  function notify(changes) {
    queueMicrotask(() => {
      listeners.forEach((listener) => listener(changes, "local"));
    });
  }

  const local = {
    get(keys, callback) {
      const query = encodeURIComponent(JSON.stringify(keys));
      return request(endpoint + "?keys=" + query).then((value) => {
        Object.assign(data, value);
        callback?.(value);
        return value;
      }).catch((error) => {
        reportError(callback, error);
        throw error;
      });
    },
    set(value, callback) {
      const previous = Object.fromEntries(Object.keys(value || {}).map((key) => [key, data[key]]));
      return request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "set", value })
      }).then(() => {
        const changes = {};
        Object.entries(value || {}).forEach(([key, newValue]) => {
          changes[key] = { oldValue: previous[key], newValue };
          data[key] = newValue;
        });
        notify(changes);
        callback?.();
      }).catch((error) => {
        reportError(callback, error);
        throw error;
      });
    },
    remove(key, callback) {
      const keys = Array.isArray(key) ? key : [key];
      const previous = Object.fromEntries(keys.map((name) => [name, data[name]]));
      return request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "remove", key })
      }).then(() => {
        const changes = {};
        keys.forEach((name) => {
          changes[name] = { oldValue: previous[name] };
          delete data[name];
        });
        notify(changes);
        callback?.();
      }).catch((error) => {
        reportError(callback, error);
        throw error;
      });
    }
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest() {
        return { version: "0.1.0" };
      },
      getURL(file) {
        return location.origin + "/" + file;
      }
    },
    storage: {
      local,
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
})();
</script>`;
}

async function renderOptionsPage() {
  const filePath = path.join(ROOT, "src/options.html");
  const html = await fs.promises.readFile(filePath, "utf8");
  const baseHref = `http://127.0.0.1:${previewPort}/src/`;
  return html
    .replace("<head>", `<head>\n    <base href="${baseHref}">`)
    .replace(
      '    <script src="options.js"></script>',
      `${buildOptionsBridge()}\n    <script src="options.js"></script>`
    );
}

async function handlePreviewStorage(request, response, requestUrl) {
  const reply = (status, value) => sendResponse(
    response,
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8"
  );
  try {
    if (request.method === "GET") {
      const keys = parseStorageKeys(requestUrl);
      const result = await evalPage(`(async () => globalThis.chrome.storage.local.get(${JSON.stringify(keys)}))()`);
      reply(200, result || {});
      return;
    }

    const body = await readJsonBody(request);
    if (body?.operation === "set") {
      validateStorageValues(body.value);
      await evalPage(`globalThis.chrome.storage.local.set(${JSON.stringify(body.value)})`);
    } else if (body?.operation === "remove") {
      const keys = Array.isArray(body.key) ? body.key : [body.key];
      if (!keys.length || keys.length > 32 || keys.some((key) => typeof key !== "string" || key.length > 256)) {
        throw new Error("Preview storage keys are invalid");
      }
      await evalPage(`globalThis.chrome.storage.local.remove(${JSON.stringify(body.key)})`);
    } else {
      throw new Error("Preview storage operation is invalid");
    }
    reply(200, { ok: true });
  } catch (error) {
    reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleOpenOptions(response) {
  try {
    const url = `http://127.0.0.1:${previewPort}${PREVIEW_OPTIONS_ROUTE}?preview=${Date.now()}`;
    const payload = await runOrca(["tab", "create", "--url", url]);
    const browserPageId = payload.result?.browserPageId;
    if (!browserPageId) {
      throw new Error("Orca did not return an options page id");
    }
    sendResponse(
      response,
      200,
      JSON.stringify({ browserPageId, url }),
      "application/json; charset=utf-8"
    );
  } catch (error) {
    sendResponse(
      response,
      500,
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      "application/json; charset=utf-8"
    );
  }
}

async function handleOptionsPage(response) {
  try {
    sendResponse(response, 200, await renderOptionsPage(), "text/html; charset=utf-8");
  } catch (error) {
    sendResponse(response, 500, error instanceof Error ? error.message : String(error));
  }
}

function startPreviewServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store, max-age=0");

      const method = request.method || "GET";
      if (!["GET", "HEAD", "POST"].includes(method)) {
        sendResponse(response, 405, "Method Not Allowed");
        return;
      }

      let requestUrl;
      let pathname;
      try {
        requestUrl = new URL(request.url || "/", "http://127.0.0.1");
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch (error) {
        sendResponse(response, 400, "Invalid URL");
        return;
      }

      if (pathname === PREVIEW_OPEN_OPTIONS_ROUTE && method === "GET") {
        void handleOpenOptions(response);
        return;
      }
      if (pathname === PREVIEW_STORAGE_ROUTE && ["GET", "POST"].includes(method)) {
        void handlePreviewStorage(request, response, requestUrl);
        return;
      }
      if (pathname === PREVIEW_OPTIONS_ROUTE && method === "GET") {
        void handleOptionsPage(response);
        return;
      }
      if (!["GET", "HEAD"].includes(method)) {
        sendResponse(response, 405, "Method Not Allowed");
        return;
      }

      const filePath = path.resolve(ROOT, `.${pathname}`);
      const rootPrefix = `${ROOT}${path.sep}`;
      if (filePath !== ROOT && !filePath.startsWith(rootPrefix)) {
        sendResponse(response, 403, "Forbidden");
        return;
      }

      fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
          sendResponse(response, 404, "Not Found");
          return;
        }

        const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
        response.setHeader("Content-Type", contentType);
        response.setHeader("Cache-Control", "no-store, max-age=0");
        if (request.method === "HEAD") {
          response.writeHead(200);
          response.end();
          return;
        }

        fs.readFile(filePath, (readError, content) => {
          if (readError) {
            sendResponse(response, 500, readError.message);
            return;
          }
          response.writeHead(200);
          response.end(content);
        });
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      previewPort = server.address().port;
      resolve(previewPort);
    });
  });
}

function buildInjection(port) {
  return `(async () => {
  const base = "http://127.0.0.1:${port}";
  const cacheBust = "?preview=" + Date.now();
  const sourceText = async (file) => {
    const response = await fetch(base + "/" + file + cacheBust);
    if (!response.ok) {
      throw new Error("preview source request failed: " + response.status + " " + file);
    }
    return response.text();
  };
  const [configCode, settingsCode, markdownCode, styleCode, contentCode] = await Promise.all([
    sourceText("betterld.config.js"),
    sourceText("src/settings.js"),
    sourceText("src/markdown.js"),
    sourceText("src/content.css"),
    sourceText("src/content.js")
  ]);

  const nonceElement = document.querySelector("script[nonce]");
  const nonce = nonceElement?.nonce || nonceElement?.getAttribute("nonce");
  if (!nonce || !document.head) {
    throw new Error("page CSP nonce or head is unavailable");
  }

  const runScript = (code) => {
    const script = document.createElement("script");
    script.nonce = nonce;
    script.setAttribute("nonce", nonce);
    script.textContent = code;
    document.head.append(script);
  };

  runScript(configCode);
  runScript(settingsCode);
  runScript(markdownCode);
  const config = globalThis.BETTERLD_CONFIG;
  if (!config?.storageKey || !config.wallpaperLocalStorageKey || !config.settingsDefaults) {
    throw new Error("betterLD config did not initialize");
  }
  const settingsKey = config.storageKey;
  const localKey = config.wallpaperLocalStorageKey;
  const persistedKey = "__betterld_preview_storage__";
  let pageStorage;
  try {
    pageStorage = globalThis.localStorage;
  } catch (error) {
    throw new Error("preview localStorage is unavailable");
  }
  if (!pageStorage) {
    throw new Error("preview localStorage is unavailable");
  }

  let persisted = {};
  try {
    persisted = JSON.parse(pageStorage.getItem(persistedKey) || "{}");
  } catch (error) {
    throw new Error("preview storage could not be read");
  }

  // 预览要忠实映射 storage.local：任意键都要能跨刷新保留，否则新增的本地键会被静默丢掉
  const data = { ...persisted, [localKey]: persisted[localKey] || null };
  if (!data[settingsKey]) {
    data[settingsKey] = config.settingsDefaults;
  }
  const listeners = [];
  const persist = () => {
    try {
      pageStorage.setItem(persistedKey, JSON.stringify(data));
    } catch (error) {
      throw new Error("preview storage could not be written");
    }
  };
  const api = globalThis.chrome || {};
  api.runtime = {
    lastError: null,
    getManifest() {
      return { version: "0.1.0" };
    },
    getURL(file) {
      if (file === "src/options.html") {
        return base + "/__betterld/options?embedded=1&preview=" + Date.now();
      }
      return base + "/" + file + cacheBust;
    },
    async openOptionsPage() {
      globalThis.__betterldOptionsOpened = true;
      const response = await fetch(base + "/__betterld/open-options" + cacheBust);
      if (!response.ok) {
        throw new Error("betterLD options page request failed: " + response.status);
      }
      const result = await response.json();
      if (!result?.browserPageId) {
        throw new Error(result?.error || "betterLD options page was not created");
      }
      globalThis.__betterldOptionsPage = result;
      return result;
    }
  };
  api.storage = {
    local: {
      get(keys, callback) {
        const requested = Array.isArray(keys)
          ? keys
          : typeof keys === "string"
            ? [keys]
            : keys && typeof keys === "object"
              ? Object.keys(keys)
              : Object.keys(data);
        const result = Object.fromEntries(
          requested.map((key) => [key, data[key]])
        );
        queueMicrotask(() => callback?.(result));
        return Promise.resolve(result);
      },
      set(value, callback) {
        const changes = {};
        Object.entries(value || {}).forEach(([key, newValue]) => {
          changes[key] = { oldValue: data[key], newValue };
          data[key] = newValue;
        });
        persist();
        queueMicrotask(() => {
          listeners.forEach((listener) => listener(changes, "local"));
          callback?.();
        });
      },
      remove(key, callback) {
        const keys = Array.isArray(key) ? key : [key];
        const changes = {};
        keys.forEach((name) => {
          changes[name] = { oldValue: data[name] };
          delete data[name];
        });
        persist();
        queueMicrotask(() => {
          listeners.forEach((listener) => listener(changes, "local"));
          callback?.();
        });
      }
    },
    onChanged: {
      addListener(listener) {
        listeners.push(listener);
      }
    }
  };
  globalThis.chrome = api;

  document.querySelectorAll("style[data-betterld-preview]").forEach((node) => node.remove());

  const style = document.createElement("style");
  style.nonce = nonce;
  style.setAttribute("nonce", nonce);
  style.dataset.betterldPreview = "true";
  style.textContent = styleCode;
  document.head.append(style);

  runScript(contentCode);
  if (!globalThis.__betterldContentScriptActive) {
    throw new Error("betterLD content script did not initialize");
  }
  globalThis.__betterldPreviewInjected = { at: Date.now() };

  return {
    cards: document.querySelectorAll(".betterld-topic-card").length,
    grids: document.querySelectorAll(".betterld-topic-grid").length,
    home: document.body?.classList.contains("betterld-home") || false,
    tagsPage: document.body?.classList.contains("betterld-tags-page") || false,
    tableHidden: document.querySelector("table.topic-list")?.hidden ?? null,
    settingsButton: document.querySelectorAll("[data-betterld-settings-trigger]").length,
    mode: document.documentElement.dataset.betterldMode || null,
    material: document.documentElement.dataset.betterldMaterial || null,
    wallpaperState: document.documentElement.getAttribute("data-betterld-wallpaper-state"),
    wallpaperApplied: Boolean(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--betterld-wallpaper-image")
        .trim()
    )
  };
})()`;
}

async function evalPage(expression) {
  const payload = await runOrca([
    "eval",
    "--page",
    pageId,
    "--expression",
    expression
  ]);
  return unwrapResult(payload);
}

async function targetExists() {
  const payload = await runOrca(["tab", "list"]);
  return (payload.result?.tabs || []).some((tab) => tab.browserPageId === pageId);
}

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastError) {
    return;
  }
  lastError = message;
  console.error(`[betterLD preview] ${message}`);
}

function clearError() {
  if (lastError) {
    console.log("[betterLD preview] page recovered; injection is active");
    lastError = "";
  }
}

async function inject() {
  const result = await evalPage(buildInjection(previewPort));
  console.log(`[betterLD preview] injected ${JSON.stringify(result)}`);
  clearError();
}

async function isInjected() {
  return (await evalPage("Boolean(globalThis.__betterldPreviewInjected)")) === true;
}

async function monitorPage() {
  if (stopping || monitorBusy) {
    return;
  }
  monitorBusy = true;
  try {
    if (!(await isInjected())) {
      await inject();
    }
  } catch (error) {
    const exists = await targetExists().catch(() => true);
    if (!exists) {
      console.error("[betterLD preview] target Orca tab was closed");
      await shutdown(1);
      return;
    }
    reportError(error);
  } finally {
    monitorBusy = false;
  }
}

async function shutdown(exitCode) {
  if (stopping) {
    return;
  }
  stopping = true;
  if (monitorTimer) {
    clearInterval(monitorTimer);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  process.exitCode = exitCode;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log("Usage: npm run preview:orca [https://linux.do/path] [--page <tab-id>]");
    return;
  }

  await runOrca(["status"]);
  const pageFlag = argv.indexOf("--page");
  const reusePageId = pageFlag === -1 ? "" : argv[pageFlag + 1];
  const urlArg = argv.find((arg, index) => index !== pageFlag + 1 && !arg.startsWith("--"));
  await startPreviewServer();

  if (reusePageId) {
    // 已有 linux.do 标签页通常已经通过 Cloudflare 质询，复用它避免新建标签页被挑战。
    pageId = reusePageId;
    console.log(`[betterLD preview] reusing ${pageId}`);
  } else {
    const url = targetUrl(urlArg || DEFAULT_URL);
    const tabPayload = await runOrca(["tab", "create", "--url", url]);
    pageId = tabPayload.result?.browserPageId;
    if (!pageId) {
      throw new Error("Orca did not return a browser page id");
    }
    console.log(`[betterLD preview] opened ${url}`);
  }

  console.log(`[betterLD preview] page ${pageId}; refresh recovery is active`);
  monitorTimer = setInterval(() => {
    void monitorPage();
  }, POLL_MS);
  void monitorPage();
  console.log("[betterLD preview] running; waiting for page readiness and refresh recovery");
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

main().catch(async (error) => {
  console.error(`[betterLD preview] ${error.message}`);
  await shutdown(1);
});
