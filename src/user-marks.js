(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  const limits = config.userMarksLimits;

  // 私人用户标记以真实用户 ID 为键，username 只是显示属性；身份缺失时不猜测、不补请求。
  function validate(mark) {
    if (!mark || typeof mark !== "object") {
      throw new Error("用户标记格式异常");
    }
    if (!Number.isSafeInteger(mark.userId) || mark.userId < 1) {
      throw new Error("用户标记缺少有效用户 ID");
    }
    if (typeof mark.username !== "string" || !mark.username.trim()) {
      throw new Error("用户标记缺少用户名");
    }
    if (typeof mark.tag !== "string" || typeof mark.note !== "string") {
      throw new Error("用户标记的标签与备注必须是文本");
    }
    const tag = mark.tag.trim();
    const note = mark.note.trim();
    if (tag.length > limits.tagMaxLength) {
      throw new Error(`标签最长 ${limits.tagMaxLength} 个字符`);
    }
    if (note.length > limits.noteMaxLength) {
      throw new Error(`备注最长 ${limits.noteMaxLength} 个字符`);
    }
    if (!tag && !note) {
      throw new Error("标签与备注不能同时为空");
    }
    return {
      userId: mark.userId,
      username: mark.username.trim(),
      tag,
      note,
      updatedAt: Number.isFinite(mark.updatedAt) ? mark.updatedAt : Date.now()
    };
  }

  // 存储校验只在这一处；读写双方都用同一份规则解释 storage.local。
  function normalize(value) {
    if (value === undefined) {
      return { version: 1, marks: {} };
    }
    if (!value || typeof value !== "object" || !value.marks || typeof value.marks !== "object") {
      throw new Error("用户标记存储格式异常，原数据保持不变");
    }
    const marks = {};
    for (const [key, mark] of Object.entries(value.marks)) {
      const validated = validate(mark);
      if (key !== String(validated.userId)) {
        throw new Error("用户标记存储键与用户 ID 不一致，原数据保持不变");
      }
      marks[key] = validated;
    }
    return { version: 1, marks };
  }

  function upsert(store, mark) {
    const validated = validate(mark);
    const key = String(validated.userId);
    if (!store.marks[key] && Object.keys(store.marks).length >= limits.maxEntries) {
      throw new Error(`用户标记最多保存 ${limits.maxEntries} 条`);
    }
    store.marks[key] = validated;
    return store;
  }

  function remove(store, userId) {
    delete store.marks[String(userId)];
    return store;
  }

  function find(store, userId) {
    return Number.isSafeInteger(userId) ? store.marks[String(userId)] || null : null;
  }

  function list(store) {
    return Object.values(store.marks).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  globalThis.BETTERLD_USER_MARKS = Object.freeze({
    storageKey: config.userMarksStorageKey,
    tagMaxLength: limits.tagMaxLength,
    noteMaxLength: limits.noteMaxLength,
    maxEntries: limits.maxEntries,
    validate,
    normalize,
    upsert,
    remove,
    find,
    list
  });
})();
