(() => {
  "use strict";

  // 仅在页面上下文调用原站模型，原站的 MessageBus 和分页仍由 Discourse 管理。
  let pending = null;
  let pendingHref = "";
  let replyTopicId = "";
  let replySignature = "";
  const boundControllers = new WeakSet();
  const postFields = ["id", "post_number", "reply_to_post_number", "username", "name", "avatar_template", "created_at", "updated_at", "cooked", "post_url", "can_boost", "reactions", "reaction_users_count", "current_user_reaction", "actions_summary"];

  function jumpReply(postNumber, postId) {
    document.dispatchEvent(new CustomEvent("betterld:reply-jump", {
      detail: JSON.stringify({ topicId: replyTopicId, postNumber, postId })
    }));
  }

  // 原站时间轴、楼层输入框和日期跳转继续使用原控件，仅将同主题定位交给树。
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
    const { topicId, postNumber, postId, active } = JSON.parse(event.detail);
    try {
      const { getOwnerWithFallback } = window.require("discourse/lib/get-owner");
      const owner = getOwnerWithFallback();
      const controller = owner.lookup("controller:topic");
      const topic = controller.model;
      if (!topicId || String(topic?.id) !== topicId) {
        replyTopicId = "";
        replySignature = "";
        return;
      }
      if (replyTopicId !== topicId) replySignature = "";
      replyTopicId = topicId;
      const stream = topic.postStream;
      if (!boundControllers.has(controller)) {
        const jumpToIndex = controller._jumpToIndex;
        controller._jumpToIndex = function (index) {
          if (document.querySelector('.container.posts[data-betterld-reply-tree-active="true"]')) {
            const ids = this.model.postStream.stream;
            jumpReply(undefined, ids[Math.max(0, Math.min(ids.length - 1, index - 1))]);
            return;
          }
          return jumpToIndex.call(this, index);
        };
        boundControllers.add(controller);
      }
      const data = {
        topicId,
        stream: [...stream.stream],
        posts: stream.posts.map((post) => Object.fromEntries(postFields.map((key) => [key, post[key]])))
      };
      const signature = JSON.stringify(data);
      if (signature !== replySignature) {
        replySignature = signature;
        document.dispatchEvent(new CustomEvent("betterld:reply-data", { detail: signature }));
      }
      if (active && postNumber) {
        const postIndex = stream.stream.indexOf(postId) + 1;
        owner.lookup("service:app-events").trigger("topic:current-post-scrolled", {
          postIndex, percent: stream.stream.length > 1 ? (postIndex - 1) / (stream.stream.length - 1) : 0
        });
      }
      const timelineReplies = document.querySelector(".topic-timeline .timeline-replies");
      const currentFloor = Number(active ? postNumber : controller.currentPostNumber);
      const lastFloor = Number(topic.highest_post_number);
      if (timelineReplies && Number.isInteger(currentFloor) && Number.isInteger(lastFloor) && currentFloor > 0 && lastFloor >= currentFloor) {
        const label = `${currentFloor} / ${lastFloor}`;
        if (timelineReplies.textContent.trim() !== label) timelineReplies.textContent = label;
        const slider = timelineReplies.closest(".timeline-scroller");
        if (slider?.hasAttribute("aria-valuetext")) slider.setAttribute("aria-valuetext", label);
      }
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
