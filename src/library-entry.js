(() => {
  "use strict";

  function key(item) {
    return `${item.id}:${item.postNumber ?? "topic"}`;
  }

  function validate(item) {
    if (!item || !/^[1-9]\d*$/.test(String(item.id)) || typeof item.title !== "string" || !item.title.trim()) {
      throw new Error("收藏主题信息不完整");
    }
    if (item.postNumber !== undefined && (!Number.isSafeInteger(item.postNumber) || item.postNumber < 1)) {
      throw new Error("收藏楼层编号无效");
    }
    const url = new URL(item.href);
    const match = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?([1-9]\d*)(?:\/([1-9]\d*|last))?\/?$/.exec(url.pathname);
    if (!["https://linux.do", "https://www.linux.do"].includes(url.origin) || match?.[1] !== String(item.id)
      || (item.postNumber !== undefined && match[2] !== String(item.postNumber))) {
      throw new Error("收藏链接与主题或楼层编号不一致");
    }
    return item;
  }

  function href(item) {
    validate(item);
    return `${new URL(item.href).origin}/t/topic/${item.id}${item.postNumber === undefined ? "" : `/${item.postNumber}`}`;
  }

  globalThis.BETTERLD_LIBRARY_ENTRY = Object.freeze({ key, validate, href });
})();
