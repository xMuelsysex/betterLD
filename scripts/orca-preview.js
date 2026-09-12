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

function startPreviewServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store, max-age=0");

      if (!["GET", "HEAD"].includes(request.method)) {
        sendResponse(response, 405, "Method Not Allowed");
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(
          new URL(request.url || "/", "http://127.0.0.1").pathname
        );
      } catch (error) {
        sendResponse(response, 400, "Invalid URL");
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
  const [configCode, styleCode, contentCode] = await Promise.all([
    sourceText("betterld.config.js"),
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

  const data = {
    [settingsKey]: persisted[settingsKey] || config.settingsDefaults,
    [localKey]: persisted[localKey] || null
  };
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
    openOptionsPage() {
      globalThis.__betterldOptionsOpened = true;
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
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run preview:orca [https://linux.do/path]");
    return;
  }

  await runOrca(["status"]);
  const url = targetUrl(process.argv[2] || DEFAULT_URL);
  await startPreviewServer();

  const tabPayload = await runOrca(["tab", "create", "--url", url]);
  pageId = tabPayload.result?.browserPageId;
  if (!pageId) {
    throw new Error("Orca did not return a browser page id");
  }

  console.log(`[betterLD preview] opened ${url}`);
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
