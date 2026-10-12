(() => {
  "use strict";

  // 原帖、树状回复、Boost 与插件预览共用按 document 建立的同一个观察器：
  // 媒体只按真实 DOM 处理，不依赖树状回复的 cooked 挂载事件（那只覆盖插件自己渲染的树）。
  const config = globalThis.BETTERLD_CONFIG;
  if (!config?.media) {
    throw new Error("betterLD media configuration is unavailable");
  }
  const media = config.media;
  const animatedAvatarPattern = new RegExp(media.animatedAvatarPattern, "i");
  const avatarSelector = 'img[src*="/user_avatar/"], img[src*="/letter_avatar/"]';
  const userAvatarPathPattern = /^\/user_avatar\/[^/]+\/([^/]+)\/(\d+)\//;
  const letterAvatarPathPattern = /^\/letter_avatar\/([^/]+)\/(\d+)\//;
  const proxyAvatarPathPattern = /^\/letter_avatar_proxy\/v4\/letter\/[^/]+\/[^/]+\/(\d+)\./;
  const mediaSelector = "video, iframe";
  const observedSelector = "video, iframe, img";
  const lazySelector = ".lazy-video, .lazy-iframe";
  const authorHostSelector = ".topic-avatar, .post-avatar";
  const quotedSelector = ".cooked, .discourse-boosts, blockquote, .quote";

  // 用户手势只授权它实际点到的播放器或懒加载宿主，不做全局一次性放行。
  const manualNodes = new WeakSet();
  let manualHosts = [];
  let addedNodes = new Set();
  // 被改过属性的节点（节点移除后就地清理，避免 Map 随长时间驻留增长）。
  const changes = new Map();
  // 只就地说明边界的节点：原站头像动图没有静态资源、开关启用前已加载的跨域嵌入。
  const notes = new Map();
  const identities = new Map();
  const resolved = new Map();
  const requested = new Map();
  let observer = null;
  let scanTimer = 0;
  let resolveAvatars = null;
  let resolving = false;
  let flags = { autoplay: false, avatars: false };

  function prune() {
    for (const node of [...changes.keys()]) {
      if (!node.isConnected) changes.delete(node);
    }
    for (const node of [...notes.keys()]) {
      if (!node.isConnected) notes.delete(node);
    }
    for (const node of [...identities.keys()]) {
      if (!node.isConnected) identities.delete(node);
    }
    const now = Date.now();
    manualHosts = manualHosts.filter((entry) => now - entry.at < media.manualActivationWindowMs && entry.host.isConnected);
  }

  function manuallyStarted(node) {
    if (manualNodes.has(node)) {
      return true;
    }
    const now = Date.now();
    return manualHosts.some((entry) => now - entry.at < media.manualActivationWindowMs
      && (entry.host === node.parentElement || entry.host.contains(node)));
  }

  function markManual(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) {
      return;
    }
    const lazy = event.target.closest(lazySelector);
    if (lazy?.parentElement) {
      manualHosts.push({ host: lazy.parentElement, at: Date.now() });
    }
    const node = event.target.closest(mediaSelector);
    if (node) {
      manualNodes.add(node);
    }
  }

  function newlyMounted(node, added) {
    if (added.has(node)) {
      return true;
    }
    for (const root of added) {
      if (root.contains(node)) {
        return true;
      }
    }
    return false;
  }

  // 只去掉已取证的嵌入平台上的 autoplay 参数；未知播放器保持原样，不猜参数名。
  function withoutAutoplayParam(frame) {
    const raw = frame.getAttribute("src");
    if (!raw) {
      return null;
    }
    let url;
    try {
      url = new URL(raw, location.href);
    } catch (error) {
      console.warn("[betterLD] 嵌入播放器地址无法解析", raw, error);
      return null;
    }
    if (!media.embedAutoplayHosts.includes(url.hostname) || !url.searchParams.has(media.embedAutoplayParam)) {
      return null;
    }
    if (!/^(?:1|true)$/i.test(url.searchParams.get(media.embedAutoplayParam))) {
      return null;
    }
    url.searchParams.delete(media.embedAutoplayParam);
    return url.href;
  }

  function noteBoundary(node, kind, title) {
    const note = notes.get(node);
    if (!note) {
      notes.set(node, { kind, title: node.getAttribute("title"), src: node.getAttribute("src") || "" });
    }
    if (node.title !== title) {
      node.title = title;
    }
  }

  function clearNote(node) {
    const note = notes.get(node);
    if (!note) {
      return;
    }
    notes.delete(node);
    if (node.title.startsWith(media.avatarUnmappedTitle)) {
      node.removeAttribute("title");
    }
  }

  function applyAutoplay(added) {
    document.querySelectorAll("video").forEach((video) => {
      // 懒加载占位符与用户手势创建出来的播放器属于手动启动，不拦截。
      if (video.closest(lazySelector) || manuallyStarted(video)) {
        return;
      }
      if (video.hasAttribute("autoplay")) {
        if (!changes.has(video)) {
          changes.set(video, { kind: "autoplay", autoplay: video.getAttribute("autoplay"), src: null, srcset: null, applied: null });
        }
        // 脚本可能在挂载后把 autoplay 加回来：属性变化时再去一次，手动许可过的播放不暂停。
        video.removeAttribute("autoplay");
        video.dataset.betterldAutoplayBlocked = "true";
        if (!video.paused && !video.ended) {
          video.pause();
        }
      }
    });
    document.querySelectorAll("iframe[src]").forEach((frame) => {
      if (frame.closest(lazySelector) || manuallyStarted(frame) || changes.has(frame) || notes.has(frame)) {
        return;
      }
      const next = withoutAutoplayParam(frame);
      if (!next) {
        return;
      }
      // 只在节点初次挂载时改一次地址；开关启用前就已加载的嵌入改地址会重建正在播放的播放器。
      // 尚未被 debounce 扫描消费的待处理新增节点同样算初次挂载。
      if (!newlyMounted(frame, added) && !newlyMounted(frame, addedNodes)) {
        noteBoundary(frame, "embed", media.embedBoundaryTitle);
        return;
      }
      changes.set(frame, { kind: "autoplay", autoplay: null, src: null, srcset: null, applied: null });
      frame.setAttribute("src", next);
    });
  }

  function animatedAvatar(image) {
    return animatedAvatarPattern.test(image.getAttribute("src") || "")
      || animatedAvatarPattern.test(image.getAttribute("srcset") || "");
  }

  function parseAvatarPath(src) {
    if (!src) {
      return null;
    }
    let pathname;
    try {
      pathname = new URL(src, location.href).pathname;
    } catch (error) {
      console.warn("[betterLD] 头像地址无法解析", src, error);
      return null;
    }
    const user = pathname.match(userAvatarPathPattern);
    if (user) {
      return { username: decodeURIComponent(user[1]), size: Number(user[2]) };
    }
    const letter = pathname.match(letterAvatarPathPattern);
    if (letter) {
      return { username: decodeURIComponent(letter[1]), size: Number(letter[2]) };
    }
    const proxy = pathname.match(proxyAvatarPathPattern);
    return proxy ? { username: "", size: Number(proxy[1]) } : null;
  }

  function avatarSize(image, parsed) {
    if (parsed?.size) {
      return parsed.size;
    }
    const width = Number.parseInt(image.getAttribute("width") || "", 10);
    return Number.isInteger(width) && width > 0 ? width : 0;
  }

  // 身份顺序：最近的 user-card / 引用用户名，其次头像地址里的用户名，最后才是帖子直属作者宿主。
  // 引用与 Boost 里的头像不套用所属 article 的 user-id，否则会把别人替成楼主。
  function avatarIdentity(image) {
    const named = (image.closest("[data-user-card]")?.getAttribute("data-user-card")
      || image.closest("[data-username]")?.getAttribute("data-username")
      || "").trim();
    const parsed = parseAvatarPath(image.getAttribute("src") || "");
    if (named) {
      return { username: named, size: avatarSize(image, parsed) };
    }
    if (parsed?.username) {
      return { username: parsed.username, size: avatarSize(image, parsed) };
    }
    const article = image.closest("article[data-user-id]");
    const userId = Number(article?.dataset.userId);
    if (Number.isSafeInteger(userId) && userId > 0 && image.closest(authorHostSelector) && !image.closest(quotedSelector)) {
      return { userId, size: avatarSize(image, parsed) };
    }
    return null;
  }

  function noteUnmapped(image, reason = "") {
    const title = reason ? `${media.avatarUnmappedTitle}（${reason}）` : media.avatarUnmappedTitle;
    noteBoundary(image, "avatar", title);
  }

  function writeStaticAvatar(image, url) {
    const current = image.getAttribute("src") || "";
    if (!url || url === current) {
      noteUnmapped(image);
      return;
    }
    const record = changes.get(image);
    if (record) {
      // 原站更新过头像：恢复目标跟着当前地址走，避免关闭开关时写回过期地址。
      record.src = current;
      record.srcset = image.getAttribute("srcset");
      record.applied = url;
    } else {
      changes.set(image, { kind: "avatar", autoplay: null, src: current, srcset: image.getAttribute("srcset"), applied: url });
    }
    if (image.hasAttribute("srcset")) {
      image.removeAttribute("srcset");
    }
    image.setAttribute("src", url);
    clearNote(image);
  }

  async function resolvePending() {
    if (resolving || !resolveAvatars) {
      return;
    }
    const pairs = new Map();
    const now = Date.now();
    for (const [image, identity] of [...identities]) {
      if (!image.isConnected) {
        identities.delete(image);
        continue;
      }
      if (resolved.has(identity.cacheKey)) {
        identities.delete(image);
        writeStaticAvatar(image, resolved.get(identity.cacheKey));
        continue;
      }
      const lastRequested = requested.get(identity.cacheKey);
      if (lastRequested && now - lastRequested < media.missingRetryMs) {
        continue;
      }
      requested.set(identity.cacheKey, now);
      pairs.set(identity.cacheKey, { key: identity.key, username: identity.username, userId: identity.userId, size: identity.size });
    }
    if (!pairs.size) {
      return;
    }
    resolving = true;
    let payload = null;
    let failure = "";
    try {
      payload = await resolveAvatars([...pairs.values()]);
    } catch (error) {
      failure = error.message;
      console.error("[betterLD] 静态头像数据读取失败", error);
    }
    resolving = false;
    // 等待期间开关可能已关闭：只说明边界，不回写已经取消的静态头像。
    if (!flags.avatars) {
      return;
    }
    if (failure) {
      for (const [image, identity] of [...identities]) {
        if (pairs.has(identity.cacheKey) && image.isConnected) {
          noteUnmapped(image, failure);
        }
      }
      return;
    }
    // 只缓存命中的静态地址；缺失的靠 requested 时间戳按 missingRetryMs 重试，分页后新用户仍可补上。
    for (const cacheKey of pairs.keys()) {
      const url = payload?.urls?.[cacheKey];
      if (url) {
        resolved.set(cacheKey, url);
      }
    }
    for (const [image, identity] of [...identities]) {
      if (!resolved.has(identity.cacheKey)) {
        if (image.isConnected) {
          noteUnmapped(image);
        }
        continue;
      }
      identities.delete(image);
      if (image.isConnected) {
        writeStaticAvatar(image, resolved.get(identity.cacheKey));
      }
    }
  }

  function applyAvatars() {
    if (!resolveAvatars) {
      return;
    }
    document.querySelectorAll(avatarSelector).forEach((image) => {
      const current = image.getAttribute("src") || "";
      const record = changes.get(image);
      // 本模块写入的静态地址仍生效时不重复处理；原站换了地址就重新识别。
      if (record?.applied && record.applied === current) {
        return;
      }
      if (notes.get(image)?.src === current) {
        // 已就地说明过且原站没有换地址，不重复识别。
        return;
      }
      if (identities.has(image) || !animatedAvatar(image)) {
        return;
      }
      const identity = avatarIdentity(image);
      if (!identity || !identity.size) {
        noteUnmapped(image);
        return;
      }
      const key = identity.username ? `u:${identity.username}` : `id:${identity.userId}`;
      const cacheKey = `${key}|${identity.size}`;
      if (resolved.has(cacheKey)) {
        writeStaticAvatar(image, resolved.get(cacheKey));
        return;
      }
      identities.set(image, { key, username: identity.username || "", userId: identity.userId || 0, size: identity.size, cacheKey });
    });
    resolvePending();
  }

  function scan(added = new Set()) {
    prune();
    if (flags.autoplay) {
      applyAutoplay(added);
    }
    if (flags.avatars) {
      applyAvatars();
    }
  }

  function relevant(record) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (!target) {
      return false;
    }
    if (record.type === "attributes") {
      return target.matches(observedSelector);
    }
    return [...record.addedNodes].some((node) => node instanceof Element
      && (node.matches(observedSelector) || node.querySelector(observedSelector)));
  }

  function scheduleScan() {
    if (scanTimer) {
      return;
    }
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      const added = addedNodes;
      addedNodes = new Set();
      scan(added);
    }, media.observerDebounceMs);
  }

  function startObserver() {
    if (observer) {
      return;
    }
    observer = new MutationObserver((records) => {
      let touched = false;
      records.forEach((record) => {
        if (record.type === "childList") {
          [...record.addedNodes].forEach((node) => {
            if (node instanceof Element && (node.matches(observedSelector) || node.querySelector(observedSelector))) {
              addedNodes.add(node);
              touched = true;
            }
          });
          return;
        }
        if (relevant(record)) {
          touched = true;
        }
      });
      // 只对媒体相关变化排一次扫描；插件自己写入的节点靠幂等标记收敛。
      if (touched) {
        scheduleScan();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "autoplay"]
    });
    document.addEventListener("pointerdown", markManual, true);
    document.addEventListener("keydown", markManual, true);
  }

  function restoreChanges(kind = "") {
    for (const [node, record] of [...changes]) {
      if (kind && record.kind !== kind) {
        continue;
      }
      changes.delete(node);
      if (!node.isConnected) {
        continue;
      }
      if (record.autoplay !== null) {
        node.setAttribute("autoplay", record.autoplay);
      }
      if (record.src !== null) {
        node.setAttribute("src", record.src);
      }
      if (record.srcset !== null) {
        node.setAttribute("srcset", record.srcset);
      }
      // 改过地址的嵌入不写回原 src：带着 autoplay 参数重新加载会立刻开播，只有此后新挂载的嵌入回到默认行为。
      delete node.dataset.betterldAutoplayBlocked;
    }
    for (const [node, note] of [...notes]) {
      if (kind && note.kind !== kind) {
        continue;
      }
      notes.delete(node);
      if (!node.isConnected) {
        continue;
      }
      if (note.title === null) {
        node.removeAttribute("title");
      } else {
        node.setAttribute("title", note.title);
      }
    }
  }

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.removeEventListener("pointerdown", markManual, true);
    document.removeEventListener("keydown", markManual, true);
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = 0;
    }
    restoreChanges();
    addedNodes = new Set();
    manualHosts = [];
    identities.clear();
    resolved.clear();
    requested.clear();
    resolving = false;
  }

  function sync(nextFlags) {
    const next = { autoplay: nextFlags?.autoplay === true, avatars: nextFlags?.avatars === true };
    if (flags.avatars && !next.avatars) {
      restoreChanges("avatar");
      identities.clear();
      resolved.clear();
      requested.clear();
    }
    if (flags.autoplay && !next.autoplay) {
      restoreChanges("autoplay");
    }
    flags = next;
    if (!flags.autoplay && !flags.avatars) {
      if (observer || changes.size || notes.size) {
        teardown();
      }
      return;
    }
    startObserver();
    scan();
  }

  // 原站用户卡片等新身份来源出现后重算一次，不必等下一次自然刷新。
  function invalidate() {
    resolved.clear();
    requested.clear();
    for (const [node, note] of [...notes]) {
      if (note.kind === "avatar") {
        clearNote(node);
      }
    }
    scan();
  }

  globalThis.BETTERLD_MEDIA = Object.freeze({
    setAvatarResolver(resolver) {
      resolveAvatars = typeof resolver === "function" ? resolver : null;
    },
    sync,
    invalidate,
    teardown
  });
})();
