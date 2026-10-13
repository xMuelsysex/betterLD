(() => {
  "use strict";

  // 表情库存储：扩展后台与扩展设置页共用的 IndexedDB 访问层，图片本体只在这里保存。
  // 元数据与二进制分开两个 store：列表与容量统计不需要读出图片本体，面板与设置页不会来回搬运整库载荷。
  // 每次写入都在同一个 readwrite 事务里同时更新 items／blobs／folders／meta，跨标签并发写不会互相覆盖。
  const config = globalThis.BETTERLD_CONFIG;
  const sticker = config?.stickerLibrary;
  const store = globalThis.BETTERLD_STICKER_STORE;
  if (!sticker?.dbName || !store?.classify) {
    throw new Error("betterLD 表情库存储缺少配置或规则模块");
  }

  const ITEMS = "items";
  const BLOBS = "blobs";
  const FOLDERS = "folders";
  const META = "meta";
  const TOTAL_KEY = "totalBytes";

  function fail(message) {
    throw new Error(message);
  }

  function request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败"));
    });
  }

  // 缩略图只为面板预览服务：等比缩到配置边长，类型由配置决定，解码失败原样抛错。
  async function makeThumbnail(blob) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      fail("当前运行环境不支持生成表情缩略图");
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (error) {
      fail(`无法解码这张图片：${error.message || "格式不受支持"}`);
    }
    const max = sticker.thumbnailMaxSizePx;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      fail("无法创建表情缩略图画布");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const thumb = await canvas.convertToBlob({ type: sticker.thumbnailType, quality: 0.9 });
    return { blob: thumb, type: thumb.type || sticker.thumbnailType };
  }

  function createStickerDb(factory) {
    if (!factory?.open) {
      fail("当前环境没有可用的 IndexedDB");
    }
    let openPromise = null;

    function open() {
      if (openPromise) {
        return openPromise;
      }
      openPromise = new Promise((resolve, reject) => {
        const upgrade = factory.open(sticker.dbName, sticker.dbVersion);
        upgrade.onupgradeneeded = () => {
          const db = upgrade.result;
          if (!db.objectStoreNames.contains(ITEMS)) {
            const items = db.createObjectStore(ITEMS, { keyPath: "id" });
            items.createIndex("size", "size");
            items.createIndex("folderId", "folderId");
            items.createIndex("createdAt", "createdAt");
          }
          if (!db.objectStoreNames.contains(BLOBS)) {
            db.createObjectStore(BLOBS, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(FOLDERS)) {
            db.createObjectStore(FOLDERS, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META, { keyPath: "key" });
          }
        };
        upgrade.onsuccess = () => resolve(upgrade.result);
        upgrade.onerror = () => reject(upgrade.error || new Error("表情库存储打开失败"));
        upgrade.onblocked = () => reject(new Error("表情库存储被其他页面占用，请关闭其他 betterLD 页面后重试"));
      });
      return openPromise;
    }

    // work 只等待 IndexedDB 请求；任何抛出或拒绝都中止事务并把错误带回调用方。
    async function run(storeNames, mode, work) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        let result;
        let failure = null;
        let settled = false;
        const finish = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        };
        transaction.oncomplete = () => finish(failure);
        transaction.onabort = () => finish(failure || transaction.error || new Error("表情库存储事务已中止"));
        transaction.onerror = () => {
          failure = failure || transaction.error || new Error("表情库存储事务失败");
        };
        let outcome;
        try {
          outcome = work(transaction);
        } catch (error) {
          failure = error;
          transaction.abort();
          return;
        }
        Promise.resolve(outcome).then(
          (value) => {
            result = value;
          },
          (error) => {
            failure = error;
            try {
              transaction.abort();
            } catch {
              finish(error);
            }
          }
        );
      });
    }

    async function totalBytes(transaction) {
      const record = await request(transaction.objectStore(META).get(TOTAL_KEY));
      return Number(record?.value) || 0;
    }

    function writeTotal(transaction, value) {
      transaction.objectStore(META).put({ key: TOTAL_KEY, value });
    }

    async function list() {
      const db = await open();
      const transaction = db.transaction([ITEMS, FOLDERS, META], "readonly");
      const folders = await request(transaction.objectStore(FOLDERS).getAll());
      const items = await request(transaction.objectStore(ITEMS).getAll());
      const used = await totalBytes(transaction);
      return {
        folders: folders.sort((left, right) => left.createdAt - right.createdAt).map((folder) => ({ id: folder.id, name: folder.name })),
        items: items.sort((left, right) => right.createdAt - left.createdAt),
        totalBytes: used
      };
    }

    // 先把同一条只读事务里的记录全部取回，再在事务外把 Blob 转成 data URL（arrayBuffer 不是 IndexedDB 请求，不能在事务里等）。
    async function thumbs(ids) {
      const db = await open();
      const transaction = db.transaction(BLOBS, "readonly");
      const blobs = transaction.objectStore(BLOBS);
      const records = [];
      for (const id of ids) {
        const record = await request(blobs.get(id));
        if (record) {
          records.push({ id, record });
        }
      }
      const results = [];
      for (const { id, record } of records) {
        const bytes = new Uint8Array(await record.thumb.arrayBuffer());
        results.push({ id, dataUrl: store.dataUrl(record.thumbType || sticker.thumbnailType, bytes) });
      }
      return results;
    }

    async function record(id) {
      const db = await open();
      const transaction = db.transaction([ITEMS, BLOBS], "readonly");
      const item = await request(transaction.objectStore(ITEMS).get(id));
      if (!item) {
        return null;
      }
      const stored = await request(transaction.objectStore(BLOBS).get(id));
      if (!stored) {
        fail(`表情「${item.name}」的图片内容缺失，存储可能已损坏`);
      }
      const bytes = new Uint8Array(await stored.blob.arrayBuffer());
      return { ...item, dataUrl: store.dataUrl(item.type, bytes) };
    }

    // 按内容去重：同长度候选逐字节比较，文件改后缀也复用同一图片，不使用哈希。
    async function candidates(size) {
      const db = await open();
      const transaction = db.transaction(ITEMS, "readonly");
      return request(transaction.objectStore(ITEMS).index("size").getAll(size));
    }

    async function existingBytes(id) {
      const db = await open();
      const transaction = db.transaction(BLOBS, "readonly");
      const stored = await request(transaction.objectStore(BLOBS).get(id));
      if (!stored) {
        fail("表情图片内容缺失，存储可能已损坏");
      }
      return new Uint8Array(await stored.blob.arrayBuffer());
    }

    async function add({ name, folderId, type, bytes, capacity }) {
      const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const itemName = store.name(name);
      const mime = String(type || "");
      if (!store.extensionForMime(mime)) {
        fail(`不支持的图片类型：${mime || "未知"}`);
      }
      const sizeError = store.checkItemSize(value.byteLength, capacity);
      if (sizeError) {
        fail(sizeError);
      }
      const folder = folderId ?? null;
      if (folder !== null) {
        const folders = await open().then((db) => request(db.transaction(FOLDERS, "readonly").objectStore(FOLDERS).get(folder)));
        if (!folders) {
          fail("目标分组不存在");
        }
      }
      for (const candidate of await candidates(value.byteLength)) {
        if (store.bytesEqual(await existingBytes(candidate.id), value)) {
          return { status: "duplicate", item: candidate };
        }
      }
      const thumb = await makeThumbnail(new Blob([value], { type: mime }));
      const created = {
        id: crypto.randomUUID(),
        name: itemName,
        folderId: folder,
        type: mime,
        size: value.byteLength,
        createdAt: Date.now()
      };
      return run([ITEMS, BLOBS, META], "readwrite", async (transaction) => {
        const items = transaction.objectStore(ITEMS);
        const count = await request(items.count());
        if (count >= sticker.itemsMax) {
          fail(`表情数量已达上限 ${sticker.itemsMax} 张`);
        }
        const used = await totalBytes(transaction);
        const totalError = store.checkTotalSize(used, created.size, capacity);
        if (totalError) {
          fail(totalError);
        }
        items.add(created);
        transaction.objectStore(BLOBS).add({
          id: created.id,
          blob: new Blob([value], { type: mime }),
          thumb: thumb.blob,
          thumbType: thumb.type
        });
        writeTotal(transaction, used + created.size);
        return { status: "added", item: created };
      });
    }

    async function createFolderIfMissing(folderName) {
      const value = store.folderName(folderName);
      const db = await open();
      const existing = await request(db.transaction(FOLDERS, "readonly").objectStore(FOLDERS).getAll());
      const found = existing.find((folder) => folder.name === value);
      if (found) {
        return found;
      }
      return createFolder(value);
    }

    async function createFolder(folderName) {
      const value = store.folderName(folderName);
      return run(FOLDERS, "readwrite", async (transaction) => {
        const objectStore = transaction.objectStore(FOLDERS);
        const existing = await request(objectStore.getAll());
        if (existing.some((folder) => folder.name === value)) {
          fail(`分组「${value}」已存在`);
        }
        if (existing.length >= sticker.foldersMax) {
          fail(`分组数量已达上限 ${sticker.foldersMax}`);
        }
        const folder = { id: crypto.randomUUID(), name: value, createdAt: Date.now() };
        objectStore.add(folder);
        return folder;
      });
    }

    async function renameFolder(id, folderName) {
      const value = store.folderName(folderName);
      return run(FOLDERS, "readwrite", async (transaction) => {
        const objectStore = transaction.objectStore(FOLDERS);
        const folder = await request(objectStore.get(id));
        if (!folder) {
          fail("分组不存在");
        }
        const existing = await request(objectStore.getAll());
        if (existing.some((item) => item.id !== id && item.name === value)) {
          fail(`分组「${value}」已存在`);
        }
        const updated = { ...folder, name: value };
        objectStore.put(updated);
        return updated;
      });
    }

    // 删除分组只删分组：里面的表情回到未分组，图片本体与名称不变。
    async function deleteFolder(id) {
      return run([ITEMS, FOLDERS], "readwrite", async (transaction) => {
        const folders = transaction.objectStore(FOLDERS);
        const folder = await request(folders.get(id));
        if (!folder) {
          fail("分组不存在");
        }
        folders.delete(id);
        const items = transaction.objectStore(ITEMS);
        const records = await request(items.index("folderId").getAll(id));
        records.forEach((record) => items.put({ ...record, folderId: null }));
        return { movedItems: records.length };
      });
    }

    async function rename(id, itemName) {
      const value = store.name(itemName);
      return run(ITEMS, "readwrite", async (transaction) => {
        const objectStore = transaction.objectStore(ITEMS);
        const record = await request(objectStore.get(id));
        if (!record) {
          fail("表情不存在");
        }
        const updated = { ...record, name: value };
        objectStore.put(updated);
        return updated;
      });
    }

    async function move(ids, folderId) {
      return run([ITEMS, FOLDERS], "readwrite", async (transaction) => {
        const target = folderId ?? null;
        if (target !== null && !(await request(transaction.objectStore(FOLDERS).get(target)))) {
          fail("目标分组不存在");
        }
        const objectStore = transaction.objectStore(ITEMS);
        let moved = 0;
        for (const id of ids) {
          const record = await request(objectStore.get(id));
          if (!record) {
            continue;
          }
          objectStore.put({ ...record, folderId: target });
          moved += 1;
        }
        return { moved };
      });
    }

    async function remove(ids) {
      return run([ITEMS, BLOBS, META], "readwrite", async (transaction) => {
        const items = transaction.objectStore(ITEMS);
        const blobs = transaction.objectStore(BLOBS);
        let used = await totalBytes(transaction);
        let removed = 0;
        for (const id of ids) {
          const record = await request(items.get(id));
          if (!record) {
            continue;
          }
          items.delete(id);
          blobs.delete(id);
          used -= record.size;
          removed += 1;
        }
        writeTotal(transaction, Math.max(0, used));
        return { removed };
      });
    }

    return Object.freeze({
      list,
      thumbs,
      record,
      add,
      createFolder,
      createFolderIfMissing,
      renameFolder,
      deleteFolder,
      rename,
      move,
      remove
    });
  }

  globalThis.BETTERLD_STICKER_DB = Object.freeze({ createStickerDb });
})();
