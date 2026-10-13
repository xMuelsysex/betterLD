(() => {
  "use strict";

  // 主世界桥接：个人表情库把图片交给站点自己的上传器（composer:add-files + skipPlaceholder），
  // 成功后才把 getUploadMarkdown 的结果插到草稿光标处，不自动发送、不引用原图地址。
  // 站点模块、草稿模型与光标都只在主世界可见，因此这里独立成模块，不写进 page-refresh 大文件。
  if (globalThis.__betterldStickerComposer) {
    document.dispatchEvent(new CustomEvent("betterld:sticker-bridge-ready"));
    return;
  }
  globalThis.__betterldStickerComposer = true;

  const STATE_REQUEST = "betterld:sticker-state";
  const STATE_RESULT = "betterld:sticker-state-result";
  const UPLOAD_REQUEST = "betterld:sticker-upload";
  const UPLOAD_RESULT = "betterld:sticker-upload-result";

  let epoch = 0;
  let captureSeq = 0;
  let capture = null;
  let appEventsCache = null;
  const compatiblePlaceholders = new WeakSet();

  function owner() {
    const getOwner = window.require?.("discourse/lib/get-owner")?.getOwnerWithFallback;
    if (typeof getOwner !== "function") {
      throw new Error("无法访问站点模块，请刷新页面后重试");
    }
    return getOwner();
  }

  function appEvents() {
    if (!appEventsCache) {
      appEventsCache = owner().lookup("service:app-events");
      if (!appEventsCache?.on) {
        appEventsCache = null;
        throw new Error("站点事件服务不可用，请刷新页面后重试");
      }
      // 草稿生命周期事件让已捕获的草稿身份立刻失效：关闭、重开或换回复对象后都不会再插入。
      ["composer:opened", "composer:closed", "composer:will-open", "composer:reply-changed"].forEach((name) => {
        appEventsCache.on(name, () => {
          epoch += 1;
          capture = null;
        });
      });
    }
    return appEventsCache;
  }

  // 草稿身份取模型对象、目标、正文全文、编辑器节点与选区：等长改稿、关闭重开、切换草稿都会失效。
  // 不上传期间会变的 DOM 类名（is-uploading 等）不进入身份。
  function plainId(value) {
    const record = value && typeof value.then !== "function" ? value : null;
    const id = record?.id;
    return id === undefined || id === null ? "" : String(id);
  }

  function composerIdentity() {
    const composer = owner().lookup("service:composer");
    const model = composer?.model;
    const control = document.querySelector("#reply-control.open");
    const textarea = control?.querySelector("textarea.d-editor-input") || null;
    if (!model || !control || !textarea) {
      return null;
    }
    return {
      model,
      draftKey: String(model.draftKey ?? ""),
      draftSequence: String(model.draftSequence ?? ""),
      action: String(model.action ?? ""),
      topicId: plainId(model.topic),
      postId: plainId(model.post),
      replyToPostNumber: String(model.reply_to_post_number ?? ""),
      reply: String(model.reply ?? ""),
      textarea,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      canUpload: composer.allowUpload !== false
    };
  }

  function sameIdentity(left, right) {
    if (!left || !right) {
      return false;
    }
    return left.model === right.model
      && left.draftKey === right.draftKey
      && left.draftSequence === right.draftSequence
      && left.action === right.action
      && left.topicId === right.topicId
      && left.postId === right.postId
      && left.replyToPostNumber === right.replyToPostNumber
      && left.reply === right.reply
      && left.textarea === right.textarea
      && left.canUpload === right.canUpload;
  }

  function captureComposer() {
    // 先注册生命周期监听，再捕获：这样从捕获到上传之间发生的关闭／重开一定会让身份失效。
    appEvents();
    const identity = composerIdentity();
    if (!identity) {
      capture = null;
      return { open: false };
    }
    captureSeq += 1;
    capture = { id: `${captureSeq}`, identity, epoch, at: Date.now() };
    return { open: true, captureId: capture.id, canUpload: identity.canUpload };
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  // 站点自己的图片 Markdown 用缩略图尺寸；没有缩略图的动图按原图尺寸补上，避免插入 undefined。
  function markdownFor(uploads, body) {
    const normalized = { ...body };
    if (normalized.thumbnail_width === undefined && normalized.width !== undefined) {
      normalized.thumbnail_width = normalized.width;
    }
    if (normalized.thumbnail_height === undefined && normalized.height !== undefined) {
      normalized.thumbnail_height = normalized.height;
    }
    return uploads.getUploadMarkdown(normalized);
  }

  function prepareUploader(identity) {
    const views = owner().lookup("-view-registry:main");
    const uploader = Object.values(views).map((view) => view.uppyComposerUpload).find((candidate) =>
      candidate?.composerModel === identity.model
      && candidate.textManipulation?.textarea === identity.textarea
    );
    if (!uploader?.uppyWrapper?.uppyInstance) {
      throw new Error("原站图片上传器尚未就绪，请重新打开编辑器后重试");
    }
    const placeholder = uploader.textManipulation.placeholder;
    if (typeof placeholder?.progress !== "function" || typeof placeholder.progressComplete !== "function") {
      throw new Error("原站上传预处理接口已变化，图片未上传");
    }
    if (compatiblePlaceholders.has(placeholder)) {
      return;
    }
    // 原站只在 insert/success 中处理 skipPlaceholder；预处理仍访问未创建的占位符。
    // 在同一实例补齐该语义，普通原生文件仍使用原方法，不修改站点类或上传插件。
    for (const name of ["progress", "progressComplete"]) {
      const original = placeholder[name];
      placeholder[name] = function (file, ...args) {
        if (file.meta?.skipPlaceholder) {
          return;
        }
        return original.call(this, file, ...args);
      };
    }
    compatiblePlaceholders.add(placeholder);
  }

  // 等待本次上传的真实结果：超时后立刻摘掉监听，之后再成功也不会插入，busy 也不会一直挂着。
  function waitForUpload(events, file, timeoutMs) {
    const fileName = file.name;
    return new Promise((resolve, reject) => {
      const handlers = {};
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("站点上传超时：没有收到上传结果，图片可能仍在后台上传，未插入草稿"));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        Object.entries(handlers).forEach(([name, handler]) => events.off(name, handler));
      }
      handlers["composer:upload-success"] = (name, upload) => {
        if (name !== fileName) {
          return;
        }
        cleanup();
        resolve(upload);
      };
      handlers["composer:upload-error"] = (file) => {
        if (!file || file.name !== fileName) {
          return;
        }
        cleanup();
        reject(new Error(file.meta?.error || "站点上传失败"));
      };
      // 取消与中止只在没有其他上传在进行时触发，因此这里收到的就是本次上传。
      handlers["composer:uploads-cancelled"] = () => {
        cleanup();
        reject(new Error("上传已取消"));
      };
      handlers["composer:uploads-aborted"] = () => {
        cleanup();
        reject(new Error("上传已中止"));
      };
      Object.entries(handlers).forEach(([name, handler]) => events.on(name, handler));
      try {
        events.trigger("composer:add-files", [file], { skipPlaceholder: true });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function upload(payload) {
    const events = appEvents();
    const current = capture;
    if (!current || current.id !== payload.captureId || current.epoch !== epoch) {
      throw new Error("草稿已切换，图片未上传");
    }
    if (!sameIdentity(composerIdentity(), current.identity)) {
      throw new Error("草稿已关闭或已修改，图片未上传");
    }
    if (current.identity.canUpload === false) {
      throw new Error("当前草稿不允许上传文件");
    }
    try {
      const uploads = window.require("discourse/lib/uploads");
      const bytes = base64ToBytes(payload.base64);
      // 唯一文件名关联本次结果，避免超时重试与原生并行上传同名图片时串结果。
      const fileName = `${payload.id}-${payload.fileName}`;
      const file = new File([bytes], fileName, { type: payload.mime });
      const siteSettings = owner().lookup("service:site-settings");
      const allowed = uploads.validateUploadedFile(file, {
        siteSettings,
        user: owner().lookup("service:current-user"),
        isPrivateMessage: current.identity.model.privateMessage,
        allowStaffToUploadAnyFileInPm: siteSettings.allow_staff_to_upload_any_file_in_pm
      });
      if (!allowed) {
        throw new Error("站点不接受这张图片：格式、大小或当前账号的上传权限不符合站点规则");
      }
      prepareUploader(current.identity);
      const uploaded = await waitForUpload(events, file, payload.timeoutMs);
      if (!uploaded?.short_url) {
        throw new Error("站点上传成功但没有返回图片地址");
      }
      const markdown = markdownFor(uploads, uploaded);
      // 上传期间关闭、重开或换草稿都会让捕获失效，此时不再插入。
      if (capture !== current || current.epoch !== epoch) {
        throw new Error("草稿已关闭或已切换，图片已上传但未插入，请重新点击表情");
      }
      if (!sameIdentity(composerIdentity(), current.identity)) {
        throw new Error("草稿正文已修改，图片已上传但未插入，请把光标放到目标位置后重新点击表情");
      }
      // 按捕获时的光标插入：先聚焦原 textarea 再恢复选区，避免插到用户新点的位置。
      const { textarea, selectionStart, selectionEnd } = current.identity;
      textarea.focus();
      textarea.selectionStart = selectionStart;
      textarea.selectionEnd = selectionEnd;
      events.trigger("composer:insert-text", markdown);
      return { markdown };
    } finally {
      // 一次捕获只能用一次：超时、失败或成功之后都不再接受同一个草稿身份的上传。
      if (capture?.id === current.id) {
        capture = null;
      }
    }
  }

  function respond(type, payload) {
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload) }));
  }

  document.addEventListener(STATE_REQUEST, (event) => {
    const { id } = JSON.parse(event.detail);
    try {
      respond(STATE_RESULT, { id, state: captureComposer() });
    } catch (error) {
      respond(STATE_RESULT, { id, error: error.message || "草稿状态读取失败" });
    }
  });

  document.addEventListener(UPLOAD_REQUEST, async (event) => {
    const payload = JSON.parse(event.detail);
    try {
      const result = await upload(payload);
      respond(UPLOAD_RESULT, { id: payload.id, ok: true, markdown: result.markdown });
    } catch (error) {
      respond(UPLOAD_RESULT, { id: payload.id, ok: false, error: error.message || "图片上传失败" });
    }
  });

  document.dispatchEvent(new CustomEvent("betterld:sticker-bridge-ready"));
})();
