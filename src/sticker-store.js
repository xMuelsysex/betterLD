(() => {
  "use strict";

  // 个人表情库的唯一规则来源：名称与分组校验、格式分类、容量上限、字节比较与备份载荷。
  // 后台、内容脚本面板与设置页共用同一份规则，存储与 UI 各自不重复实现。
  const config = globalThis.BETTERLD_CONFIG;
  const sticker = config?.stickerLibrary;
  if (!sticker?.supportedExtensions || !sticker.dbName) {
    throw new Error("betterLD 表情库模块缺少配置");
  }

  const supported = new Set(sticker.supportedExtensions);
  const unsupported = sticker.unsupportedExtensions || {};
  const mimeByExtension = Object.freeze({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif"
  });
  const extensionByMime = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/avif": "avif"
  });

  function fail(message) {
    throw new Error(message);
  }

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  // 名称只保留可显示文本，去掉路径分隔符与控制字符，避免下载与上传时被当成路径。
  function cleanName(value) {
    return text(value)
      .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function name(value) {
    const result = cleanName(value);
    if (!result) {
      fail("表情名称不能为空");
    }
    if (result.length > sticker.nameMaxLength) {
      fail(`表情名称不能超过 ${sticker.nameMaxLength} 字`);
    }
    return result;
  }

  function folderName(value) {
    const result = cleanName(value);
    if (!result) {
      fail("分组名称不能为空");
    }
    if (result.length > sticker.folderNameMaxLength) {
      fail(`分组名称不能超过 ${sticker.folderNameMaxLength} 字`);
    }
    return result;
  }

  function folderId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      fail("表情分组 ID 无效");
    }
    return value;
  }

  function extensionOf(fileName) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(text(fileName).trim());
    return match ? match[1].toLowerCase() : "";
  }

  // 分类只按扩展名与不支持清单判定；声明类型不作为依据，避免扩展名与内容不符时静默收下。
  function classify(fileName, mimeType) {
    const extension = extensionOf(fileName);
    if (!extension) {
      return { ok: false, reason: "文件没有扩展名，无法确认图片格式" };
    }
    if (Object.prototype.hasOwnProperty.call(unsupported, extension)) {
      return { ok: false, reason: `不支持 ${unsupported[extension]}（.${extension}）` };
    }
    if (!supported.has(extension)) {
      const declared = text(mimeType) ? `（声明类型 ${mimeType}）` : "";
      return { ok: false, reason: `不支持的图片格式：.${extension}${declared}` };
    }
    return { ok: true, extension, mime: mimeByExtension[extension] };
  }

  function extensionForMime(mimeType) {
    return extensionByMime[text(mimeType).toLowerCase()] || "";
  }

  function limits(settings) {
    const itemMiB = Number(settings?.stickerMaxItemMiB);
    const totalMiB = Number(settings?.stickerMaxTotalMiB);
    const itemLimits = config.settingsLimits.stickerMaxItemMiB;
    const totalLimits = config.settingsLimits.stickerMaxTotalMiB;
    const clamp = (value, range, fallback) => (Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : fallback);
    return {
      itemBytes: clamp(itemMiB, itemLimits, config.settingsDefaults.stickerMaxItemMiB) * 1024 * 1024,
      totalBytes: clamp(totalMiB, totalLimits, config.settingsDefaults.stickerMaxTotalMiB) * 1024 * 1024
    };
  }

  function checkItemSize(size, capacity) {
    if (!Number.isFinite(size) || size <= 0) {
      return "图片内容为空，未保存";
    }
    if (size > capacity.itemBytes) {
      return `单张图片 ${formatBytes(size)} 超过上限 ${formatBytes(capacity.itemBytes)}`;
    }
    return "";
  }

  function checkTotalSize(usedBytes, addBytes, capacity) {
    if (usedBytes + addBytes > capacity.totalBytes) {
      return `整库容量不足：已用 ${formatBytes(usedBytes)}，本次 ${formatBytes(addBytes)} 会超过上限 ${formatBytes(capacity.totalBytes)}`;
    }
    return "";
  }

  function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      return "0 B";
    }
    if (number < 1024) {
      return `${number} B`;
    }
    const units = ["KiB", "MiB", "GiB"];
    let size = number / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
  }

  // 实际字节比较：先比长度再逐字节比对，不使用任何哈希。
  function bytesEqual(left, right) {
    if (!left || !right || left.byteLength !== right.byteLength) {
      return false;
    }
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return false;
      }
    }
    return true;
  }

  // 分块编码避免超长字符串一次性展开导致调用栈溢出。
  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < view.length; offset += chunkSize) {
      binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(value, maxBytes) {
    const encoded = text(value);
    if (maxBytes !== undefined && encoded.length > Math.ceil(maxBytes / 3) * 4) {
      fail(`图片内容超过单张上限 ${formatBytes(maxBytes)}`);
    }
    let binary;
    try {
      binary = atob(encoded);
    } catch {
      fail("图片内容不是有效的 Base64 编码");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function dataUrl(mimeType, bytes) {
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  }

  // 上传与下载都用「名称.扩展名」，扩展名来自存储的图片类型，不用名称里的旧后缀。
  function fileNameFor(item) {
    const extension = extensionForMime(item?.type);
    if (!extension) {
      fail(`无法确认图片类型：${text(item?.type) || "未知"}`);
    }
    const base = cleanName(item?.name) || "sticker";
    return `${base.slice(0, sticker.nameMaxLength)}.${extension}`;
  }

  // 下载到电脑的文件名：名称来自原站图片说明或文件名，扩展名由调用方按实际地址给出。
  function downloadName(value, extension) {
    if (!extension) {
      return "";
    }
    const base = cleanName(value) || "sticker";
    return `${sticker.downloadFilenamePrefix}-${base.slice(0, sticker.downloadNameMaxLength)}.${extension}`;
  }
  // 备份是单一 JSON：图片本体以 base64 内嵌，名称与分组名一起保存，导入端按名称复用本地分组。
  // 备份解析：根结构错误整份失败，单个条目错误只记入 failed，其余条目继续导入。
  function readBackup(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("表情库备份必须是 JSON 对象");
    }
    if (value.schema !== sticker.schema) {
      fail(`未知的备份类型：${String(value.schema)}`);
    }
    if (value.schemaVersion !== sticker.schemaVersion) {
      fail(`备份版本 ${String(value.schemaVersion)} 与当前支持的 ${sticker.schemaVersion} 不一致`);
    }
    if (!Array.isArray(value.folders) || !Array.isArray(value.stickers)) {
      fail("表情库备份缺少分组或表情数据");
    }
    if (value.folders.length > sticker.foldersMax) {
      fail(`备份分组数量超过上限 ${sticker.foldersMax}`);
    }
    const failed = [];
    const folders = [];
    value.folders.forEach((folder, index) => {
      try {
        folders.push({ id: folderId(folder?.id), name: folderName(folder?.name) });
      } catch (error) {
        failed.push({ name: `第 ${index + 1} 个分组`, reason: error.message });
      }
    });
    const stickers = [];
    value.stickers.forEach((item, index) => {
      const entry = item && typeof item === "object" ? item : null;
      const label = cleanName(entry?.name) || `第 ${index + 1} 个表情`;
      try {
        if (!entry) {
          fail("表情记录格式异常");
        }
        const classified = classify(entry.fileName || `${cleanName(entry.name)}.${extensionForMime(entry.type)}`, entry.type);
        if (!classified.ok) {
          fail(classified.reason);
        }
        if (typeof entry.data !== "string" || !entry.data) {
          fail("缺少图片内容");
        }
        stickers.push({
          name: name(entry.name),
          folder: entry.folder ? folderName(entry.folder) : "",
          type: classified.mime,
          extension: classified.extension,
          data: entry.data
        });
      } catch (error) {
        failed.push({ name: label, reason: error.message });
      }
    });
    return { folders, stickers, failed };
  }

  globalThis.BETTERLD_STICKER_STORE = Object.freeze({
    name,
    folderName,
    folderId,
    classify,
    extensionOf,
    extensionForMime,
    limits,
    checkItemSize,
    checkTotalSize,
    formatBytes,
    bytesEqual,
    bytesToBase64,
    base64ToBytes,
    dataUrl,
    fileNameFor,
    downloadName,
    readBackup
  });
})();
