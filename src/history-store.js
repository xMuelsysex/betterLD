(() => {
  "use strict";

  // 浏览历史的唯一格式与迁移规则：已看标记与访问历史共用 config.visitedTopicStorageKey，
  // 旧版 string[] 只保留主题 ID（已看），标题与时间保持未知，不猜值；格式异常一律抛错，不写回原存储。
  const config = globalThis.BETTERLD_CONFIG;
  if (!config?.visitedTopicStorageKey || !Number.isSafeInteger(config.visitedTopicMaxEntries) || !Number.isSafeInteger(config.visitedHistoryTitleMaxLength)) {
    throw new Error("betterLD 历史模块缺少配置");
  }

  function fail(message) {
    throw new Error(message);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function topicId(value) {
    const id = String(value);
    if (!/^[1-9]\d*$/.test(id)) {
      fail("浏览历史的主题 ID 无效，原数据保持不变");
    }
    return id;
  }

  // 空标题不写入：宁可显示「主题 #id」，也不留下空字符串冒充已知标题。
  function titleField(value) {
    if (typeof value !== "string") {
      fail("浏览历史的标题格式异常，原数据保持不变");
    }
    return value.trim().slice(0, config.visitedHistoryTitleMaxLength) || undefined;
  }

  function authorField(value) {
    if (typeof value !== "string") {
      fail("浏览历史的发帖人格式异常，原数据保持不变");
    }
    return value.trim().slice(0, config.visitedHistoryTitleMaxLength) || undefined;
  }

  function authorAvatarField(value) {
    if (typeof value !== "string") fail("浏览历史的头像格式异常，原数据保持不变");
    if (!value.trim()) return undefined;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      fail("浏览历史的头像地址无效，原数据保持不变");
    }
    return url.href;
  }

  function categoryField(value) {
    if (value === null) return null;
    if (!isPlainObject(value) || typeof value.name !== "string" || !value.name.trim()) {
      fail("浏览历史的分类格式异常，原数据保持不变");
    }
    const id = topicId(value.id);
    return { id, name: [...value.name.trim()].slice(0, config.visitedHistoryTitleMaxLength).join("") };
  }

  function tagsField(value) {
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !tag.trim())) {
      fail("浏览历史的标签格式异常，原数据保持不变");
    }
    return [...new Set(value.map((tag) => [...tag.trim()].slice(0, config.visitedHistoryTitleMaxLength).join("")))];
  }

  function metadataFields(record) {
    const author = record.author === undefined ? undefined : authorField(record.author);
    const authorAvatar = record.authorAvatar === undefined ? undefined : authorAvatarField(record.authorAvatar);
    return {
      ...(author === undefined ? {} : { author }),
      ...(authorAvatar === undefined ? {} : { authorAvatar }),
      ...(record.category === undefined ? {} : { category: categoryField(record.category) }),
      ...(record.tags === undefined ? {} : { tags: tagsField(record.tags) })
    };
  }

  function visitedAt(value) {
    if (!Number.isFinite(value) || value <= 0) {
      fail("浏览历史的访问时间异常，原数据保持不变");
    }
    return value;
  }

  function postNumber(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail("浏览历史的楼层编号异常，原数据保持不变");
    }
    return value;
  }

  function empty() {
    return { records: [] };
  }

  function readRecords(value) {
    return value.map((record) => {
      if (!isPlainObject(record)) {
        fail("浏览历史存储格式异常，原数据保持不变");
      }
      const title = record.title === undefined ? undefined : titleField(record.title);
      return {
        id: topicId(record.id),
        ...metadataFields(record),
        ...(title === undefined ? {} : { title }),
        ...(record.visitedAt === undefined ? {} : { visitedAt: visitedAt(record.visitedAt) }),
        ...(record.postNumber === undefined ? {} : { postNumber: postNumber(record.postNumber) })
      };
    });
  }

  function unique(records) {
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      fail("浏览历史存在重复主题，原数据保持不变");
    }
    if (records.length > config.visitedTopicMaxEntries) {
      fail(`浏览历史条数超过上限 ${config.visitedTopicMaxEntries}，原数据保持不变`);
    }
    return records;
  }

  // value 为 undefined 表示首次使用；旧版 string[] 只迁移 ID，其余字段留空。
  function read(value) {
    if (value === undefined) {
      return empty();
    }
    if (Array.isArray(value)) {
      return { records: unique(value.map((id) => ({ id: topicId(id) }))) };
    }
    if (!isPlainObject(value) || !Array.isArray(value.records)) {
      fail("浏览历史存储格式异常，原数据保持不变");
    }
    return { records: unique(readRecords(value.records)) };
  }

  // 有时间的按访问时间倒序，旧记录的未知时间排在后面并保持原有相对顺序。
  function sortRecords(records) {
    const timed = records.filter((record) => record.visitedAt !== undefined).sort((a, b) => b.visitedAt - a.visitedAt);
    const untimed = records.filter((record) => record.visitedAt === undefined);
    return [...timed, ...untimed];
  }

  function cap(records) {
    return records.slice(0, config.visitedTopicMaxEntries);
  }

  // 补丁里的标题为空（例如 DOM 标题尚未加载）时保留已有标题，不用空值抹掉。
  function merge(record, patch) {
    const title = patch.title === undefined ? undefined : titleField(patch.title);
    const floor = patch.postNumber === undefined ? undefined : postNumber(patch.postNumber);
    return {
      id: record.id,
      ...metadataFields(record),
      ...metadataFields(patch),
      ...(title === undefined ? (record.title === undefined ? {} : { title: record.title }) : { title }),
      ...(record.visitedAt === undefined ? {} : { visitedAt: record.visitedAt }),
      ...(floor === undefined
        ? (record.postNumber === undefined ? {} : { postNumber: record.postNumber })
        : { postNumber: floor })
    };
  }

  // 实际访问：首次建立记录，重访只更新时间戳；本次没带上的标题与楼层沿用已有值。
  function visit(records, entry) {
    const id = topicId(entry.id);
    const previous = records.find((record) => record.id === id) || { id };
    const record = { ...merge(previous, entry), visitedAt: visitedAt(entry.visitedAt) };
    return cap(sortRecords([...records.filter((item) => item.id !== id), record]));
  }

  // 楼层与标题的后续补足必须命中同一次实际访问（visitedAt 一致）：记录已删除或已被新的访问覆盖时不再写入。
  function update(records, entry) {
    const id = topicId(entry.id);
    const stamp = visitedAt(entry.visitedAt);
    const previous = records.find((record) => record.id === id);
    if (!previous || previous.visitedAt !== stamp) {
      return null;
    }
    const record = merge(previous, entry);
    if (record.title === previous.title && record.postNumber === previous.postNumber && record.author === previous.author
      && record.authorAvatar === previous.authorAvatar
      && JSON.stringify(record.category) === JSON.stringify(previous.category)
      && JSON.stringify(record.tags) === JSON.stringify(previous.tags)) {
      return null;
    }
    return sortRecords(records.map((item) => (item.id === id ? record : item)));
  }

  function remove(records, id) {
    return records.filter((record) => record.id !== topicId(id));
  }

  function clear() {
    return empty();
  }

  // 内容脚本只需要已看标记的 ID 投影。
  function idSet(records) {
    return new Set(records.map((record) => record.id));
  }

  globalThis.BETTERLD_HISTORY_STORE = Object.freeze({
    empty,
    read,
    sortRecords,
    visit,
    update,
    remove,
    clear,
    idSet
  });
})();
