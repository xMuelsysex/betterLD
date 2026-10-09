(() => {
  "use strict";

  // 仅在页面上下文调用原站模型：原站的 MessageBus 和分页仍由 Discourse 管理，
  // 列表主题与主题回复都直接读 Discourse 自己已经下载好的模型，避免同一份数据再请求一遍。
  let pending = null;
  let pendingHref = "";
  let replyTopicId = "";
  let replySignature = "";
  let floorTimeline = null;
  const replyAuthors = new Map();
  const postFields = ["id", "post_number", "reply_to_post_number", "user_id", "username", "name", "avatar_template", "user_title", "title_is_group", "primary_group_name", "flair_name", "flair_url", "flair_bg_color", "flair_color", "flair_group_id", "admin", "moderator", "trust_level", "created_at", "updated_at", "cooked", "post_url", "can_boost", "reactions", "reaction_users_count", "current_user_reaction", "actions_summary"];
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

  function replyAuthorError(topicId, error) {
    console.error("[betterLD] 作者附加信息渲染失败", error);
    document.dispatchEvent(new CustomEvent("betterld:reply-data", {
      detail: JSON.stringify({ topicId, error: `作者附加信息渲染失败：${error.message}` })
    }));
  }

  function resetReplyAuthors() {
    for (const entry of replyAuthors.values()) {
      entry.user.off("status-changed", entry, entry.onStatus);
      if (entry.tracking) entry.user.statusManager.stopTrackingStatus();
      for (const view of entry.views) view.message?.destroy();
      if (entry.ownsUser) entry.user.destroy();
    }
    replyAuthors.clear();
    // 同话题的新树也必须收到模型投影，不能沿用上一棵树的同步签名。
    replySignature = "";
  }

  document.addEventListener("betterld:reply-author-reset", resetReplyAuthors);

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
        user_badges: topic.user_badges,
        posts: stream.posts.map((post) => ({
          ...Object.fromEntries(postFields.map((key) => [key, post[key]])),
          // 原站通过 User 模型接收状态变更；null 也要投影，以移除树里已取消的状态。
          user_status: replyAuthors.has(post.id) ? replyAuthors.get(post.id).user.status ?? null
            : post.user?.status === undefined ? post.user_status ?? null : post.user.status,
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
      document.dispatchEvent(new CustomEvent("betterld:search-state", {
        detail: JSON.stringify({ id, ready, query: ready ? term : "", empty: ready && controller.resultCount === 0 })
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
