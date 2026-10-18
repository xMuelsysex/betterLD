(() => {
  "use strict";

  // 仅在页面上下文调用原站模型：原站的 MessageBus 和分页仍由 Discourse 管理，
  // 列表主题与主题回复都直接读 Discourse 自己已经下载好的模型，避免同一份数据再请求一遍。
  let pending = null;
  let pendingHref = "";
  let replyTopicId = "";
  let replySignature = "";
  const replyPostSnapshots = new Map();
  let floorTimeline = null;
  const replyAuthors = new Map();
  const postFields = ["id", "post_number", "reply_to_post_number", "user_id", "username", "name", "avatar_template", "user_title", "title_is_group", "primary_group_name", "flair_name", "flair_url", "flair_bg_color", "flair_color", "flair_group_id", "admin", "moderator", "trust_level", "created_at", "updated_at", "cooked", "post_url", "can_boost", "can_accept_answer", "accepted_answer", "topic_accepted_answer", "reactions", "reaction_users_count", "current_user_reaction", "actions_summary", "polls", "polls_votes", "link_counts", "post_type", "action_code", "action_code_who", "action_code_path", "reply_count", "hidden", "cooked_hidden", "can_see_hidden_post", "deleted_post_placeholder", "deleted_by", "read", "deleted_at", "user_deleted", "can_edit", "can_delete", "can_recover", "can_permanently_delete", "can_wiki", "wiki", "locked", "bookmarked", "bookmark_id", "bookmark_name", "bookmark_reminder_at", "bookmark_auto_delete_preference", "reviewable_id", "reviewable_score_count", "reviewable_score_pending_count", "can_localize_post", "can_localize_topic", "can_localize_content", "post_localizations_count", "language", "locale", "is_localized", "can_assign", "assigned_to_user", "assigned_to_group", "assignment_status", "assignment_note"];
  const boostFields = ["id", "cooked", "can_delete", "can_flag", "available_flags", "user_flag_status"];
  const boostUserFields = ["id", "username", "name", "avatar_template"];

  // 树内的正文、操作、回复与 Boost 共用原站 identityMap：树已登记而原站尚未载入的楼层在这里创建并 storePost，
  // 之后一律用 findLoadedPost 取同一模型，既不重复 HTTP find，也不让旧载荷新建一份覆盖新模型。
  const treeRegisteredPostIds = new Set();
  const treeRevealedIgnoredIds = new Set();
  let treeRegisteredTopicId = '';

  function treePostAttributes(topic, data) {
    // 桥接投影包含 getter-only 权限值；模型只接收帖子字段，权限由原站自行计算。
    return {
      ...Object.fromEntries([...postFields, "boosts"].filter((key) => key in data).map((key) => [key, data[key]])),
      topic_id: topic.id,
      topic
    };
  }

  function createTreePost(owner, topic, data) {
    const post = topic.postStream.storePost(owner.lookup("service:store").createRecord("post", treePostAttributes(topic, data)));
    treeRegisteredPostIds.add(String(post.id));
    return post;
  }

  function registerTreePosts(owner, topic, posts) {
    if (treeRegisteredTopicId !== String(topic.id)) {
      treeRegisteredTopicId = String(topic.id);
      treeRegisteredPostIds.clear();
      treeRevealedIgnoredIds.clear();
    }
    for (const data of posts || []) {
      if (!Number.isInteger(data?.id) || !Number.isInteger(data.post_number) || (data.topic_id !== undefined && String(data.topic_id) !== String(topic.id))) throw new Error('楼层身份与当前主题不匹配');
      treeRegisteredPostIds.add(String(data.id));
      if (!topic.postStream.findLoadedPost(data.id)) createTreePost(owner, topic, data);
    }
  }

  // 嵌入的 Boost 正文不是帖子，保持独立模型，不登记进 identityMap。
  // ownsPost 只表示组件自己创建、必须自己销毁的模型：已登记进 identityMap 的楼层由原站管理，释放时不销毁。
  function createEmbeddedTreePost(owner, topic, data) {
    return { post: owner.factoryFor("model:post").create(treePostAttributes(topic, data)), ownsPost: true };
  }

  // 普通楼层只按 postId 取已登记的原站模型：树注册阶段已经建好，这里缺失就是挂载协议被破坏，明确报错。
  function resolveTreePost(topic, postId) {
    const loaded = topic.postStream.findLoadedPost(postId);
    if (!loaded) throw new Error(`楼层 #${postId} 尚未登记进原站模型`);
    treeRegisteredPostIds.add(String(postId));
    return { post: loaded, ownsPost: false };
  }

  // 权限与忽略列表只来自原站模型：桥一次投影给内容脚本，内容脚本不自己推断登录与发帖权限。
  function replyTreeContext(owner, topic) {
    const currentUser = owner.lookup("service:current-user");
    return {
      currentUserId: currentUser?.id ?? null,
      canCreatePost: Boolean(topic.details?.can_create_post),
      hasAcceptedAnswers: Boolean(topic.accepted_answers?.length),
      ignoredUsernames: [...(currentUser?.ignored_users || [])],
      revealedIgnoredIds: [...treeRevealedIgnoredIds]
    };
  }

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

  function renderFloorTotal(timeline) {
    const total = `/ ${timeline.lastFloor}`;
    if (timeline.total.textContent !== total) timeline.total.textContent = total;
    timeline.numberInput.size = Math.max(String(timeline.lastFloor).length, timeline.numberInput.value.length);
  }

  function floorAtTimelinePosition(timeline) {
    // 区间边界归较小楼号；位置保持连续，整数楼号只用于预览和提交。
    return Math.max(1, Math.ceil(timeline.input.valueAsNumber * timeline.lastFloor));
  }

  function floorTimelineDate(timeline, floor, position) {
    const stream = timeline.topic.postStream;
    // loadedPosts覆盖原帖分页和树已登记的identityMap模型，翻页后仍读同一楼层身份。
    const post = stream.loadedPosts.find((entry) => entry.post_number === floor);
    let date = post?.created_at ? new Date(post.created_at) : null;
    if (!date) {
      // 原站日期表按当前流的轨道进度编码，不是实际楼号；删楼不应使整段预览消失。
      const total = stream.filteredPostsCount;
      const index = Math.max(1, Math.min(total, Math.floor(total * position) + 1));
      const daysAgo = stream.closestDaysAgoFor(index);
      if (typeof daysAgo === "number" && Number.isFinite(daysAgo) && daysAgo >= 0) {
        date = new Date();
        date.setDate(date.getDate() - daysAgo);
      }
    }
    timeline.date.title = date ? (post?.created_at ? "楼层发布时间" : "原站时间轴进度分组日期，非该楼精确发布时间") : "";
    if (!date) return "";
    return window.require("discourse/components/topic-timeline/container").timelineDate(date);
  }

  function renderFloorTimeline(timeline, floor, position = timeline.lastFloor > 1 ? (floor - 1) / (timeline.lastFloor - 1) : 0) {
    const value = String(floor);
    if (timeline.input.valueAsNumber !== position) timeline.input.value = String(position);
    // 聚焦编辑或保留非法输入时不重写楼号输入，避免吞掉用户键入的内容。
    if (!timeline.numberEditing && !timeline.numberDirty && !timeline.numberError && timeline.numberInput.value !== value) timeline.numberInput.value = value;
    renderFloorTotal(timeline);
    if (timeline.current.textContent !== value) timeline.current.textContent = value;
    const label = `${floor} / ${timeline.lastFloor}`;
    if (timeline.input.getAttribute("aria-valuetext") !== label) timeline.input.setAttribute("aria-valuetext", label);
    timeline.input.setAttribute("aria-valuenow", value);
    const date = floorTimelineDate(timeline, floor, position);
    if (timeline.date.textContent !== date) timeline.date.textContent = date;
    timeline.date.hidden = !date;
    const progress = String(position);
    if (timeline.element.style.getPropertyValue("--betterld-floor-progress") !== progress) timeline.element.style.setProperty("--betterld-floor-progress", progress);
  }

  function armFloorJumpTimeout(timeline, delay) {
    clearTimeout(timeline.timer);
    const { requestId, target } = timeline.pending;
    timeline.timer = setTimeout(() => {
      if (floorTimeline === timeline && timeline.pending?.requestId === requestId) {
        finishFloorJump(timeline, timeline.floor, `#${target} 跳转未完成，请重试。`);
      }
    }, delay);
  }

  // 只接受 trim 后的纯 ASCII 数字楼号：非法输入不夹取、不兜底，交回用户重新输入。
  function parseFloorInput(value, lastFloor) {
    const text = value.trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const floor = Number(text);
    return Number.isSafeInteger(floor) && floor >= 1 && floor <= lastFloor ? floor : null;
  }

  function clearFloorNumberError(timeline) {
    if (timeline.numberError && timeline.status.textContent === timeline.numberError) timeline.status.textContent = "";
    timeline.numberError = "";
    timeline.numberInput.removeAttribute("aria-invalid");
  }

  function closeFloorNumberEditor(timeline) {
    timeline.numberInput.hidden = true;
    timeline.current.hidden = false;
    timeline.numberEditing = false;
    timeline.numberDirty = false;
  }

  function requestFloorJump(timeline, target) {
    if (timeline.pending) return;
    clearFloorNumberError(timeline);
    timeline.editing = false;
    timeline.numberDirty = false;
    timeline.status.textContent = "";
    if (target === timeline.floor && !timeline.active) {
      closeFloorNumberEditor(timeline);
      renderFloorTimeline(timeline, timeline.floor);
      return;
    }
    const requestId = crypto.randomUUID();
    timeline.pending = { requestId, target };
    timeline.input.disabled = true;
    timeline.numberInput.disabled = true;
    timeline.current.disabled = true;
    timeline.status.textContent = `正在前往 #${target}…`;
    armFloorJumpTimeout(timeline, timeline.timeoutMs);
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
  }

  function finishFloorJump(timeline, floor, error = "") {
    clearTimeout(timeline.timer);
    timeline.pending = null;
    timeline.input.disabled = timeline.lastFloor === 1;
    timeline.numberInput.disabled = false;
    timeline.current.disabled = false;
    closeFloorNumberEditor(timeline);
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
      element.dataset.betterldOwned = "true";
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "any";
      input.setAttribute("aria-label", "按实际楼号跳转");
      input.setAttribute("aria-orientation", "vertical");
      input.setAttribute("aria-valuemin", "1");
      const status = document.createElement("p");
      status.className = "betterld-floor-timeline__status";
      status.setAttribute("role", "status");
      const form = document.createElement("form");
      form.className = "betterld-floor-timeline__label";
      const current = document.createElement("button");
      current.type = "button";
      current.className = "betterld-floor-timeline__current";
      current.setAttribute("aria-label", "编辑当前楼号，Enter 跳转，Escape 取消");
      const numberInput = document.createElement("input");
      numberInput.type = "text";
      numberInput.className = "betterld-floor-timeline__number";
      numberInput.setAttribute("inputmode", "numeric");
      numberInput.setAttribute("aria-label", "楼号，Enter 跳转，Escape 取消");
      numberInput.hidden = true;
      const total = document.createElement("span");
      total.className = "betterld-floor-timeline__total";
      const counter = document.createElement("div");
      counter.className = "betterld-floor-timeline__counter";
      counter.append(current, numberInput, total);
      const date = document.createElement("span");
      date.className = "betterld-floor-timeline__date timeline-ago";
      form.append(counter, date);
      element.append(input, form, status);
      source.after(element);
      host.classList.add("betterld-floor-timeline-active");
      const timeline = { host, source, element, input, current, date, status, numberInput, total, topicId: String(topic.id), floor, lastFloor, editing: false, numberEditing: false, numberDirty: false, numberError: "", pending: null };
      floorTimeline = timeline;
      input.addEventListener("input", () => {
        timeline.editing = true;
        renderFloorTimeline(timeline, floorAtTimelinePosition(timeline), input.valueAsNumber);
      });
      // step=any只负责指针连续位置；键盘仍以实际楼号逐楼定位。
      input.addEventListener("keydown", (event) => {
        const target = {
          ArrowUp: Math.max(1, timeline.floor - 1),
          ArrowLeft: Math.max(1, timeline.floor - 1),
          ArrowDown: Math.min(timeline.lastFloor, timeline.floor + 1),
          ArrowRight: Math.min(timeline.lastFloor, timeline.floor + 1),
          PageUp: Math.max(1, timeline.floor - 1),
          PageDown: Math.min(timeline.lastFloor, timeline.floor + 1),
          Home: 1,
          End: timeline.lastFloor
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        requestFloorJump(timeline, target);
      });
      const cancelPreview = () => {
        timeline.editing = false;
        if (!timeline.pending) renderFloorTimeline(timeline, timeline.floor);
      };
      input.addEventListener("pointercancel", cancelPreview);
      input.addEventListener("blur", cancelPreview);
      input.addEventListener("change", () => requestFloorJump(timeline, floorAtTimelinePosition(timeline)));
      current.addEventListener("click", () => {
        current.hidden = true;
        numberInput.hidden = false;
        numberInput.focus();
        numberInput.select();
      });
      numberInput.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        clearFloorNumberError(timeline);
        closeFloorNumberEditor(timeline);
        renderFloorTimeline(timeline, timeline.floor);
        current.focus();
      });
      // 聚焦编辑期间同步不重写输入；失焦只结束编辑，不触发跳转。
      numberInput.addEventListener("focus", () => { timeline.numberEditing = true; });
      numberInput.addEventListener("blur", () => { timeline.numberEditing = false; });
      numberInput.addEventListener("input", () => {
        timeline.numberDirty = true;
        renderFloorTotal(timeline);
        clearFloorNumberError(timeline);
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (timeline.pending) return;
        const target = parseFloorInput(numberInput.value, timeline.lastFloor);
        if (target === null) {
          const message = `请输入 1–${timeline.lastFloor} 的整数楼号`;
          timeline.numberError = message;
          timeline.status.textContent = message;
          numberInput.setAttribute("aria-invalid", "true");
          return;
        }
        requestFloorJump(timeline, target);
      });
    }
    const timeline = floorTimeline;
    timeline.topic = topic;
    timeline.lastFloor = lastFloor;
    renderFloorTotal(timeline);
    timeline.input.setAttribute("aria-valuemax", String(lastFloor));
    timeline.active = active;
    timeline.timeoutMs = timeoutMs;
    if (timeline.element.style.getPropertyValue("--betterld-floor-track-height") !== source.style.height) timeline.element.style.setProperty("--betterld-floor-track-height", source.style.height);
    if (Number.isInteger(floor) && floor > 0 && floor <= lastFloor) timeline.floor = floor;
    if (!active && timeline.pending?.target === timeline.floor) finishFloorJump(timeline, timeline.floor);
    if (!timeline.editing && !timeline.pending) {
      if (timeline.input.disabled !== (lastFloor === 1)) timeline.input.disabled = lastFloor === 1;
      renderFloorTimeline(timeline, timeline.floor);
    } else if (timeline.editing && !timeline.pending) {
      // 模型晚到时刷新当前拖动楼层的日期，保持指针位置和待选楼号。
      renderFloorTimeline(timeline, floorAtTimelinePosition(timeline), timeline.input.valueAsNumber);
    }
  }

  document.addEventListener("betterld:timeline-reset", resetFloorTimeline);
  document.addEventListener("betterld:reply-jump-wait", (event) => {
    const { topicId, requestId, until, message } = JSON.parse(event.detail);
    const timeline = floorTimeline;
    if (timeline?.topicId !== topicId || timeline.pending?.requestId !== requestId) return;
    timeline.status.textContent = message;
    armFloorJumpTimeout(timeline, Math.max(0, until - Date.now()) + timeline.timeoutMs);
  });
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

  function replyAuthorError(topicId, error) {
    console.error("[betterLD] 作者附加信息渲染失败", error);
    document.dispatchEvent(new CustomEvent("betterld:reply-data", {
      detail: JSON.stringify({ topicId, error: `作者附加信息渲染失败：${error.message}` })
    }));
  }

  function resetReplyAuthors(postIds) {
    const ids = postIds || [...replyAuthors.keys()];
    for (const id of ids) {
      const entry = replyAuthors.get(id);
      if (!entry) continue;
      entry.user.off("status-changed", entry, entry.onStatus);
      if (entry.tracking) entry.user.statusManager.stopTrackingStatus();
      for (const view of entry.views) view.message?.destroy();
      if (entry.ownsUser) entry.user.destroy();
      replyAuthors.delete(id);
    }
    // 只有换树/离开话题才清同步签名；原位更新单楼不制造额外回流。
    if (!postIds) {
      replySignature = "";
      replyPostSnapshots.clear();
    }
  }

  document.addEventListener("betterld:reply-author-reset", (event) => {
    resetReplyAuthors(event.detail ? JSON.parse(event.detail).postIds : undefined);
  });

  function renderReplyAuthorStatus(entry, view) {
    view.message?.destroy();
    view.message = null;
    view.statusHost?.remove();
    view.statusHost = null;
    const status = entry.user.status;
    if (!entry.owner.lookup("service:site-settings").enable_emoji || !status?.emoji
      || (status.ends_at && Date.parse(status.ends_at) <= Date.now())) return;
    const { UserStatusMessage } = window.require("discourse/lib/user-status-message");
    const message = new UserStatusMessage(entry.owner, status);
    view.message = message;
    message.html.classList.add("fk-d-tooltip__trigger");
    message.html.dataset.identifier = "user-status-message-tooltip";
    message.html.dataset.trigger = "";
    message.html.id = message.tooltipInstance.id;
    message.html.setAttribute("role", "button");
    message.html.tabIndex = 0;
    message.html.setAttribute("aria-label", status.description || status.emoji);
    message.html.setAttribute("aria-expanded", "false");
    message.tooltipInstance.options.onShow = () => {
      message.html.classList.add("-expanded");
      message.html.setAttribute("aria-expanded", "true");
    };
    message.tooltipInstance.options.onClose = () => {
      message.html.classList.remove("-expanded");
      message.html.setAttribute("aria-expanded", "false");
    };
    const trigger = document.createElement("span");
    trigger.className = "fk-d-tooltip__trigger-container";
    trigger.append(...message.html.childNodes);
    message.html.append(trigger);
    message.html.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      message.tooltipInstance.onClick(event).catch((error) => replyAuthorError(entry.topicId, error));
    });
    // 原站公开的命令式组件与 Glimmer 组件共用 FloatKit，补齐后者的说明布局。
    const until = message.content.querySelector(".user-status-tooltip-until");
    if (until) {
      const inlineUntil = document.createElement("span");
      inlineUntil.className = until.className;
      inlineUntil.textContent = until.textContent;
      until.replaceWith(inlineUntil);
    }
    const wrapper = document.createElement("div");
    wrapper.className = "user-status-tooltip-wrapper";
    wrapper.append(...message.content.querySelectorAll(".user-status-tooltip-description, .user-status-tooltip-until"));
    message.content.append(wrapper);
    // 命令式 API 多一层宿主，展平后沿用原站 inner-content 的间距，避免叠加 padding。
    message.content.style.display = "contents";
    const host = document.createElement("span");
    host.className = "user-status-message-wrap betterld-reply-tree__user-status";
    host.append(message.html);
    view.statusHost = host;
    view.author.append(host);
  }

  function trackReplyAuthor(owner, post, liveUser, topicId) {
    const existing = replyAuthors.get(post.id);
    if (existing) return existing;
    const User = window.require("discourse/models/user").default;
    const user = liveUser || User.create({
      id: post.user_id, username: post.username, name: post.name,
      status: post.user_status ?? null, title: post.user_title,
      primary_group_name: post.primary_group_name,
      admin: post.admin, moderator: post.moderator, trust_level: post.trust_level,
      flair_name: post.flair_name, flair_url: post.flair_url,
      flair_bg_color: post.flair_bg_color, flair_color: post.flair_color,
      flair_group_id: post.flair_group_id, avatar_template: post.avatar_template
    });
    const entry = { owner, topicId, user, ownsUser: !liveUser, tracking: owner.lookup("service:user-status").isEnabled, views: [], onStatus() {
      try {
        for (const view of this.views) renderReplyAuthorStatus(this, view);
        document.dispatchEvent(new CustomEvent("betterld:reply-author-status", {
          detail: JSON.stringify({ topicId, postId: post.id, status: user.status ?? null })
        }));
      } catch (error) {
        replyAuthorError(topicId, error);
      }
    } };
    // 原帖每楼各持一个 User；按楼复用，避免同作者的不同头衔/群组快照互相覆盖。
    replyAuthors.set(post.id, entry);
    user.on("status-changed", entry, entry.onStatus);
    if (entry.tracking) user.statusManager.trackStatus();
    entry.onStatus();
    return entry;
  }

  function renderReplyAuthorTitle(author, post, user) {
    const { applyValueTransformer } = window.require("discourse/lib/transformer");
    const title = applyValueTransformer("poster-name-user-title", user.title, { post, user });
    if (!title) return;
    const host = document.createElement("span");
    host.className = "user-title betterld-reply-tree__user-title";
    host.classList.add(`user-title--${title.replace(/\s+/g, "-").toLowerCase()}`);
    if (post.title_is_group && user.primary_group_name) {
      host.classList.add(`user-title--${user.primary_group_name.replace(/\s+/g, "-").toLowerCase()}`);
      const link = document.createElement("a");
      link.className = "user-group trigger-group-card";
      link.dataset.groupCard = user.primary_group_name;
      link.href = window.require("discourse/lib/get-url").default(`/g/${encodeURIComponent(user.primary_group_name)}`);
      link.textContent = title;
      host.append(link);
    } else host.textContent = title;
    author.append(host);
  }

  function replyPosterBadgeSettings() {
    const moduleName = Object.keys(window.require.entries).find((name) =>
      name.endsWith("/discourse/initializers/initialize-discourse-post-badges"));
    if (!moduleName) return null;
    const themeId = Number(moduleName.match(/\/theme-(\d+)\//)[1]);
    return window.require("discourse/lib/theme-settings-store").getObjectForTheme(themeId);
  }

  function renderReplyPosterBadges(author, post, settings) {
    if (!settings || !post.user_badges?.length) return;
    const order = settings.badges.split("|").filter(Boolean).map((name) => name.toLowerCase());
    const badges = post.user_badges.filter((badge) => order.includes(badge.name.toLowerCase()))
      .sort((a, b) => order.indexOf(a.name.toLowerCase()) - order.indexOf(b.name.toLowerCase()));
    const highestTrustBadge = Math.max(0, ...post.user_badges.filter((badge) => badge.badge_grouping_id === 4).map((badge) => badge.id));
    const { iconHTML } = window.require("discourse/lib/icon-library");
    const getURL = window.require("discourse/lib/get-url").default;
    const group = document.createElement("span");
    group.className = "poster-icon-container betterld-reply-tree__poster-badges";
    for (const badge of badges) {
      if (settings.only_show_highest_trust_level && badge.id >= 1 && badge.id <= 4 && badge.id !== highestTrustBadge) continue;
      const host = document.createElement("span");
      host.className = `poster-icon badge-type-${["gold", "silver", "bronze"][badge.badge_type_id - 1]}`;
      host.title = badge.description;
      const link = document.createElement("a");
      const username = settings.badge_link_destination === "user's badge page" ? `?username=${encodeURIComponent(post.username)}` : "";
      link.href = getURL(`/badges/${badge.id}/${encodeURIComponent(badge.slug)}${username}`);
      link.setAttribute("aria-label", `${badge.name}：${badge.description}`);
      const image = badge.image_url || badge.image;
      if (image) {
        const icon = document.createElement("img");
        icon.src = image;
        icon.alt = "";
        link.append(icon);
      } else {
        const template = document.createElement("template");
        template.innerHTML = iconHTML(badge.icon.replace("fa-", ""));
        link.append(template.content);
      }
      host.append(link);
      group.append(host);
    }
    if (group.childElementCount) author.append(group);
  }

  // 分页作者复用原站已有模型能力，不加入 postStream 或补发逐用户请求。
  function enhanceReplyAuthors(topicId) {
    const pending = document.querySelectorAll(".betterld-reply-tree__avatar-wrap[data-betterld-author-details]");
    if (!pending.length) return;
    const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
    const topic = owner.lookup("controller:topic").model;
    if (String(topic.id) !== topicId) return;
    const site = owner.lookup("service:site");
    const statusEnabled = owner.lookup("service:user-status").isEnabled;
    const posterBadgeSettings = replyPosterBadgeSettings();
    const livePosts = new Map(topic.postStream.posts.map((post) => [post.id, post]));
    const autoGroupFlairForUser = window.require("discourse/lib/avatar-flair").default;
    const { convertIconClass, iconHTML } = window.require("discourse/lib/icon-library");
    for (const host of pending) {
      const post = JSON.parse(host.dataset.betterldAuthorDetails);
      delete host.dataset.betterldAuthorDetails;
      const livePost = livePosts.get(post.id);
      const entry = trackReplyAuthor(owner, post, livePost?.user, topicId);
      const user = entry.user;
      const flair = !user.flair_group_id ? null : user.flair_url || user.flair_bg_color ? user : autoGroupFlairForUser(site, user);
      if (flair) {
        const badge = document.createElement("div");
        badge.className = "avatar-flair";
        if (flair.flair_name) {
          badge.classList.add(`avatar-flair-${flair.flair_name}`);
          badge.title = flair.flair_name;
          badge.setAttribute("aria-label", flair.flair_name);
          badge.setAttribute("role", "img");
        }
        if (flair.flair_bg_color) {
          badge.classList.add("rounded");
          badge.style.backgroundColor = `#${flair.flair_bg_color}`;
        }
        if (flair.flair_color) badge.style.color = `#${flair.flair_color}`;
        if (flair.flair_url && !flair.flair_url.includes("/")) {
          const template = document.createElement("template");
          template.innerHTML = iconHTML(convertIconClass(flair.flair_url));
          badge.append(template.content);
        } else {
          badge.classList.add("avatar-flair-image");
          if (flair.flair_url) badge.style.backgroundImage = `url(${JSON.stringify(flair.flair_url)})`;
        }
        host.append(badge);
      }
      const author = host.closest(".betterld-reply-tree__card").querySelector(".betterld-reply-tree__author");
      renderReplyAuthorTitle(author, livePost || post, user);
      if (statusEnabled) {
        const view = { author, message: null, statusHost: null };
        entry.views.push(view);
        renderReplyAuthorStatus(entry, view);
      }
      renderReplyPosterBadges(author, post, posterBadgeSettings);
    }
  }

  document.addEventListener("betterld:reply-author-details", (event) => {
    const { topicId } = JSON.parse(event.detail);
    try {
      enhanceReplyAuthors(topicId);
    } catch (error) {
      replyAuthorError(topicId, error);
    }
  });

  // 原帖的正文组件承载站点全部插件装饰：惰性媒体、投票、图表、公式等。
  // 必须在 Ember runloop 内挂载；树节点移除后同时销毁宿主与装饰器。
  const cookedHosts = new Map();
  const postMenuHosts = new Map();
  let treePollSync = null;
  let treePollRevision = 0;

  function releaseTreePollSync() {
    if (!treePollSync) return;
    treePollSync.bus.unsubscribe(`/polls/${treePollSync.topicId}`, treePollSync.onMessage);
    treePollSync.appEvents.off('poll:voted', treePollSync.onVote);
    treePollSync = null;
  }

  function syncTreePolls(owner, topic) {
    if (treePollSync?.topicId === String(topic.id)) return;
    const revisions = new Map();
    releaseTreePollSync();
    const requestRefresh = (postId) => {
      if (!document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')) return;
      const mounted = [...cookedHosts.values()].some((entry) => entry.element.isConnected && entry.post.id === postId);
      if (mounted) document.dispatchEvent(new CustomEvent('betterld:reply-poll-refresh', {
        detail: JSON.stringify({ topicId: String(topic.id), postId, revision: revisions.get(postId) })
      }));
    };
    const onMessage = (message) => {
      const post = topic.postStream.findLoadedPost(message.post_id);
      revisions.set(message.post_id, ++treePollRevision);
      // on_vote 广播可能只带人数；原站回调先消费同一载荷，缺失票数也可能已被它补成 0。
      // 原生组件实际显示结果才补读，作者、管理员和关闭后可见等权限仍由它决定。
      if (post && message.polls.some((poll) => poll.voters > 0
        && ['regular', 'multiple', 'number'].includes(poll.type)
        && poll.options?.length && poll.options.every((option) => !option.votes)
        && [...cookedHosts.values()].some((entry) => entry.post === post && entry.element.isConnected
          && entry.element.querySelector(`[data-poll-name="${CSS.escape(poll.name)}"] [class*="-results"]`)))) requestRefresh(post.id);
    };
    const onVote = (poll, post) => {
      if (String(post.topic_id) !== String(topic.id)
        || !document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')) return;
      revisions.set(post.id, ++treePollRevision);
      // 投票/撤票响应是本次操作的权威结果；同步原始 polls 与 tracked pollsObject。
      post.polls = post.polls.map((entry) => entry.name === poll.name ? poll : entry);
    };
    const bus = owner.lookup('service:message-bus');
    const appEvents = owner.lookup('service:app-events');
    bus.subscribe(`/polls/${topic.id}`, onMessage);
    appEvents.on('poll:voted', onVote);
    treePollSync = { topicId: String(topic.id), bus, appEvents, onMessage, onVote, revisions };
  }

  document.addEventListener('betterld:reply-poll-data', (event) => {
    const { topicId, postId, polls, revision } = JSON.parse(event.detail);
    const topic = window.require('discourse/lib/get-owner').getOwnerWithFallback().lookup('controller:topic').model;
    if (String(topic?.id) !== topicId || treePollSync?.topicId !== topicId
      || treePollSync.revisions.get(postId) !== revision) return;
    const post = topic.postStream.findLoadedPost(postId);
    if (post) window.require('@ember/runloop').join(() => { post.polls = polls; });
  });
  document.addEventListener('betterld:reply-reading-release', releaseTreePollSync);
  window.addEventListener('pagehide', releaseTreePollSync);
  function releaseHostResources(entry, menu) {
    const errors = [];
    window.require("@ember/runloop").join(() => {
      const resources = entry.host ? [["host", () => entry.host.destroy()]] : [];
      if (menu && entry.bookmarkEvents) resources.push(["bookmark-events", () => entry.bookmarkEvents.off("bookmarks:changed", entry, entry.onBookmark)]);
      if (menu && entry.solvedEvents) resources.push(["solved-events", () => entry.solvedEvents.off("discourse-solved:solution-toggled", entry, entry.onSolved)]);
      if (menu && entry.behavior) resources.push(["behavior", () => window.require("@ember/destroyable").destroy(entry.behavior)]);
      if (entry.ownsPost) resources.push(["post", () => entry.post.destroy()]);
      for (const [key, release] of resources) {
        if (entry.released?.has(key)) continue;
        try {
          release();
          (entry.released ||= new Set()).add(key);
        } catch (error) {
          errors.push(error);
        }
      }
    });
    if (errors.length) throw new AggregateError(errors, "原站组件资源释放失败");
  }

  function releasePostMenu(entry) {
    releaseHostResources(entry, true);
  }

  function releaseCookedHost(entry) {
    releaseHostResources(entry, false);
  }

  function releaseDetachedHost(element, attribute, hosts, release) {
    const id = element.getAttribute(attribute);
    const entry = hosts.get(id);
    if (!entry || entry.element !== element || element.isConnected) return;
    try {
      release(entry);
      hosts.delete(id);
    } catch (error) {
      entry.releaseError = error;
      console.error(`[betterLD] ${attribute} ${id} cleanup failed`, error);
    }
  }

  document.addEventListener("betterld:host-cleanup", () => {
    if (document.hidden) return;
    for (const entry of postMenuHosts.values()) {
      if (entry.releaseError) releaseDetachedHost(entry.element, "data-betterld-menu-id", postMenuHosts, releasePostMenu);
    }
    for (const entry of cookedHosts.values()) {
      if (entry.releaseError) releaseDetachedHost(entry.element, "data-betterld-cooked-id", cookedHosts, releaseCookedHost);
    }
  });

  const cookedObserver = new MutationObserver((records) => {
    // 只处理真正移除的正文/菜单节点；正文装饰或无关页面变化无需扫描全部宿主。
    const selector = "[data-betterld-cooked-id], [data-betterld-menu-id]";
    const removed = new Set();
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector)) removed.add(node);
        node.querySelectorAll(selector).forEach((element) => removed.add(element));
      }
    }
    for (const element of removed) {
      if (element.hasAttribute("data-betterld-menu-id")) releaseDetachedHost(element, "data-betterld-menu-id", postMenuHosts, releasePostMenu);
      if (element.hasAttribute("data-betterld-cooked-id")) releaseDetachedHost(element, "data-betterld-cooked-id", cookedHosts, releaseCookedHost);
    }
  });
  cookedObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("betterld:reply-cooked-mount", (event) => {
    const { topicId, bodies } = JSON.parse(event.detail);
    const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
    const topic = owner.lookup("controller:topic")?.model;
    if (String(topic?.id) !== topicId) return;
    const Component = window.require("@ember/component");
    const NativeCooked = window.require("discourse/components/post/cooked-html").default;
    class Native extends NativeCooked {
      get isIgnored() {
        return !treeRevealedIgnoredIds.has(String(this.args.post.id)) && super.isIgnored;
      }
    }
    const Container = window.require("discourse/components/render-glimmer-container").default;
    const curry = window.require("ember-curry-component").default;
    const join = window.require("@ember/runloop").join;
    for (const body of bodies) {
      const element = document.querySelector(`[data-betterld-cooked-id="${CSS.escape(body.id)}"]`);
      if (!element) continue;
      const existing = cookedHosts.get(body.id);
      if (existing?.element === element) continue;
      let host;
      let post;
      let ownsPost = false;
      try {
        if (existing) {
          try {
            releaseCookedHost(existing);
            cookedHosts.delete(body.id);
          } catch (error) {
            existing.releaseError = error;
            throw error;
          }
        }
        // 正文统一走 identityMap：普通楼层按 postId 复用已登记的原站模型，嵌入的 Boost 正文保持自己的模型。
        const embedded = body.post;
        ({ post, ownsPost } = embedded ? createEmbeddedTreePost(owner, topic, embedded) : resolveTreePost(topic, body.postId));
        const smallAction = !embedded?.embeddedPost && post.post_type === 3;
        const NativeBody = smallAction ? window.require("discourse/components/post/small-action").default : Native;
        const controller = owner.lookup("controller:topic");
        const args = { post, streamElement: true, className: embedded?.embeddedPost ? "betterld-embedded-cooked" : "cooked",
          embeddedPost: embedded?.embeddedPost, selectionBarrier: Boolean(embedded?.embeddedPost) };
        if (smallAction) {
          args.editPost = () => controller.send("editPost", post);
          args.deletePost = (...values) => controller.send("deletePost", post, ...values);
          args.recoverPost = () => controller.send("recoverPost", post);
        }
        const Host = Component.default.extend({
          layout: Component.getComponentTemplate(Container),
          renderGlimmer: { _registrations: [{
            element,
            component: curry(NativeBody, args, owner),
            data: {}
          }] }
        });
        join(() => {
          // 宿主从空容器直接挂载，不再先展示一份临时HTML再清空重排。
          host = Host.create(owner.ownerInjection());
          host.appendTo(document.body);
        });
        cookedHosts.set(body.id, { element, host, post, ownsPost });
        if (post.polls?.length && !embedded) syncTreePolls(owner, topic);
        element.dataset.betterldCookedMounted = "true";
      } catch (error) {
        if (host || (ownsPost && post)) {
          try {
            releaseHostResources({ host, post, ownsPost }, false);
          } catch (cleanupError) {
            console.error("[betterLD] failed cooked mount cleanup", cleanupError);
          }
        }
        element.dataset.betterldCookedMounted = "error";
        const notice = document.createElement("p");
        notice.className = "notice error";
        notice.setAttribute("role", "alert");
        notice.textContent = `原站正文增强失败：${error.message}。请返回原帖查看。`;
        element.append(notice);
        console.error("[betterLD] native cooked mount failed", error);
      }
    }
  });

  // 注册先于挂载同步执行：树内所有楼层进同一个 identityMap，后续正文/操作/回复/Boost 共用同一模型。
  document.addEventListener("betterld:reply-register-posts", (event) => {
    const { topicId, posts } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const topic = owner.lookup("controller:topic")?.model;
      if (String(topic?.id) !== topicId) throw new Error('主题已切换，楼层尚未登记');
      registerTreePosts(owner, topic, posts);
      document.dispatchEvent(new CustomEvent('betterld:reply-posts-registered', { detail: JSON.stringify({ topicId, postIds: posts.map((post) => post.id) }) }));
      queueMicrotask(() => document.dispatchEvent(new CustomEvent('betterld:reply-sync', { detail: JSON.stringify({ topicId }) })));
    } catch (error) {
      document.dispatchEvent(new CustomEvent('betterld:reply-data', { detail: JSON.stringify({ topicId, error: error.message }) }));
    }
  });

  document.addEventListener("betterld:reply-menu-mount", (event) => {
    const { id, topicId, postId } = JSON.parse(event.detail);
    let host;
    let post;
    let behavior;
    let ownsPost = false;
    const join = window.require("@ember/runloop").join;
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (String(topic?.id) !== topicId) throw new Error("当前主题已切换");
      const element = document.querySelector(`[data-betterld-menu-id="${CSS.escape(id)}"]`);
      if (!element) throw new Error("帖子操作入口已移除");
      // 操作菜单同样走 identityMap：用树已登记的同一模型，不再新建或 HTTP 补读。
      ({ post, ownsPost } = resolveTreePost(topic, postId));
      const Native = window.require("discourse/components/post/menu").default;
      // 已在树操作栏提供的动作保留一份；其余顺序、权限与插件注册交给原站。
      const existingActions = new Set(["like", "copyLink", "reply", "replies", "showMore", "discourse-reactions-actions", "discourse-boosts-action", "solved"]);
      class MoreMenu extends Native {
        constructor(...args) {
          super(...args);
          this.collapsed = false;
        }
        get availableButtons() {
          return super.availableButtons.filter((button) => !existingActions.has(button.key));
        }
        get extraControls() {
          return super.extraControls.filter((button) => !existingActions.has(button.key));
        }
      }
      const Post = window.require("discourse/components/post").default;
      behavior = new Post(owner, { post });
      const args = {
        post, canCreatePost: topic.details.can_create_post,
        showReadIndicator: controller.showReadIndicator,
        copyLink: behavior.copyLink, share: behavior.share, toggleLike: behavior.toggleLike,
        showFlags: () => controller.send("showPostFlags", post),
        showLogin: () => owner.lookup("route:application").send("showLogin"),
        showPagePublish: () => controller.send("showPagePublish", post),
        editPost: () => controller.send("editPost", post),
        deletePost: (...args) => controller.send("deletePost", post, ...args),
        recoverPost: () => controller.send("recoverPost", post),
        replyToPost: () => controller.send("replyToPost", post)
      };
      for (const action of ["changeNotice", "changePostOwner", "grantBadge", "lockPost", "permanentlyDeletePost", "rebakePost", "togglePostType", "toggleWiki", "unhidePost", "unlockPost"]) {
        args[action] = (...values) => controller.send(action, post, ...values);
      }
      const Component = window.require("@ember/component");
      const Container = window.require("discourse/components/render-glimmer-container").default;
      const curry = window.require("ember-curry-component").default;
      const Host = Component.default.extend({
        layout: Component.getComponentTemplate(Container),
        renderGlimmer: { _registrations: [{ element, component: curry(MoreMenu, args, owner), data: {} }] }
      });
      join(() => {
        host = Host.create(owner.ownerInjection());
        host.appendTo(document.body);
      });
      const bookmarkEvents = owner.lookup("service:app-events");
      const entry = { element, host, post, ownsPost, behavior, bookmarkEvents, onBookmark(data, target) {
        if (target?.target !== "post" || String(target.targetId) !== String(post.id)) return;
        document.dispatchEvent(new CustomEvent("betterld:reply-bookmark-changed", {
          detail: JSON.stringify({ topicId, title: topic.title, postId: post.id, postNumber: post.post_number, bookmarked: Boolean(data) })
        }));
      } };
      bookmarkEvents.on("bookmarks:changed", entry, entry.onBookmark);
      postMenuHosts.set(id, entry);
      element.dataset.betterldMenuMounted = "true";
      document.dispatchEvent(new CustomEvent("betterld:reply-menu-mounted", { detail: JSON.stringify({ id }) }));
    } catch (error) {
      try {
        releaseHostResources({ host, behavior, post, ownsPost }, true);
      } catch (cleanupError) {
        console.error("[betterLD] failed post menu mount cleanup", cleanupError);
      }
      console.error("[betterLD] native post menu mount failed", error);
      document.dispatchEvent(new CustomEvent("betterld:reply-menu-mounted", { detail: JSON.stringify({ id, error: error.message }) }));
    }
  });

  // 解决方案沿用原站菜单注册和摘要组件；同一 identityMap 同时覆盖树补载楼层与实时采纳更新。
  document.addEventListener("betterld:reply-solved-mount", (event) => {
    const { topicId, slots } = JSON.parse(event.detail);
    for (const slot of slots) {
      let host;
      try {
        const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
        const topic = owner.lookup("controller:topic").model;
        if (String(topic?.id) !== topicId) throw new Error("当前主题已切换");
        const element = document.querySelector(`[data-betterld-menu-id="${CSS.escape(slot.id)}"]`);
        if (!element || postMenuHosts.has(slot.id)) continue;
        const { post } = resolveTreePost(topic, slot.postId);
        const NativeMenu = window.require("discourse/components/post/menu").default;
        class SolvedMenu extends NativeMenu {
          constructor(...args) {
            super(...args);
            this.collapsed = false;
          }
          get availableButtons() {
            return super.availableButtons.filter((button) => button.key === "solved");
          }
          get extraControls() {
            return super.extraControls.filter((button) => button.key === "solved");
          }
        }
        const Native = slot.summary
          ? window.require("discourse/plugins/discourse-solved/discourse/components/solved-accepted-answers").default
          : SolvedMenu;
        const Component = window.require("@ember/component");
        const Container = window.require("discourse/components/render-glimmer-container").default;
        const curry = window.require("ember-curry-component").default;
        const Host = Component.default.extend({
          layout: Component.getComponentTemplate(Container),
          renderGlimmer: { _registrations: [{ element, component: curry(Native, { post }, owner), data: {} }] }
        });
        window.require("@ember/runloop").join(() => {
          host = Host.create(owner.ownerInjection());
          host.appendTo(document.body);
        });
        const entry = { element, host, post, ownsPost: false };
        if (!slot.summary) {
          entry.solvedEvents = owner.lookup("service:app-events");
          entry.onSolved = (changedPost) => {
            if (changedPost !== post) return;
            document.dispatchEvent(new CustomEvent("betterld:reply-sync", { detail: JSON.stringify({ topicId }) }));
          };
          entry.solvedEvents.on("discourse-solved:solution-toggled", entry, entry.onSolved);
        }
        postMenuHosts.set(slot.id, entry);
        element.dataset.betterldMenuMounted = "true";
      } catch (error) {
        const element = document.querySelector(`[data-betterld-menu-id="${CSS.escape(slot.id)}"]`);
        if (element) element.dataset.betterldMenuMounted = "error";
        try {
          releaseHostResources({ host }, false);
        } catch (cleanupError) {
          console.error("[betterLD] failed solved mount cleanup", cleanupError);
        }
        console.error("[betterLD] native solved mount failed", error);
        document.dispatchEvent(new CustomEvent("betterld:reply-data", {
          detail: JSON.stringify({ topicId, error: `解决方案加载失败：${error.message}` })
        }));
      }
    }
  });

  // 用户卡片身份只在卡片已加载模型时读取：view-registry 按元素 id 持有卡片实例，不新增任何用户请求。
  document.addEventListener("betterld:user-card-request", (event) => {
    const { id } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const element = document.querySelector("#user-card");
      const card = element && owner.lookup("-view-registry:main")[element.id];
      const user = card?.user;
      // 卡片先渲染 loading 骨架，user 稍后赋值：未载入时返回 pending，由卡片 DOM 变化重试。
      if (!user) {
        document.dispatchEvent(new CustomEvent("betterld:user-card", {
          detail: JSON.stringify({ id, pending: true })
        }));
        return;
      }
      document.dispatchEvent(new CustomEvent("betterld:user-card", {
        detail: JSON.stringify({ id, payload: { userId: user.id, username: user.username, avatarTemplate: user.avatar_template || "" } })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:user-card", {
        detail: JSON.stringify({ id, error: error.message })
      }));
    }
  });

  // 静态头像身份只读原站已加载的模型，不发任何用户请求；CDN 解析交给原站 getURLWithCDN。
  function rememberAvatarTemplate(map, ids, user) {
    const username = typeof user?.username === "string" ? user.username.trim() : "";
    const template = typeof user?.avatar_template === "string" ? user.avatar_template.trim() : "";
    if (Number.isSafeInteger(user?.id) && username) {
      ids.set(user.id, username);
    }
    if (username && template && !map.has(username)) {
      map.set(username, template);
    }
  }

  function readModelAvatarTemplates(owner, map, ids) {
    const topic = owner.lookup("controller:topic")?.model;
    if (topic) {
      rememberAvatarTemplate(map, ids, topic.details?.created_by);
      (topic.details?.participants || []).forEach((user) => rememberAvatarTemplate(map, ids, user));
      (topic.postStream?.posts || []).forEach((post) => {
        rememberAvatarTemplate(map, ids, post);
        rememberAvatarTemplate(map, ids, post.user);
        (post.boosts || []).forEach((boost) => rememberAvatarTemplate(map, ids, boost.user));
      });
      (topic.postStream?.users || []).forEach((user) => rememberAvatarTemplate(map, ids, user));
    }
    rememberAvatarTemplate(map, ids, owner.lookup("service:current-user"));
    const element = document.querySelector("#user-card");
    const card = element && owner.lookup("-view-registry:main")[element.id];
    rememberAvatarTemplate(map, ids, card?.user);
  }

  document.addEventListener("betterld:media-data-request", (event) => {
    const { id, pairs, templates } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const getURLWithCDN = window.require("discourse/lib/get-url").getURLWithCDN;
      const map = new Map(Object.entries(templates || {}));
      const ids = new Map();
      readModelAvatarTemplates(owner, map, ids);
      const urls = {};
      const missing = [];
      (pairs || []).forEach((pair) => {
        const username = pair.username || ids.get(Number(pair.userId)) || "";
        const template = map.get(username);
        if (!template) {
          missing.push(pair.key);
          return;
        }
        urls[`${pair.key}|${pair.size}`] = getURLWithCDN(String(template).replace("{size}", String(pair.size)));
      });
      document.dispatchEvent(new CustomEvent("betterld:media-data", {
        detail: JSON.stringify({ id, payload: { urls, missing } })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:media-data", {
        detail: JSON.stringify({ id, error: error.message })
      }));
    }
  });

  document.addEventListener("betterld:reading-filter-request", async (event) => {
    const { id, topicId, username } = JSON.parse(event.detail);
    let stream;
    let previous;
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      if (String(controller.model?.id) !== topicId) throw new Error("当前主题已切换");
      stream = controller.model.postStream;
      if (stream.loadingFilter) throw new Error("原站正在切换筛选，请稍后重试");
      previous = { userFilters: [...stream.userFilters], filter: stream.filter,
        filterRepliesToPostNumber: stream.filterRepliesToPostNumber, filterUpwardsPostID: stream.filterUpwardsPostID };
      if (username) await stream.filterParticipant(username);
      else await stream.refresh({ cancelFilter: true });
      const pathTopicId = location.pathname.match(/^\/t\/(?:(\d+)|[^/]+\/(\d+))(?:\/|$)/);
      if (String(controller.model?.id) !== topicId || (pathTopicId?.[1] || pathTopicId?.[2]) !== topicId) throw new Error("当前主题已切换");
      controller.updateQueryParams();
      // 本次筛选需要完整快照，不能沿用前一种筛选的增量签名。
      replySignature = "";
      replyPostSnapshots.clear();
      document.dispatchEvent(new CustomEvent("betterld:reading-filter-result", {
        detail: JSON.stringify({ id, topicId, userFilters: [...stream.userFilters], topReplies: stream.filter === "summary" })
      }));
      // 即使内容脚本等待已超时，迟到的原站成功也必须重新同步，而不是留下旧视图。
      queueMicrotask(() => document.dispatchEvent(new CustomEvent("betterld:reply-sync", { detail: JSON.stringify({ topicId }) })));
    } catch (error) {
      if (stream && previous) {
        stream.setProperties({ ...previous, loadingFilter: false });
      }
      document.dispatchEvent(new CustomEvent("betterld:reading-filter-result", {
        detail: JSON.stringify({ id, topicId, error: error.message || "原站筛选失败" })
      }));
    }
  });

  document.addEventListener("betterld:export-topic-request", (event) => {
    const { id, topicId } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const topic = owner.lookup("controller:topic").model;
      if (String(topic?.id) !== topicId) throw new Error("当前主题已切换");
      const stream = topic.postStream;
      if (stream.loadingFilter) throw new Error("主题正在切换筛选，请稍后导出");
      document.dispatchEvent(new CustomEvent("betterld:export-topic-result", {
        detail: JSON.stringify({ id, payload: {
          id: topic.id, title: topic.title, posts_count: topic.posts_count,
          // 作者筛选与摘要筛选都只给出命中楼，导出全部回复时不能把这套流当成完整流。
          filtered: Boolean(stream.filter) || stream.userFilters.length > 0,
          post_stream: { stream: [...stream.stream], posts: stream.posts.map((post) =>
            Object.fromEntries(postFields.map((key) => [key, post[key]]))) }
        } })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:export-topic-result", {
        detail: JSON.stringify({ id, error: error.message })
      }));
    }
  });

  function postSyncStatus(post) {
    return replyAuthors.has(post.id) ? replyAuthors.get(post.id).user.status ?? null
      : post.user?.status === undefined ? post.user_status ?? null : post.user.status;
  }

  // 原站模型上的 computed 投影：HTTP 载荷里没有这两个字段，只有在模型上取值，
  // 树内的点赞入口才不会因为字段缺失而全部禁用。
  function postComputedValues(post) {
    return {
      user_status: postSyncStatus(post),
      showLike: post.showLike === undefined ? null : Boolean(post.showLike),
      canToggleLike: post.canToggleLike === undefined ? null : Boolean(post.canToggleLike)
    };
  }

  function snapshotPost(post) {
    const valueSnapshot = (value) => value && typeof value === "object" ? JSON.stringify(value) : value;
    const fields = postFields.map((key) => valueSnapshot(post[key]));
    fields.push(...Object.values(postComputedValues(post)).map(valueSnapshot));
    fields.push(JSON.stringify(post.boosts?.map((boost) => [
      ...boostFields.map((key) => boost[key]), ...boostUserFields.map((key) => boost.user?.[key])
    ])));
    return fields;
  }

  function postSyncValues(post) {
    return {
      ...Object.fromEntries(postFields.map((key) => [key, post[key]])),
      ...postComputedValues(post),
      boosts: post.boosts?.map((boost) => ({
        ...Object.fromEntries(boostFields.map((key) => [key, boost[key]])),
        user: Object.fromEntries(boostUserFields.map((key) => [key, boost.user?.[key]]))
      }))
    };
  }

  document.addEventListener("betterld:reply-sync", (event) => {
    if (document.hidden) return;
    const { topicId } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const topic = owner.lookup("controller:topic").model;
      if (!topicId || String(topic?.id) !== topicId) {
        replyTopicId = "";
        replySignature = "";
        replyPostSnapshots.clear();
        treeRegisteredPostIds.clear();
        treeRevealedIgnoredIds.clear();
        treeRegisteredTopicId = '';
        releaseTreePollSync();
        releaseTreeReading();
        resetFloorTimeline();
        return;
      }
      if (replyTopicId !== topicId) {
        releaseTreePollSync();
        replySignature = "";
        replyPostSnapshots.clear();
        // 内容脚本可能已为新主题登记，不因首个同步再清一次。
        if (treeRegisteredTopicId !== topicId) {
          treeRegisteredPostIds.clear();
          treeRevealedIgnoredIds.clear();
          treeRegisteredTopicId = topicId;
        }
        releaseTreeReading();
      }
      replyTopicId = topicId;
      const stream = topic.postStream;
      if (stream.loadingFilter) return;
      if (document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')
        && [...cookedHosts.values()].some((entry) => entry.element.isConnected
          && String(entry.post.topic_id) === topicId && entry.post.polls?.length && !entry.ownsPost)) syncTreePolls(owner, topic);
      // loadedPosts 覆盖整个原站 identityMap：既包括当前窗口，也包括原站翻页后留下的缓存和树登记楼层。
      const changedPosts = [];
      const snapshots = new Map();
      for (const post of stream.loadedPosts) {
        const id = String(post.id);
        // 原始字符串直接比较；嵌套字段核对完整内容，保留中间楼原位编辑/回应。
        // 完整对象投影只在变化楼层执行，未变 cooked 不做转义和跨世界序列化。
        const snapshot = snapshotPost(post);
        snapshots.set(id, snapshot);
        const previous = replyPostSnapshots.get(id);
        if (!previous || snapshot.some((value, index) => value !== previous[index])) changedPosts.push(postSyncValues(post));
      }
      const data = { topicId, stream: [...stream.stream], topReplies: stream.filter === "summary", userFilters: [...stream.userFilters], ownerUsername: topic.details.created_by?.username || "", user_badges: topic.user_badges, context: replyTreeContext(owner, topic) };
      const signature = JSON.stringify(data);
      if (signature !== replySignature || changedPosts.length) {
        document.dispatchEvent(new CustomEvent("betterld:reply-data", { detail: JSON.stringify({ ...data, posts: changedPosts }) }));
        replySignature = signature;
      }
      replyPostSnapshots.clear();
      for (const [id, snapshot] of snapshots) replyPostSnapshots.set(id, snapshot);
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:reply-data", {
        detail: JSON.stringify({ topicId, error: error.message || "原站回复同步失败" })
      }));
    }
  });

  document.addEventListener('betterld:reply-read-state-request', (event) => {
    const { topicId } = JSON.parse(event.detail);
    try {
      const owner = window.require('discourse/lib/get-owner').getOwnerWithFallback();
      const topic = owner.lookup('controller:topic').model;
      if (String(topic?.id) !== topicId) throw new Error('当前主题与已读同步请求不一致');
      const posts = new Map(topic.postStream.posts.map((post) => [String(post.id), post]));
      if (treeRegisteredTopicId === topicId) {
        for (const id of treeRegisteredPostIds) {
          if (posts.has(id)) continue;
          const post = topic.postStream.findLoadedPost(id);
          if (post) posts.set(id, post);
        }
      }
      document.dispatchEvent(new CustomEvent('betterld:reply-read-state', {
        detail: JSON.stringify({ topicId, posts: [...posts.values()].map((post) => ({ id: post.id, read: post.read })) })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent('betterld:reply-read-state', {
        detail: JSON.stringify({ topicId, error: error.message || '原站已读状态读取失败' })
      }));
    }
  });

  let treeReading = null;

  function releaseTreeReading() {
    if (!treeReading) return;
    const { service, original, wrapped, appEvents, onTimings, onFailure, jquery } = treeReading;
    if (service.setOnscreen === wrapped) {
      original.call(service, [], []);
      service.setOnscreen = original;
    }
    appEvents.off('topic:timings-sent', onTimings);
    jquery(document).off('ajaxError.betterldReading', onFailure);
    treeReading = null;
  }

  function trackTreeReading(owner, topic, visiblePostIds) {
    const service = owner.lookup('service:screen-track');
    if (treeReading && (treeReading.service !== service || treeReading.topicId !== String(topic.id))) releaseTreeReading();
    if (!treeReading) {
      const original = service.setOnscreen;
      const appEvents = owner.lookup('service:app-events');
      const reading = { service, original, appEvents, topicId: String(topic.id), onScreen: [], readOnScreen: [] };
      reading.wrapped = function (onscreen, readOnscreen) {
        const active = !document.hidden && String(owner.lookup('controller:topic').model?.id) === reading.topicId
          && document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]');
        return original.call(this, active ? reading.onScreen : onscreen, active ? reading.readOnScreen : readOnscreen);
      };
      reading.jquery = window.require('jquery').default;
      reading.onFailure = (_event, xhr, request) => {
        if (new URL(request.url, location.href).pathname !== '/topics/timings') return;
        const requestTopicId = typeof request.data === 'string' ? new URLSearchParams(request.data).get('topic_id') : request.data?.topic_id;
        if (String(requestTopicId) !== reading.topicId || String(owner.lookup('controller:topic').model?.id) !== reading.topicId) return;
        const errors = xhr.responseJSON?.errors;
        const message = Array.isArray(errors) ? errors.join('；') : xhr.responseJSON?.error || xhr.statusText || '网络请求失败';
        document.dispatchEvent(new CustomEvent('betterld:reply-reading-status', {
          detail: JSON.stringify({ topicId: reading.topicId, error: `阅读登记失败（HTTP ${xhr.status}）：${message}；等待原站恢复` })
        }));
      };
      reading.onTimings = (data) => {
        if (String(data.topic_id) !== reading.topicId || String(owner.lookup('controller:topic').model?.id) !== reading.topicId) return;
        document.dispatchEvent(new CustomEvent('betterld:reply-reading-status', { detail: JSON.stringify({ topicId: reading.topicId, error: '' }) }));
        const numbers = new Set(Object.keys(data.timings).map(Number));
        for (const id of treeRegisteredPostIds) {
          const post = topic.postStream.findLoadedPost(id);
          if (post && numbers.has(post.post_number)) post.set('read', true);
        }
        document.dispatchEvent(new CustomEvent('betterld:reply-sync', { detail: JSON.stringify({ topicId: reading.topicId }) }));
      };
      service.setOnscreen = reading.wrapped;
      appEvents.on('topic:timings-sent', reading.onTimings);
      reading.jquery(document).on('ajaxError.betterldReading', reading.onFailure);
      treeReading = reading;
    }
    const ignored = owner.lookup('service:current-user')?.ignored_users || [];
    const posts = [...new Set(visiblePostIds)].map((id) => topic.postStream.findLoadedPost(id))
      .filter((post) => post && !post.cooked_hidden && typeof post.cooked === 'string' && post.cooked.trim()
        && (!ignored.includes(post.username) || treeRevealedIgnoredIds.has(String(post.id))));
    treeReading.onScreen = posts.map((post) => post.post_number);
    treeReading.readOnScreen = posts.filter((post) => post.read).map((post) => post.post_number);
    treeReading.original.call(service, treeReading.onScreen, treeReading.readOnScreen);
  }

  document.addEventListener('betterld:reply-reading-release', releaseTreeReading);
  window.addEventListener('pagehide', releaseTreeReading);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseTreeReading();
  });

  document.addEventListener("betterld:reply-position", (event) => {
    const { topicId, postNumber, postId, ratio, visiblePostIds = [], active, timeoutMs } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (String(topic?.id) !== topicId || !active || document.hidden) {
        releaseTreeReading();
        if (String(topic?.id) !== topicId) return;
      } else {
        trackTreeReading(owner, topic, visiblePostIds);
        const post = topic.postStream.findLoadedPost(postId);
        if (post && visiblePostIds.includes(post.id) && topic.postStream.stream.includes(post.id)) {
          if (String(controller.currentPostId) !== String(post.id)) controller.currentPostChanged({ post });
          controller.currentPostScrolled({ percent: Number(ratio) || 0 });
        }
      }
      syncFloorTimeline(topic, Number(active ? postNumber : controller.currentPostNumber), active, timeoutMs);
    } catch (error) {
      console.error("[betterLD] floor timeline sync failed", error);
      document.dispatchEvent(new CustomEvent("betterld:reply-data", { detail: JSON.stringify({ topicId, error: error.message }) }));
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
      // 树登记的楼层已在原站 identityMap 里，不再另发一次 HTTP find。
      const post = topic.postStream.findLoadedPost(postId);
      if (!post) throw new Error("目标楼层尚未登记，请重试");
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
      // 树登记的楼层已在原站 identityMap 里，不再另发一次 HTTP find。
      const post = topic.postStream.findLoadedPost(postId);
      if (!post) throw new Error("目标楼层尚未载入，请重试");
      if (post.can_boost !== true) throw new Error("当前楼层不允许 Boost");
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

  document.addEventListener('betterld:reply-action', async (event) => {
    const { id, topicId, postId, action, boostId, permissions, cooked, updated } = JSON.parse(event.detail);
    let result = {};
    try {
      const owner = window.require('discourse/lib/get-owner').getOwnerWithFallback();
      const controller = owner.lookup('controller:topic');
      const topic = controller.model;
      const post = topic?.postStream.findLoadedPost(postId);
      const assertTopic = () => {
        if (String(controller.model?.id) !== topicId || Number(post?.topic_id) !== Number(topicId)) throw new Error('目标楼层不属于当前主题');
      };
      assertTopic();
      if (action === 'reveal') {
        if (!post.can_see_hidden_post || typeof cooked !== 'string' || !cooked.trim()) throw new Error('隐藏正文权限或响应无效');
        post.setProperties({ cooked, cooked_hidden: false });
      } else if (action === 'like-check') {
        if (!owner.lookup('service:current-user') || post.showLike === false || post.canToggleLike === false) throw new Error('当前不允许更改回应');
      } else if (action === 'reaction-update') {
        if (Number(updated?.id) !== Number(post.id) || Number(updated.post_number) !== post.post_number) throw new Error('回应结果楼层不匹配');
        post.setProperties(Object.fromEntries(['reactions', 'reaction_users_count', 'current_user_reaction', 'actions_summary'].filter((key) => key in updated).map((key) => [key, updated[key]])));
      } else if (action === 'ignore-reveal') {
        const ignored = owner.lookup('service:current-user')?.ignored_users || [];
        if (!ignored.includes(post.username)) throw new Error('当前楼层不处于忽略状态');
        if (updated) {
          if (Number(updated.id) !== Number(post.id) || updated.post_number !== post.post_number || (updated.topic_id !== undefined && Number(updated.topic_id) !== Number(topicId))) throw new Error('忽略回复响应身份不匹配');
          post.setProperties(Object.fromEntries(postFields.filter((key) => key in updated).map((key) => [key, updated[key]])));
        }
        if (!post.cooked_hidden && !post.deleted_post_placeholder && !post.deleted_at && !post.user_deleted && (typeof post.cooked !== 'string' || !post.cooked.trim())) throw new Error('该忽略回复的正文尚未载入');
        treeRevealedIgnoredIds.add(String(post.id));
      } else {
        const currentUser = owner.lookup('service:current-user');
        if (!currentUser) throw new Error('请登录后管理 Boost');
        const boost = post.boosts?.find((entry) => Number(entry.id) === Number(boostId));
        if (!boost) throw new Error('这条 Boost 已不存在');
        if (permissions) Object.assign(boost, {
          can_delete: permissions.can_delete, can_flag: permissions.can_flag,
          available_flags: permissions.available_flags, user_flag_status: permissions.user_flag_status
        });
        if (action === 'boost-delete') {
          if (boost.can_delete !== true) throw new Error('当前无权删除这条 Boost');
          const own = Number(boost.user?.id) === Number(currentUser.id);
          if (!own) {
            document.dispatchEvent(new CustomEvent('betterld:reply-action-wait', { detail: JSON.stringify({ id, waiting: true }) }));
            try {
              const confirmed = await owner.lookup('service:dialog').yesNoConfirm({
                message: window.require('discourse-i18n').i18n('discourse_boosts.confirm_delete_boost')
              });
              if (!confirmed) result.cancelled = true;
            } finally {
              document.dispatchEvent(new CustomEvent('betterld:reply-action-wait', { detail: JSON.stringify({ id, waiting: false }) }));
            }
          }
          if (!result.cancelled) {
            assertTopic();
            if (boost.can_delete !== true || !post.boosts?.some((entry) => Number(entry.id) === Number(boost.id))) throw new Error('Boost状态已改变，请重试');
            await window.require('discourse/lib/ajax').ajax(`/discourse-boosts/boosts/${boost.id}`, { type: 'DELETE' });
            assertTopic();
            post.set('boosts', (post.boosts || []).filter((entry) => Number(entry.id) !== Number(boost.id)));
            if (own) post.set('can_boost', true);
          }
        } else if (action === 'boost-flag') {
          if (boost.can_flag !== true || !Array.isArray(boost.available_flags)) throw new Error('当前无权举报这条 Boost或举报选项不可用');
          const moduleName = Object.keys(window.require.entries).find((name) => name.endsWith('/lib/boost-flag'));
          if (!moduleName) throw new Error('原站 Boost 举报组件不可用');
          const FlagTarget = window.require(moduleName).default;
          const flagTarget = new FlagTarget(owner);
          flagTarget.boostId = boost.id;
          flagTarget.availableFlags = boost.available_flags;
          owner.lookup('service:modal').show(window.require('discourse/components/modal/flag').default, {
            model: { flagTarget, flagModel: { ...boost, user_id: boost.user.id, username: boost.user.username }, setHidden: () => {} }
          });
        } else if (action !== 'boost-inspect') throw new Error('不支持的树内操作');
        // 嵌套 Boost 对象不是 tracked；更新数组让所有原站宿主收到权限变化。
        post.set('boosts', [...(post.boosts || [])]);
      }
      result.post = postSyncValues(post);
      queueMicrotask(() => document.dispatchEvent(new CustomEvent('betterld:reply-sync', { detail: JSON.stringify({ topicId }) })));
    } catch (error) {
      result.error = error.message || '原站操作失败';
    }
    document.dispatchEvent(new CustomEvent('betterld:reply-action-result', { detail: JSON.stringify({ id, ...result }) }));
  });

  // 当前列表路由的主题数据就在站点自己的模型里（服务端预载、无限滚动、客户端路由取回的都在），
  // 直接投影列表条目与已有计数，头像按模板解析、统计展示仍由内容脚本共用实现。
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

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // 列表条目的最终形状在这里定下来：内容脚本直接消费 entries，不再自己 join 用户表。
  function topicListEntry(topic, users) {
    const posters = arrayOrEmpty(topic.posters);
    const firstPoster = posters[0];
    const firstPosterId = firstPoster?.user?.id ?? firstPoster?.user_id ?? firstPoster?.userId;
    const firstPosterUser = users.get(firstPosterId);
    const participants = [];
    const seenAvatars = new Set();
    for (const poster of posters) {
      const user = users.get(poster.user?.id ?? poster.user_id ?? poster.userId);
      if (!user) continue;
      const avatarTemplate = stringOrEmpty(user.avatar_template ?? user.avatarTemplate).trim();
      if (!avatarTemplate || seenAvatars.has(avatarTemplate)) continue;
      seenAvatars.add(avatarTemplate);
      participants.push({ username: cleanText(user.username), avatarTemplate });
      if (participants.length === 4) break;
    }
    const creatorAvatar = stringOrEmpty(topic.creator?.avatar_template ?? topic.creator?.avatarTemplate);
    return {
      id: String(topic.id),
      watched: topic.visited === true || numberOrNull(topic.last_read_post_number) > 0,
      // 列表与详情推荐模型都带创建者身份；没有 id 时退回 posters[0]。
      authorId: numberOrNull(topic.creator_id ?? topic.creator?.id) || Number(firstPosterId) || 0,
      authorAvatar: creatorAvatar || stringOrEmpty(firstPosterUser?.avatar_template ?? firstPosterUser?.avatarTemplate),
      author: cleanText(topic.creator?.username) || cleanText(firstPosterUser?.username),
      activityAt: cleanText(isoOrEmpty(topic.last_posted_at ?? topic.lastPostedAt)
        || isoOrEmpty(topic.bumped_at ?? topic.bumpedAt) || isoOrEmpty(topic.created_at ?? topic.createdAt)),
      counts: {
        posts_count: numberOrNull(topic.posts_count ?? topic.postsCount),
        reply_count: numberOrNull(topic.reply_count ?? topic.replyCount),
        like_count: numberOrNull(topic.like_count ?? topic.likeCount),
        views: numberOrNull(topic.views)
      },
      participants
    };
  }

  function currentTopicListPayload() {
    const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
    const name = owner.lookup("service:router")?.currentRouteName;
    const model = name ? owner.lookup(`route:${name}`)?.currentModel : null;
    const currentTopic = name?.startsWith("topic.") ? owner.lookup("controller:topic")?.model : null;
    const category = currentTopic?.category;
    const currentMetadata = currentTopic ? {
      id: String(currentTopic.id),
      ...(currentTopic.details?.created_by?.username?.trim() ? { author: currentTopic.details.created_by.username.trim() } : {}),
      ...(currentTopic.details?.created_by?.avatar_template ? { author_avatar_template: currentTopic.details.created_by.avatar_template } : {}),
      ...(category?.id && category.name ? { category: { id: String(category.id), name: category.name } }
        : currentTopic.category_id === null ? { category: null } : {}),
      ...(Array.isArray(currentTopic.tags) ? { tags: currentTopic.tags.map((tag) => typeof tag === "string" ? tag : tag.name).filter((tag) => typeof tag === "string" && tag.trim()) } : {})
    } : null;
    let list = model?.list ?? model;
    if (name === "full-page-search") list = owner.lookup("controller:full-page-search")?.model;
    if (name?.startsWith("topic.")) {
      const topic = owner.lookup("controller:topic")?.model;
      list = { topics: [...arrayOrEmpty(topic?.suggestedTopics), ...arrayOrEmpty(topic?.relatedTopics)] };
    }
    const topics = Array.isArray(list?.topics) ? list.topics
      : Array.isArray(list?.topic_list?.topics) ? list.topic_list.topics : null;
    if (!topics?.length && !currentMetadata) return null;
    const entries = topics || [];
    const users = new Map([
      ...arrayOrEmpty(list?.users ?? model?.users),
      ...entries.flatMap((topic) => arrayOrEmpty(topic.posters).map((poster) => poster.user).filter(Boolean))
    ].map((user) => [user.id, user]));
    return {
      current_topic: currentMetadata,
      entries: entries.map((topic) => topicListEntry(topic, users))
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

  document.addEventListener("betterld:search-state-request", (event) => {
    const { id } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const route = owner.lookup("service:router").currentRouteName;
      const controller = route === "full-page-search" ? owner.lookup("controller:full-page-search") : null;
      const model = controller?.model;
      const term = model?.grouped_search_result?.term;
      const ready = Boolean(controller && typeof term === "string" && term === controller.q
        && Array.isArray(model.posts) && !controller.searching && !controller.loading
        && !controller.error && !controller.invalidSearch && controller.searchActive
        && controller.usingDefaultSearchType && !controller.context && !controller.isPrivateMessage && !controller.isPMOnly);
      // 搜索命中帖的作者以原站搜索模型的 user_id 为准，不从用户名字符串反推。
      const authors = ready ? Object.fromEntries(model.posts.map((post) => [String(post.topic_id), post.user_id])) : {};
      document.dispatchEvent(new CustomEvent("betterld:search-state", {
        detail: JSON.stringify({ id, ready, query: ready ? term : "", empty: ready && controller.resultCount === 0, authors })
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("betterld:search-state", { detail: JSON.stringify({ id, error: error.message }) }));
    }
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
})();
