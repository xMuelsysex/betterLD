(() => {
  "use strict";

  // 外部引擎只做 site: 限定检索；解析结果只保留 LinuxDo 主题链接。

  function externalSearchConfig() {
    const external = globalThis.BETTERLD_CONFIG?.externalSearch;
    if (!external) {
      throw new Error("未配置外部搜索：betterld.config.js 缺少 externalSearch");
    }
    return external;
  }

  function engineEntry(engine) {
    const entry = externalSearchConfig().engines?.[engine];
    if (!entry?.url || !entry?.queryParam) {
      throw new Error(`未配置外部搜索引擎：${String(engine)}`);
    }
    return entry;
  }

  // 用户查询里原有的 site: 限定词先移除，再统一追加站内限定，避免出现多个互相冲突的 site: 项
  function stripSiteTerms(query) {
    return String(query || "")
      .split(/\s+/)
      .filter((term) => term && !/^site:/i.test(term))
      .join(" ");
  }

  function searchUrl(engine, query) {
    const entry = engineEntry(engine);
    const url = new URL(entry.url);
    const terms = [stripSiteTerms(query), `site:linux.do`].filter(Boolean);
    url.searchParams.set(entry.queryParam, terms.join(" "));
    return url.href;
  }

  function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  // Bing 结果链接走 bing.com/ck/a 跳转，目标地址在 u=a1<base64url> 中
  function bingTarget(rawHref, base) {
    const url = new URL(rawHref, base);
    if (!/(?:^|\.)bing\.com$/.test(url.hostname) || !url.pathname.startsWith("/ck/a")) {
      return url.href;
    }
    const encoded = url.searchParams.get("u") || "";
    if (!encoded.startsWith("a1")) {
      return "";
    }
    try {
      return decodeBase64Url(encoded.slice(2));
    } catch {
      return "";
    }
  }

  // DuckDuckGo 结果链接走 duckduckgo.com/l/?uddg=<encoded> 跳转
  function duckTarget(rawHref, base) {
    const url = new URL(rawHref, base);
    if (!/(?:^|\.)duckduckgo\.com$/.test(url.hostname) || !url.pathname.startsWith("/l/")) {
      return url.href;
    }
    return url.searchParams.get("uddg") || "";
  }

  const parsers = {
    bing: {
      resultsContainer: "#b_results",
      captcha: "",
      items: "li.b_algo",
      link: "h2 a",
      excerpt: "p",
      target: bingTarget
    },
    duckduckgo: {
      resultsContainer: "#links",
      // 反爬页实测标记：div.anomaly-modal__modal[data-testid="anomaly-modal"]（html.duckduckgo.com 返回 202）
      captcha: "[data-testid='anomaly-modal']",
      items: ".result:not(.result--ad)",
      link: "a.result__a",
      excerpt: ".result__snippet",
      target: duckTarget
    }
  };

  // 只接受 https 的 linux.do / www.linux.do 主题链接：/t/{slug}/{id}、/t/{id}，可带帖子序号后缀
  function topicId(target) {
    let url;
    try {
      url = new URL(target);
    } catch {
      return "";
    }
    if (!["https://linux.do", "https://www.linux.do"].includes(url.origin)) return "";
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/(?:[1-9]\d*|last))?\/?$/.exec(url.pathname);
    return match?.[1] || "";
  }

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // 返回 { results, filteredCount }；filteredCount 统计被剔除的候选条数（站外链接、非主题路径、重复主题）
  function parseResults(engine, html) {
    const entry = engineEntry(engine);
    const parser = parsers[engine];
    if (!parser) {
      throw new Error(`不支持的外部搜索引擎：${String(engine)}`);
    }
    const limit = externalSearchConfig().maxResults;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("未配置外部搜索：betterld.config.js 缺少有效的 externalSearch.maxResults");
    }
    const page = new DOMParser().parseFromString(String(html || ""), "text/html");
    if (parser.captcha && page.querySelector(parser.captcha)) {
      throw new Error(`${entry.label || engine} 要求人机验证，请稍后重试或改用其他搜索引擎`);
    }
    const container = page.querySelector(parser.resultsContainer);
    if (!container) {
      throw new Error(`${entry.label || engine} 返回内容无法识别（可能被拦截，或页面结构已变更）`);
    }
    const results = [];
    const seen = new Set();
    let filteredCount = 0;
    container.querySelectorAll(parser.items).forEach((item) => {
      const link = item.querySelector(parser.link);
      const target = link ? parser.target(link.getAttribute("href") || "", entry.url) : "";
      const id = topicId(target);
      if (!id || seen.has(id)) {
        filteredCount += 1;
        return;
      }
      seen.add(id);
      results.push({
        id,
        title: textOf(link),
        href: `https://linux.do/t/topic/${id}`,
        excerpt: textOf(item.querySelector(parser.excerpt))
      });
    });
    return { results: results.slice(0, limit), filteredCount };
  }

  globalThis.BETTERLD_EXTERNAL_SEARCH = Object.freeze({ searchUrl, parseResults });
})();
