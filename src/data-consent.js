// Firefox 140+ 的内建数据收集授权：manifest 的 gecko.data_collection_permissions.optional
// 声明可选数据类别，运行时用 browser.permissions 的 data_collection 字段申请与查询。
// 只有同时具备 browser 全局、权限 API 与 gecko 声明的环境才使用该字段；Chrome 与 Orca 预览
// 没有这套权限，helper 在那里只按精确 origin 申请，不调用 Firefox 专有字段。
(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  // 权限 API 在 Chrome 上只有 chrome 全局，在 Firefox 上只有 browser 全局；两者都用于发起申请。
  const firefox = globalThis.browser;
  const api = firefox || globalThis.chrome;
  if (!config?.dataCollectionScopes) {
    throw new Error("betterLD data consent could not initialize: config is unavailable");
  }

  const gecko = Boolean(firefox?.runtime?.getManifest?.()?.browser_specific_settings?.gecko);
  const supported = Boolean(firefox?.permissions?.request && firefox.permissions.contains && gecko);
  // 有 Firefox 全局却没有权限 API 的世界（Firefox 网页内设置跑在内容脚本世界）既不能申请也不能查询，
  // 按未授权处理，由调用方明确失败，而不是静默放行上传。
  const unverifiable = Boolean(firefox) && !supported;

  function categories(scope) {
    const value = config.dataCollectionScopes[scope];
    if (!value?.length) {
      throw new Error(`未知的数据收集范围：${scope}`);
    }
    return [...value];
  }

  // 必须在用户手势的同步调用链里调用：同步发起，返回 Promise，等待时机由调用方决定。
  // Firefox 把精确 origins 与 data_collection 合并进同一次 request，授权要么全给要么全不给。
  function request(scope, origins = []) {
    const payload = supported ? { data_collection: categories(scope) } : {};
    if (origins.length) {
      payload.origins = [...origins];
    }
    return api.permissions.request(payload);
  }

  async function require(scope) {
    if (!supported) {
      if (unverifiable) {
        throw new Error("当前页面无法确认数据收集授权，请在扩展设置页重试");
      }
      // Chrome 与预览没有数据收集授权这个概念，这里没有可检查的状态。
      return;
    }
    const data_collection = categories(scope);
    const granted = await api.permissions.contains({ data_collection });
    if (!granted) {
      throw new Error(`缺少数据收集授权（${data_collection.join("、")}）：请在扩展设置页重新申请后再试`);
    }
  }

  // firefox 表示当前环境的传输受 Firefox 内建数据收集授权约束（Chrome 与预览为 false）。
  globalThis.BETTERLD_DATA_CONSENT = Object.freeze({ firefox: Boolean(firefox), supported, request, require });
})();
