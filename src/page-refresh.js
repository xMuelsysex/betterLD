(() => {
  "use strict";

  // 仅在页面上下文调用原站模型：原站的 MessageBus 和分页仍由 Discourse 管理，
  // 列表主题与主题回复都直接读 Discourse 自己已经下载好的模型，避免同一份数据再请求一遍。
  let pending = null;
  let pendingHref = "";
  let replyTopicId = "";
  let replySignature = "";
  let floorTimeline = null;
  const postFields = ["id", "post_number", "reply_to_post_number", "user_id", "username", "name", "avatar_template", "created_at", "updated_at", "cooked", "post_url", "can_boost", "reactions", "reaction_users_count", "current_user_reaction", "actions_summary"];
  const boostFields = ["id", "cooked", "can_delete", "can_flag"];
  const boostUserFields = ["id", "username", "name", "avatar_template"];

  function jumpReply(postNumber, postId, requestId) {
    document.dispatchEvent(new CustomEvent("betterld:reply-jump", {
      detail: JSON.stringify({ topicId: replyTopicId, postNumber, postId, requestId })
    }));
  }

  function resetFloorTimeline() {
    if (!floorTimeline) return;
    clearTimeout(floorTimeline.timer);
    floorTimeline.host.classList.remove("betterld-floor-timeline-active");
    floorTimeline.element.remove();
    floorTimeline = null;
  }

  function renderFloorTimeline(timeline, floor) {
    timeline.input.value = String(floor);
    const label = `${floor} / ${timeline.lastFloor}`;
    timeline.label.textContent = label;
    timeline.input.setAttribute("aria-valuetext", label);
    timeline.element.style.setProperty("--betterld-floor-progress", timeline.lastFloor > 1 ? (floor - 1) / (timeline.lastFloor - 1) : 0);
  }

  function finishFloorJump(timeline, floor, error = "") {
    clearTimeout(timeline.timer);
    timeline.pending = null;
    timeline.input.disabled = timeline.lastFloor === 1;
    timeline.status.textContent = error;
    renderFloorTimeline(timeline, floor);
  }

  function syncFloorTimeline(topic, floor, active, timeoutMs) {
    const host = document.querySelector(".topic-timeline");
    const source = host?.querySelector(".timeline-scrollarea");
    const lastFloor = Number(topic.highest_post_number);
    if (!source || !Number.isInteger(lastFloor) || lastFloor < 1 || !Number.isInteger(floor) || floor < 1 || floor > lastFloor) {
      resetFloorTimeline();
      return;
    }
    if (floorTimeline?.source !== source || floorTimeline?.topicId !== String(topic.id) || !floorTimeline.element.isConnected) {
      resetFloorTimeline();
      const element = document.createElement("div");
      element.className = "betterld-floor-timeline";
      const input = document.createElement("input");
      input.type = "range";
      input.min = "1";
      input.step = "1";
      input.setAttribute("aria-label", "按实际楼号跳转");
      input.setAttribute("aria-orientation", "vertical");
      const label = document.createElement("output");
      label.className = "betterld-floor-timeline__label";
      const status = document.createElement("p");
      status.className = "betterld-floor-timeline__status";
      status.setAttribute("role", "status");
      element.append(input, label, status);
      source.after(element);
      host.classList.add("betterld-floor-timeline-active");
      const timeline = { host, source, element, input, label, status, topicId: String(topic.id), floor, lastFloor, editing: false, pending: null };
      floorTimeline = timeline;
      input.addEventListener("input", () => {
        timeline.editing = true;
        renderFloorTimeline(timeline, input.valueAsNumber);
      });
      const cancelPreview = () => {
        timeline.editing = false;
        if (!timeline.pending) renderFloorTimeline(timeline, timeline.floor);
      };
      input.addEventListener("pointercancel", cancelPreview);
      input.addEventListener("blur", cancelPreview);
      input.addEventListener("change", () => {
        const target = input.valueAsNumber;
        timeline.editing = false;
        timeline.status.textContent = "";
        if (target === timeline.floor && !timeline.active) return;
        const requestId = crypto.randomUUID();
        timeline.pending = { requestId, target };
        input.disabled = true;
        timeline.status.textContent = `正在前往 #${target}…`;
        timeline.timer = setTimeout(() => {
          if (floorTimeline === timeline && timeline.pending?.requestId === requestId) {
            finishFloorJump(timeline, timeline.floor, `#${target} 跳转未完成，请重试。`);
          }
        }, timeline.timeoutMs);
        if (timeline.active) {
          jumpReply(target, undefined, requestId);
        } else {
          try {
            Promise.resolve(discourseUrl.routeTo(`/t/topic/${timeline.topicId}/${target}`)).catch((error) => {
              if (floorTimeline === timeline && timeline.pending?.requestId === requestId) {
                finishFloorJump(timeline, timeline.floor, `楼层跳转失败：${error.message}`);
              }
            });
          } catch (error) {
            finishFloorJump(timeline, timeline.floor, `楼层跳转失败：${error.message}`);
          }
        }
      });
    }
    const timeline = floorTimeline;
    timeline.lastFloor = lastFloor;
    timeline.active = active;
    timeline.timeoutMs = timeoutMs;
    timeline.input.max = String(lastFloor);
    timeline.element.style.height = source.style.height;
    if (Number.isInteger(floor) && floor > 0 && floor <= lastFloor) timeline.floor = floor;
    if (!active && timeline.pending?.target === timeline.floor) finishFloorJump(timeline, timeline.floor);
    if (!timeline.editing && !timeline.pending) {
      timeline.input.disabled = lastFloor === 1;
      renderFloorTimeline(timeline, timeline.floor);
    }
  }

  document.addEventListener("betterld:timeline-reset", resetFloorTimeline);
  document.addEventListener("betterld:reply-jumped", (event) => {
    const { topicId, requestId, postNumber, error } = JSON.parse(event.detail);
    const timeline = floorTimeline;
    if (timeline?.topicId !== topicId || timeline.pending?.requestId !== requestId) return;
    if (!error) timeline.floor = postNumber;
    finishFloorJump(timeline, timeline.floor, error || "");
  });

  // 原站楼号链接继续使用路由；树模式下直接按实际楼号定位。
  const discourseUrl = window.require("discourse/lib/url").default;
  const routeTo = discourseUrl.routeTo;
  discourseUrl.routeTo = function (url, options) {
    const match = String(url).match(/^\/t\/(?:(\d+)|[^/]+\/(\d+))(?:\/(\d+))?\/?(?:[?#].*)?$/);
    if (replyTopicId && (match?.[1] || match?.[2]) === replyTopicId && document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')) {
      jumpReply(Number(match[3]) || 1);
      return;
    }
    return routeTo.call(this, url, options);
  };

  document.addEventListener("betterld:reply-sync", (event) => {
    const { topicId, postNumber, active, timeoutMs } = JSON.parse(event.detail);
    try {
      const { getOwnerWithFallback } = window.require("discourse/lib/get-owner");
      const owner = getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (!topicId || String(topic?.id) !== topicId) {
        replyTopicId = "";
        replySignature = "";
        resetFloorTimeline();
        return;
      }
      if (replyTopicId !== topicId) replySignature = "";
      replyTopicId = topicId;
      const stream = topic.postStream;
      const data = {
        topicId,
        stream: [...stream.stream],
        posts: stream.posts.map((post) => ({
          ...Object.fromEntries(postFields.map((key) => [key, post[key]])),
          boosts: post.boosts?.map((boost) => ({
            ...Object.fromEntries(boostFields.map((key) => [key, boost[key]])),
            user: Object.fromEntries(boostUserFields.map((key) => [key, boost.user?.[key]]))
          }))
        }))
      };
      const signature = JSON.stringify(data);
      if (signature !== replySignature) {
        replySignature = signature;
        document.dispatchEvent(new CustomEvent("betterld:reply-data", { detail: signature }));
      }
      syncFloorTimeline(topic, Number(active ? postNumber : controller.currentPostNumber), active, timeoutMs);
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:reply-data", {
        detail: JSON.stringify({ topicId, error: error.message || "原站回复同步失败" })
      }));
    }
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('.topic-timeline :is(.start-date, .now-date)');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || !document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    jumpReply(Number(link.pathname.split('/').pop()));
  }, true);

  document.addEventListener("betterld:reply-compose", async (event) => {
    const { id, topicId, postId } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (String(topic?.id) !== topicId) throw new Error("主题已切换，请在当前主题重新回复");
      if (!topic.details.can_create_post) throw new Error("当前主题不允许回复");
      const post = topic.postStream.findLoadedPost(postId) || await owner.lookup("service:store").find("post", postId);
      if (String(controller.model?.id) !== topicId) throw new Error("主题已切换，请在当前主题重新回复");
      if (Number(post.topic_id) !== Number(topicId)) throw new Error("回复目标不属于当前主题");
      post.set("topic", topic);
      await controller.replyToPost(post);
      document.dispatchEvent(new CustomEvent("betterld:reply-composed", { detail: JSON.stringify({ id }) }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:reply-composed", {
        detail: JSON.stringify({ id, error: error.message || "原站回复编辑器打开失败" })
      }));
    }
  });

  // Boost 用原站自己的创建流程：它负责乐观写入模型、CSRF 与错误弹窗，模型随后回到同一条同步路径。
  document.addEventListener("betterld:reply-boost", async (event) => {
    const { id, topicId, postId, raw } = JSON.parse(event.detail);
    let boost = null;
    let error = "";
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (String(topic?.id) !== topicId) throw new Error("主题已切换，请在当前主题重新 Boost");
      const currentUser = owner.lookup("service:current-user");
      if (!currentUser) throw new Error("请登录后使用 Boost");
      const post = topic.postStream.findLoadedPost(postId) || await owner.lookup("service:store").find("post", postId);
      if (!post) throw new Error("目标楼层尚未载入，请重试");
      if (post.can_boost === false) throw new Error("这层已经 Boost 过了");
      post.set("topic", topic);
      // 插件模块不在核心模块命名空间，直接走原站的 ajax（带 CSRF）调同一接口，并按插件自己的方式写回模型。
      const { ajax } = window.require("discourse/lib/ajax");
      const created = await ajax(`/discourse-boosts/posts/${post.id}/boosts`, { type: "POST", data: { raw } });
      if (!created?.id) throw new Error("原站没有返回这条 Boost");
      // 原站的 boost_added 实时回调也会写模型，所以按插件自己的去重规则（id 或同一用户）合并，不盲目追加。
      const boosts = post.boosts || [];
      const existing = boosts.some((boost) => boost.id === created.id || boost.user?.id === created.user?.id);
      post.set("boosts", existing
        ? boosts.map((boost) => (boost.id === created.id || boost.user?.id === created.user?.id ? created : boost))
        : [...boosts, created]);
      post.set("can_boost", false);
      boost = {
        id: created.id,
        cooked: created.cooked,
        can_delete: created.can_delete,
        can_flag: created.can_flag,
        user: Object.fromEntries(boostUserFields.map((key) => [key, created.user?.[key]]))
      };
    } catch (e) {
      error = e.message || "Boost 提交失败";
    }
    document.dispatchEvent(new CustomEvent("betterld:reply-boosted", {
      detail: JSON.stringify({ id, error, boost })
    }));
  });

  // 当前列表路由的主题数据就在站点自己的模型里（服务端预载、无限滚动、客户端路由取回的都在），
  // 投影成列表接口的载荷形状，交给内容脚本用同一套映射取值，不再向站点重新请求一遍。
  function isoOrEmpty(value) {
    if (!value) return "";
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    return typeof value === "string" ? value : "";
  }

  // 原站模型里没有的字段一律留空，消费端按缺字段处理，不写占位假值。
  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function stringOrEmpty(value) {
    return typeof value === "string" ? value : "";
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function currentTopicListPayload() {
    const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
    const name = owner.lookup("service:router")?.currentRouteName;
    const model = name ? owner.lookup(`route:${name}`)?.currentModel : null;
    const list = model?.list ?? model;
    const topics = Array.isArray(list?.topics) ? list.topics
      : Array.isArray(list?.topic_list?.topics) ? list.topic_list.topics : null;
    if (!topics?.length) return null;
    const users = Array.isArray(list?.users) ? list.users
      : Array.isArray(model?.users) ? model.users : [];
    return {
      // 参与者头像要原样的 avatar_template（含 {size} 占位），消费端自己替换尺寸并校验同源。
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        avatar_template: stringOrEmpty(user.avatar_template ?? user.avatarTemplate)
      })),
      topic_list: {
        topics: topics.map((topic) => ({
          id: String(topic.id),
          creator: topic.creator?.username || "",
          creator_avatar_template: stringOrEmpty(topic.creator?.avatar_template ?? topic.creator?.avatarTemplate),
          excerpt: stringOrEmpty(topic.excerpt),
          posters: arrayOrEmpty(topic.posters).map((poster) => ({
            user_id: poster.user_id ?? poster.userId,
            description: stringOrEmpty(poster.description)
          })),
          posts_count: numberOrNull(topic.posts_count ?? topic.postsCount),
          reply_count: numberOrNull(topic.reply_count ?? topic.replyCount),
          like_count: numberOrNull(topic.like_count ?? topic.likeCount),
          views: numberOrNull(topic.views),
          image_url: stringOrEmpty(topic.image_url ?? topic.imageUrl),
          thumbnails: arrayOrEmpty(topic.thumbnails),
          tags: arrayOrEmpty(topic.tags).filter((tag) => typeof tag === "string"),
          last_posted_at: isoOrEmpty(topic.last_posted_at ?? topic.lastPostedAt),
          bumped_at: isoOrEmpty(topic.bumped_at ?? topic.bumpedAt),
          created_at: isoOrEmpty(topic.created_at ?? topic.createdAt)
        }))
      }
    };
  }

  document.addEventListener("betterld:topic-list-request", (event) => {
    const { id } = JSON.parse(event.detail);
    let payload = null;
    try {
      payload = currentTopicListPayload();
    } catch (error) {
      console.error("[betterLD] 原站主题列表读取失败", error);
    }
    document.dispatchEvent(new CustomEvent("betterld:topic-list", {
      detail: JSON.stringify({ id, payload })
    }));
  });

  document.addEventListener("betterld:refresh", async (event) => {
    const { id, href } = JSON.parse(event.detail);
    try {
      if (href !== location.href) throw new Error("页面已切换，请在当前页面重新刷新");
      if (pending && pendingHref !== href) throw new Error("上一页面仍在刷新，请稍后再试");
      if (!pending) {
        pendingHref = href;
        pending = (async () => {
          const { getOwnerWithFallback } = window.require("discourse/lib/get-owner");
          const owner = getOwnerWithFallback();
          const router = owner.lookup("service:router");
          if (router.currentRouteName.startsWith("topic.")) {
            const controller = owner.lookup("controller:topic");
            await controller.model.postStream.refresh({
              nearPost: controller.currentPostNumber || 1,
              forceLoad: true,
              refreshInPlace: true
            });
          } else {
            await router.refresh();
          }
        })().finally(() => { pending = null; });
      }
      await pending;
      document.dispatchEvent(new CustomEvent("betterld:refreshed", {
        detail: JSON.stringify({ id, href })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:refreshed", {
        detail: JSON.stringify({
          id, href,
          error: error.message || "原站局部刷新失败",
          status: error.status || error.jqXHR?.status,
          retryAfter: error.getResponseHeader?.("Retry-After") || error.jqXHR?.getResponseHeader("Retry-After")
        })
      }));
    }
  });
  // 原站把 highlight.js 打在 Discourse bundle 里，页面全局没有 hljs，只能走模块加载器。
  // 上下文传过来的代码块带 data-betterld-highlight-pending，逐个着色后由本函数移除。
  let highlightJsInstance = null;

  async function resolveHighlightJs() {
    if (highlightJsInstance) return highlightJsInstance;
    if (typeof window.require !== "function") return null;
    const mod = window.require("discourse/lib/highlight-syntax");
    const ensure = mod?.ensureHighlightJs || mod?.default?.ensureHighlightJs;
    if (typeof ensure !== "function") return null;
    const instance = await ensure.call(mod.default ?? mod);
    const hljs = instance?.default ?? instance;
    if (hljs && typeof hljs.highlightElement === "function") highlightJsInstance = hljs;
    return highlightJsInstance;
  }

  document.addEventListener("betterld:highlight-code", async (event) => {
    const { id } = JSON.parse(event.detail);
    const pending = [...document.querySelectorAll("[data-betterld-highlight-pending]")];
    let error = "";
    try {
      const hljs = await resolveHighlightJs();
      if (!hljs) throw new Error("原站 highlight.js 不可用");
      pending.forEach((code) => {
        // hljs 见到 data-highlighted 会直接跳过，先摘掉再着色，最后保证标记仍在。
        code.removeAttribute("data-highlighted");
        try {
          hljs.highlightElement(code);
        } catch (failure) {
          console.warn("[betterLD] 代码块高亮失败", failure);
        }
        if (code.getAttribute("data-highlighted") !== "yes") code.setAttribute("data-highlighted", "yes");
      });
    } catch (failure) {
      error = failure?.message || "代码高亮失败";
      console.warn("[betterLD] 代码高亮失败", failure);
    }
    pending.forEach((code) => code.removeAttribute("data-betterld-highlight-pending"));
    document.dispatchEvent(new CustomEvent("betterld:highlighted", {
      detail: JSON.stringify({ id, count: pending.length, error })
    }));
  });
})();
