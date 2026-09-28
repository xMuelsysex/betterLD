(() => {
  "use strict";

  // 仅在页面上下文调用原站模型，原站的 MessageBus 和分页仍由 Discourse 管理。
  let pending = null;
  let pendingHref = "";
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
