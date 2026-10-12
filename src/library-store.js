(() => {
  "use strict";

  // 收藏库根对象的唯一规则：默认结构、读取校验、导入合并与导出载荷都在这里，后台、面板与设置页共用。
  const config = globalThis.BETTERLD_CONFIG;
  const entry = globalThis.BETTERLD_LIBRARY_ENTRY;
  if (!config?.librarySchemaVersion || !entry?.validate) {
    throw new Error("betterLD 收藏库模块缺少配置或条目规则");
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

  function empty() {
    return { schemaVersion: config.librarySchemaVersion, later: [], favorites: [], folders: [] };
  }

  function folderId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      fail("收藏分组 ID 无效");
    }
    return value;
  }

  function folderName(value) {
    if (typeof value !== "string") {
      fail("收藏分组名称必须是文本");
    }
    const name = value.trim();
    if (!name) {
      fail("收藏分组名称不能为空");
    }
    if (name.length > config.libraryFolderNameMaxLength) {
      fail(`收藏分组名称不能超过 ${config.libraryFolderNameMaxLength} 字`);
    }
    return name;
  }

  function readFolders(value) {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      fail("收藏分组数据格式异常，原数据保持不变");
    }
    if (value.length > config.libraryFoldersMax) {
      fail(`收藏分组数量超过上限 ${config.libraryFoldersMax}`);
    }
    const seen = new Set();
    return value.map((folder) => {
      if (!isPlainObject(folder)) {
        fail("收藏分组数据格式异常，原数据保持不变");
      }
      const id = folderId(folder.id);
      if (seen.has(id)) {
        fail("收藏分组 ID 重复，原数据保持不变");
      }
      seen.add(id);
      return { id, name: folderName(folder.name) };
    });
  }

  function storedItem(item, group) {
    if (!isPlainObject(item)) {
      fail("收藏存储格式异常，原数据保持不变");
    }
    entry.validate(item);
    if (!Number.isFinite(item.savedAt)) {
      fail("收藏保存时间异常，原数据保持不变");
    }
    if (group === "later" && (item.postNumber !== undefined || item.folderId !== undefined)) {
      fail("稍后再看不能带楼层或分组，原数据保持不变");
    }
    return {
      id: String(item.id),
      ...(item.postNumber === undefined ? {} : { postNumber: item.postNumber }),
      title: item.title.trim().slice(0, config.libraryTitleMaxLength),
      href: entry.href(item),
      savedAt: item.savedAt,
      ...(item.folderId === undefined ? {} : { folderId: item.folderId })
    };
  }

  function uniqueItems(list, group) {
    const keys = new Set();
    list.forEach((item) => {
      const key = entry.key(item);
      if (keys.has(key)) {
        fail(`${group}存在重复条目，原数据保持不变`);
      }
      keys.add(key);
    });
    return list;
  }

  // value 为 undefined 表示首次使用；其余情况格式异常一律抛错，不写回原存储。
  // 导入允许同一备份内重复条目（由 merge 计入 duplicates 并去重），存储读取仍要求唯一。
  function read(value, allowDuplicates = false) {
    if (value === undefined) {
      return empty();
    }
    if (!isPlainObject(value)) {
      fail("收藏存储格式异常，原数据保持不变");
    }
    if (!Array.isArray(value.later) || !Array.isArray(value.favorites)) {
      fail("收藏存储格式异常，原数据保持不变");
    }
    const folders = readFolders(value.folders);
    const folderIds = new Set(folders.map((folder) => folder.id));
    const schemaVersion = value.schemaVersion === undefined ? config.librarySchemaVersion : value.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      fail("收藏库版本号无效，原数据保持不变");
    }
    if (schemaVersion > config.librarySchemaVersion) {
      fail(`收藏库版本 ${schemaVersion} 高于当前扩展支持的 ${config.librarySchemaVersion}，原数据保持不变`);
    }
    const favorites = value.favorites.map((item) => {
      const record = storedItem(item, "favorites");
      if (record.folderId !== undefined) {
        folderId(record.folderId);
        if (!folderIds.has(record.folderId)) {
          fail("收藏条目指向的分组不存在，原数据保持不变");
        }
      }
      return record;
    });
    const later = value.later.map((item) => storedItem(item, "later"));
    return {
      schemaVersion,
      later: allowDuplicates ? later : uniqueItems(later, "稍后再看"),
      favorites: allowDuplicates ? favorites : uniqueItems(favorites, "收藏"),
      folders
    };
  }

  function readImport(value) {
    if (!isPlainObject(value)) {
      fail("收藏备份必须是 JSON 对象");
    }
    if (value.schema !== undefined && value.schema !== "betterld.library") {
      fail(`未知的收藏备份类型：${String(value.schema)}`);
    }
    if (!Array.isArray(value.later) || !Array.isArray(value.favorites) || !Array.isArray(value.folders)) {
      fail("收藏备份缺少稍后再看、收藏或分组数据");
    }
    return read(value, true);
  }

  // 新条目统一由这里构造，避免后台与设置页各写一份 href/标题规则。
  function record(topic) {
    return {
      id: String(topic.id),
      ...(topic.postNumber === undefined ? {} : { postNumber: topic.postNumber }),
      title: topic.title.trim().slice(0, config.libraryTitleMaxLength),
      href: entry.href(topic),
      savedAt: Date.now()
    };
  }

  function uniqueFolderId(library) {
    const used = new Set(library.folders.map((folder) => folder.id));
    let id = crypto.randomUUID();
    while (used.has(id)) {
      id = crypto.randomUUID();
    }
    return id;
  }

  // 追加式导入：同键条目保留本地归属；分组按同 ID 同名或同名复用本地分组，
  // 非冲突的新分组（含空分组备份）直接恢复；只有同 ID 异名冲突才延迟到真正有新收藏需要时才另建新 ID。
  function merge(current, incoming) {
    const folders = current.folders.map((folder) => ({ ...folder }));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const byName = new Map(folders.map((folder) => [folder.name, folder]));
    const folderIdMap = new Map();
    const pendingFolders = new Map();
    const localNames = new Map();

    function addFolder(id, name, localName) {
      const created = { id, name };
      folders.push(created);
      byId.set(id, created);
      byName.set(name, created);
      if (localName !== undefined) {
        folderConflicts.push({ id, name, localName });
      }
      return id;
    }

    const folderConflicts = [];

    for (const folder of incoming.folders) {
      const sameId = byId.get(folder.id);
      if (sameId && sameId.name === folder.name) {
        folderIdMap.set(folder.id, sameId.id);
        continue;
      }
      const sameName = byName.get(folder.name);
      if (sameName) {
        folderIdMap.set(folder.id, sameName.id);
        continue;
      }
      if (sameId) {
        localNames.set(folder.id, sameId.name);
        pendingFolders.set(folder.id, folder);
        continue;
      }
      // 非冲突的新分组沿用导入的 ID，再次导入时按同 ID 同名复用，不再另建。
      folderIdMap.set(folder.id, addFolder(folder.id, folder.name, undefined));
    }

    // 同一冲突分组只建一个目录：已建或已被其他导入分组占用的同名目录直接复用。
    function materialize(incomingFolderId) {
      const source = pendingFolders.get(incomingFolderId);
      const sameName = byName.get(source.name);
      if (sameName) {
        folderIdMap.set(incomingFolderId, sameName.id);
        return sameName.id;
      }
      const id = uniqueFolderId({ folders });
      folderIdMap.set(incomingFolderId, addFolder(id, source.name, localNames.get(incomingFolderId)));
      return id;
    }

    function targetFolder(item) {
      if (item.folderId === undefined) {
        return undefined;
      }
      const mapped = folderIdMap.get(item.folderId);
      if (mapped !== undefined) {
        return mapped;
      }
      return materialize(item.folderId);
    }

    const later = current.later.map((item) => ({ ...item }));
    const laterKeys = new Set(later.map((item) => entry.key(item)));
    let laterAdded = 0;
    let laterDuplicates = 0;
    for (const item of incoming.later) {
      if (laterKeys.has(entry.key(item))) {
        laterDuplicates += 1;
        continue;
      }
      laterKeys.add(entry.key(item));
      later.push({ ...item });
      laterAdded += 1;
    }

    const favorites = current.favorites.map((item) => ({ ...item }));
    const favoriteKeys = new Set(favorites.map((item) => entry.key(item)));
    let favoriteAdded = 0;
    let favoriteDuplicates = 0;
    for (const item of incoming.favorites) {
      if (favoriteKeys.has(entry.key(item))) {
        favoriteDuplicates += 1;
        continue;
      }
      favoriteKeys.add(entry.key(item));
      const folderId = targetFolder(item);
      favorites.push({
        ...item,
        ...(folderId === undefined ? {} : { folderId })
      });
      favoriteAdded += 1;
    }

    if (folders.length > config.libraryFoldersMax) {
      fail(`合并后的收藏分组数量超过上限 ${config.libraryFoldersMax}`);
    }

    return {
      library: { schemaVersion: config.librarySchemaVersion, later, favorites, folders },
      summary: {
        added: { later: laterAdded, favorites: favoriteAdded },
        duplicates: { later: laterDuplicates, favorites: favoriteDuplicates },
        foldersAdded: folders.length - current.folders.length,
        folderConflicts
      }
    };
  }

  // 导出只含收藏数据：不含凭据、入口位置、设置与历史。
  function exportPayload(library) {
    return {
      schema: "betterld.library",
      schemaVersion: library.schemaVersion,
      exportedAt: new Date().toISOString(),
      later: library.later,
      favorites: library.favorites,
      folders: library.folders
    };
  }

  globalThis.BETTERLD_LIBRARY_STORE = Object.freeze({
    empty,
    read,
    readImport,
    record,
    folderId,
    folderName,
    uniqueFolderId,
    merge,
    exportPayload
  });
})();
