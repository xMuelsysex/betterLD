(() => {
  "use strict";

  // ZIP 读取只依赖平台原生的 DecompressionStream('deflate-raw')，不引入运行时依赖，也不做 CRC 校验：
  // 条目完整性由解压本身与调用方的格式检查体现，解压失败原样报错。
  const config = globalThis.BETTERLD_CONFIG;
  const limits = config?.stickerLibrary;
  if (!limits?.zipMaxEntries) {
    throw new Error("betterLD ZIP 模块缺少配置");
  }

  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  const ZIP64_MARKER = 0xffffffff;
  const EOCD_MIN_SIZE = 22;
  const MAX_COMMENT_SIZE = 0xffff;
  const METHOD_STORED = 0;
  const METHOD_DEFLATE = 8;

  function fail(message) {
    throw new Error(message);
  }

  function viewOf(bytes) {
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  function findEndOfCentralDirectory(view) {
    const start = Math.max(0, view.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
    for (let offset = view.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
      if (view[offset] === 0x50 && view[offset + 1] === 0x4b && view[offset + 2] === 0x05 && view[offset + 3] === 0x06) {
        const commentLength = view[offset + 20] | (view[offset + 21] << 8);
        if (offset + EOCD_MIN_SIZE + commentLength === view.length) {
          return offset;
        }
      }
    }
    fail("不是有效的 ZIP 文件：找不到中央目录");
  }

  function u16(view, offset) {
    return view[offset] | (view[offset + 1] << 8);
  }

  function u32(view, offset) {
    return (view[offset] | (view[offset + 1] << 8) | (view[offset + 2] << 16) | (view[offset + 3] << 24)) >>> 0;
  }

  // 只解析中央目录：条目名、压缩方式与本地头偏移都在这里，读取顺序与 ZIP 规范一致。
  // 单个条目本身不可读（加密、压缩方式不支持）时带 reason 返回，由调用方逐项报告，不让整包失败。
  function readEntries(bytes) {
    const view = viewOf(bytes);
    if (view.length < EOCD_MIN_SIZE) {
      fail("不是有效的 ZIP 文件：内容过短");
    }
    const eocd = findEndOfCentralDirectory(view);
    const total = u16(view, eocd + 10);
    const centralOffset = u32(view, eocd + 16);
    const centralSize = u32(view, eocd + 12);
    if (centralOffset === ZIP64_MARKER || centralSize === ZIP64_MARKER || total === 0xffff) {
      fail("不支持 ZIP64 格式的压缩包");
    }
    if (centralOffset + centralSize > view.length) {
      fail("ZIP 中央目录超出文件范围，压缩包可能已损坏");
    }
    if (total > limits.zipMaxEntries) {
      fail(`ZIP 条目数 ${total} 超过上限 ${limits.zipMaxEntries}`);
    }
    const entries = [];
    let offset = centralOffset;
    for (let index = 0; index < total; index += 1) {
      if (offset + 46 > view.length || u32(view, offset) !== CENTRAL_SIGNATURE) {
        fail("ZIP 中央目录格式异常，压缩包可能已损坏");
      }
      const method = u16(view, offset + 10);
      const flags = u16(view, offset + 8);
      const compressedSize = u32(view, offset + 20);
      const uncompressedSize = u32(view, offset + 24);
      const nameLength = u16(view, offset + 28);
      const extraLength = u16(view, offset + 30);
      const commentLength = u16(view, offset + 32);
      const localOffset = u32(view, offset + 42);
      if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
        fail("不支持 ZIP64 格式的压缩包");
      }
      const name = new TextDecoder("utf-8").decode(view.subarray(offset + 46, offset + 46 + nameLength));
      let reason = "";
      if (flags & 0x0001) {
        reason = "条目已加密，无法读取";
      } else if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        reason = `使用了不支持的压缩方式 ${method}`;
      }
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset, reason });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  function localDataOffset(view, entry) {
    const offset = entry.localOffset;
    if (offset + 30 > view.length || u32(view, offset) !== LOCAL_SIGNATURE) {
      fail(`ZIP 条目「${entry.name}」的本地头无效，压缩包可能已损坏`);
    }
    return offset + 30 + u16(view, offset + 26) + u16(view, offset + 28);
  }

  // 边解压边计量实际输出：超过单张上限立即中止，不把整包解压结果堆在内存里。
  async function inflateRaw(chunk, maxBytes, entryName) {
    if (typeof DecompressionStream !== "function") {
      fail("当前浏览器不支持原生 ZIP 解压（DecompressionStream）");
    }
    const stream = new Blob([chunk]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        fail(`ZIP 条目「${entryName}」解压后超过单张上限`);
      }
      parts.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  // 只解压单个条目：存储方式直接切片，deflate 走原生 deflate-raw。
  async function readEntry(bytes, entry, maxBytes) {
    const view = viewOf(bytes);
    const start = localDataOffset(view, entry);
    const end = start + entry.compressedSize;
    if (end > view.length) {
      fail(`ZIP 条目「${entry.name}」的数据超出文件范围`);
    }
    if (entry.compressedSize > maxBytes && entry.method === METHOD_STORED) {
      fail(`ZIP 条目「${entry.name}」超过单张上限`);
    }
    const chunk = view.subarray(start, end);
    if (entry.method === METHOD_STORED) {
      return chunk.slice();
    }
    const result = await inflateRaw(chunk, maxBytes, entry.name);
    if (result.length !== entry.uncompressedSize) {
      fail(`ZIP 条目「${entry.name}」解压后大小与目录记录不一致`);
    }
    return result;
  }

  function isDirectory(entry) {
    return entry.name.endsWith("/");
  }

  function isZipName(name) {
    return /\.zip$/i.test(String(name || ""));
  }

  function baseName(entryName) {
    const parts = String(entryName).split("/");
    return parts[parts.length - 1] || entryName;
  }

  globalThis.BETTERLD_STICKER_ZIP = Object.freeze({
    readEntries,
    readEntry,
    isDirectory,
    isZipName,
    baseName
  });
})();
