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
  const postFields = ["id", "post_number", "reply_to_post_number", "user_id", "username", "name", "avatar_template", "user_title", "title_is_group", "primary_group_name", "flair_name", "flair_url", "flair_bg_color", "flair_color", "flair_group_id", "admin", "moderator", "trust_level", "created_at", "updated_at", "cooked", "post_url", "can_boost", "reactions", "reaction_users_count", "current_user_reaction", "actions_summary", "polls", "polls_votes", "link_counts", "post_type", "reply_count", "hidden", "deleted_at", "user_deleted", "can_edit", "can_delete", "can_recover", "can_permanently_delete", "can_wiki", "wiki", "locked", "bookmarked", "bookmark_id", "bookmark_name", "bookmark_reminder_at", "bookmark_auto_delete_preference", "reviewable_id", "reviewable_score_count", "reviewable_score_pending_count", "can_localize_post", "can_localize_topic", "can_localize_content", "post_localizations_count", "language", "locale", "is_localized", "can_assign", "assigned_to_user", "assigned_to_group", "assignment_status", "assignment_note"];
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
    const value = String(floor);
    if (timeline.input.value !== value) timeline.input.value = value;
    const label = `${floor} / ${timeline.lastFloor}`;
    if (timeline.label.textContent !== label) timeline.label.textContent = label;
    if (timeline.input.getAttribute("aria-valuetext") !== label) timeline.input.setAttribute("aria-valuetext", label);
    const progress = String(timeline.lastFloor > 1 ? (floor - 1) / (timeline.lastFloor - 1) : 0);
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
      element.dataset.betterldOwned = "true";
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
      });
    }
    const timeline = floorTimeline;
    timeline.lastFloor = lastFloor;
    timeline.active = active;
    timeline.timeoutMs = timeoutMs;
    if (timeline.input.max !== String(lastFloor)) timeline.input.max = String(lastFloor);
    if (timeline.element.style.height !== source.style.height) timeline.element.style.height = source.style.height;
    if (Number.isInteger(floor) && floor > 0 && floor <= lastFloor) timeline.floor = floor;
    if (!active && timeline.pending?.target === timeline.floor) finishFloorJump(timeline, timeline.floor);
    if (!timeline.editing && !timeline.pending) {
      if (timeline.input.disabled !== (lastFloor === 1)) timeline.input.disabled = lastFloor === 1;
      renderFloorTimeline(timeline, timeline.floor);
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
  function releaseHostResources(entry, menu) {
    const errors = [];
    window.require("@ember/runloop").join(() => {
      const resources = entry.host ? [["host", () => entry.host.destroy()]] : [];
      if (menu && entry.bookmarkEvents) resources.push(["bookmark-events", () => entry.bookmarkEvents.off("bookmarks:changed", entry, entry.onBookmark)]);
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
    const Native = window.require("discourse/components/post/cooked-html").default;
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
        const loaded = topic.postStream.posts.find((post) => String(post.id) === String(body.post.id));
        ownsPost = body.post.embeddedPost || !loaded || loaded.cooked !== body.post.cooked;
        post = ownsPost ? owner.factoryFor("model:post").create({ ...body.post, topic_id: topic.id, topic }) : loaded;
        const Host = Component.default.extend({
          layout: Component.getComponentTemplate(Container),
          renderGlimmer: { _registrations: [{
            element,
            component: curry(Native, { post, streamElement: true, className: "cooked", embeddedPost: body.post.embeddedPost, selectionBarrier: false }, owner),
            data: {}
          }] }
        });
        join(() => {
          host = Host.create(owner.ownerInjection());
          element.replaceChildren();
          host.appendTo(document.body);
        });
        cookedHosts.set(body.id, { element, host, post, ownsPost });
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

  document.addEventListener("betterld:reply-menu-mount", (event) => {
    const { id, topicId, post: data } = JSON.parse(event.detail);
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
      const loaded = topic.postStream.posts.find((entry) => String(entry.id) === String(data.id));
      ownsPost = !loaded;
      post = loaded || window.require("discourse/models/post").default.create({ ...data, topic_id: topic.id, topic, store: owner.lookup("service:store") });
      const Native = window.require("discourse/components/post/menu").default;
      // 已在树操作栏提供的动作保留一份；其余顺序、权限与插件注册交给原站。
      const existingActions = new Set(["like", "copyLink", "reply", "replies", "showMore", "discourse-reactions-actions", "discourse-boosts-action"]);
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

  function snapshotPost(post) {
    const valueSnapshot = (value) => value && typeof value === "object" ? JSON.stringify(value) : value;
    const fields = postFields.map((key) => valueSnapshot(post[key]));
    fields.push(valueSnapshot(postSyncStatus(post)));
    fields.push(JSON.stringify(post.boosts?.map((boost) => [
      ...boostFields.map((key) => boost[key]), ...boostUserFields.map((key) => boost.user?.[key])
    ])));
    return fields;
  }

  function postSyncValues(post) {
    return {
      ...Object.fromEntries(postFields.map((key) => [key, post[key]])),
      user_status: postSyncStatus(post),
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
        resetFloorTimeline();
        return;
      }
      if (replyTopicId !== topicId) {
        replySignature = "";
        replyPostSnapshots.clear();
      }
      replyTopicId = topicId;
      const stream = topic.postStream;
      if (stream.loadingFilter) return;
      const posts = new Map(stream.posts.map((post) => [String(post.id), post]));
      const streamIds = new Set(stream.stream.map(String));
      for (const entry of postMenuHosts.values()) {
        if (entry.ownsPost && String(entry.post.topic_id) === topicId && streamIds.has(String(entry.post.id)) && !posts.has(String(entry.post.id))) {
          posts.set(String(entry.post.id), entry.post);
        }
      }
      const changedPosts = [];
      const snapshots = new Map();
      for (const [id, post] of posts) {
        // 原始字符串直接比较；嵌套字段核对完整内容，保留中间楼原位编辑/回应。
        // 完整对象投影只在变化楼层执行，未变 cooked 不做转义和跨世界序列化。
        const snapshot = snapshotPost(post);
        snapshots.set(id, snapshot);
        const previous = replyPostSnapshots.get(id);
        if (!previous || snapshot.some((value, index) => value !== previous[index])) changedPosts.push(postSyncValues(post));
      }
      const data = { topicId, stream: [...stream.stream], topReplies: stream.filter === "summary", userFilters: [...stream.userFilters], ownerUsername: topic.details.created_by?.username || "", user_badges: topic.user_badges };
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

  document.addEventListener("betterld:reply-position", (event) => {
    if (document.hidden) return;
    const { topicId, postNumber, active, timeoutMs } = JSON.parse(event.detail);
    try {
      const owner = window.require("discourse/lib/get-owner").getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (String(topic?.id) !== topicId) return;
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
    const currentTopic = name?.startsWith("topic.") ? owner.lookup("controller:topic")?.model : null;
    const category = currentTopic?.category;
    const currentMetadata = currentTopic ? {
      id: String(currentTopic.id),
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
    const users = [
      ...arrayOrEmpty(list?.users ?? model?.users),
      ...entries.flatMap((topic) => arrayOrEmpty(topic.posters).map((poster) => poster.user).filter(Boolean))
    ];
    return {
      current_topic: currentMetadata,
      // 头像保留模板（含 {size} 占位），消费端按原站 CDN 配置解析资产地址。
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        avatar_template: stringOrEmpty(user.avatar_template ?? user.avatarTemplate)
      })),
      topic_list: {
        topics: entries.map((topic) => ({
          id: String(topic.id),
          creator: topic.creator?.username || "",
          // 列表与详情推荐模型都带创建者身份；没有 id 时留 null，消费端再退回 posters[0]。
          creator_id: numberOrNull(topic.creator_id ?? topic.creator?.id),
          creator_avatar_template: stringOrEmpty(topic.creator?.avatar_template ?? topic.creator?.avatarTemplate),
          excerpt: stringOrEmpty(topic.excerpt),
          posters: arrayOrEmpty(topic.posters).map((poster) => ({
            user_id: poster.user?.id ?? poster.user_id ?? poster.userId,
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
