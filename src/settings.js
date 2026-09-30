(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;
  if (!config?.settingsDefaults || !config?.settingsLimits) {
    throw new Error("betterLD settings configuration is unavailable");
  }

  const defaults = config.settingsDefaults;
  const limits = config.settingsLimits;
  const enums = config.settingsEnums || {};
  const modes = config.wallpaperModes;
  const maxRuleCount = limits.ruleCount?.max || 64;
  const contextMenuActions = new Set(config.topicCardContextMenuActions || []);
  const navigationItems = new Set(config.topicNavigationItems || []);
  const actionRailItems = new Set(config.actionRailItems || []);
  const ruleGroupKeys = (config.topicRuleGroups || []).map((group) => group.key);
  const allowedCustomCssProperties = new Set([
    "accent-color",
    "background",
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "border",
    "border-color",
    "border-radius",
    "border-style",
    "border-width",
    "box-shadow",
    "color",
    "filter",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "gap",
    "height",
    "letter-spacing",
    "line-height",
    "margin",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "object-fit",
    "opacity",
    "overflow",
    "padding",
    "text-align",
    "text-decoration",
    "text-overflow",
    "transform",
    "width",
    "white-space",
    "-webkit-backdrop-filter",
    "backdrop-filter"
  ]);
  const forbiddenCustomCssValue = /url\s*\(|image-set\s*\(|@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i;

  // CSSOM 会把 margin、padding、border-radius 这类简写展开成长属性，白名单校验按作者书写的属性名进行
  function declaredProperties(cssText) {
    const open = cssText.indexOf("{");
    const close = cssText.lastIndexOf("}");
    if (open < 0 || close <= open) {
      return [];
    }
    const result = [];
    cssText.slice(open + 1, close).split(";").forEach((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) {
        return;
      }
      const property = declaration.slice(0, separator).trim().toLowerCase();
      if (!property) {
        return;
      }
      result.push({ property, value: declaration.slice(separator + 1).trim() });
    });
    return result;
  }
  const booleanKeys = [
    "wallpaperThemeColor",
    "useGradientThemeColorBackground",
    "liquidSegmentIndicatorEnabled",
    "frostedGlassEnabled",
    "sidebarCoverBlurEnabled",
    "userCardCoverMaskEnabled",
    "removeChinesePunctuationIndent",
    "customCssEnabled",
    "showTopicAvatar",
    "showTopicAuthor",
    "showTopicCategory",
    "showTopicExcerpt",
    "showTopicTags",
    "showTopicMeta",
    "showTopicActivityTime",
    "showTopicReplies",
    "showTopicLikes",
    "showTopicViews",
    "showTopicUnreadState",
    "showTopicPinnedState",
    "showTopicWatchedState",
    "topicNavigationSticky",
    "showTopicNavigationCounts",
    "headerVisible",
    "autoHideHeader",
    "autoHideSidebar",
    "showSettingsTrigger",
    "showThemeToggle",
    "siteLogoVisible",
    "siteLogoOutline",
    "siteLogoGlow",
    "actionRailEnabled",
    "actionRailGlow",
    "showBackToTopButton",
    "showRefreshButton",
    "separateNavigationActions",
    "enableUndoRefresh",
    "drawerCloseOnOverlay",
    "drawerCloseOnEscape",
    "topicFilterEnabled",
    "topicFilterHideLv1",
    "topicFilterHideLv2",
    "topicFilterHideLv3",
    "topicFilterBinEnabled",
    "searchHistoryEnabled",
    "searchHistoryPanelEnabled",
    "searchRecommendationEnabled",
    "searchFocusDimming",
    "searchFocusBlur",
    "enableHorizontalNavigationScroll",
    "showHomeButtonInTouchMode",
    "shortcutsEnabled",
    "syncEnabled"
  ];
  const rangedKeys = [
    "maskOpacity",
    "blurPx",
    "cardOpacity",
    "surfaceBlurPx",
    "userCardCoverMaskOpacity",
    "shadowHeight",
    "cardMinSize",
    "cardSideGutter",
    "gridGap",
    "topicFilterMaxAgeDays"
  ];
  const textKeys = ["fontFamily", "customCss", "webdavUsername", "webdavPassword"];
  const textLimits = {
    fontFamily: limits.fontFamily?.maxLength,
    customCss: limits.customCss?.maxLength,
    webdavUsername: limits.webdavUsername?.maxLength,
    webdavPassword: limits.webdavPassword?.maxLength
  };
  const enumKeys = Object.keys(enums).filter((key) => key !== "wallpaperRemoteCacheDays");

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function clone(value) {
    if (Array.isArray(value)) {
      return value.map(clone);
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    }
    return value;
  }

  function defaultSettings() {
    return clone(defaults);
  }

  function text(value, fallback = "", maxLength = Infinity) {
    const result = String(value ?? fallback).trim();
    return result.slice(0, maxLength);
  }

  function boolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function bounded(value, limit, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(limit.max, Math.max(limit.min, number));
  }

  function enumValue(key, value) {
    const allowed = enums[key] || [];
    return allowed.includes(value) ? value : defaults[key];
  }

  function safeWebdavUrl(value) {
    const input = text(value, "", limits.webdavUrl?.maxLength || 2048);
    if (!input) {
      return "";
    }
    try {
      const url = new URL(input);
      if (url.protocol === "https:") {
        return url.href;
      }
      // http 只允许环回地址，避免凭据在公网明文传输
      const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      return loopback ? url.href : "";
    } catch {
      return "";
    }
  }

  function webdavUrlAllowed(value) {
    const input = text(value);
    return !input || Boolean(safeWebdavUrl(input));
  }

  function safeHttpsUrl(value) {
    const input = text(value);
    if (!input) {
      return "";
    }
    try {
      const url = new URL(input);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function safeColor(value, fallback) {
    const color = text(value);
    return /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color) ? color : fallback;
  }

  function safeFontFamily(value, fallback) {
    const family = text(value, fallback, textLimits.fontFamily || 200);
    return /[;{}()/:\\]/.test(family) ? fallback : family;
  }

  function safeTime(value, fallback) {
    const time = text(value);
    const match = time.match(/^(\d{2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      return fallback;
    }
    return time;
  }

  function safeDate(value) {
    const date = text(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  }

  function normalizeRules(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value.slice(0, maxRuleCount)) {
      if (!isPlainObject(item)) {
        continue;
      }
      const keyword = text(item.keyword, "", limits.ruleKeyword?.maxLength || 200);
      if (!keyword) {
        continue;
      }
      const identity = keyword.toLocaleLowerCase();
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      result.push({
        keyword,
        remark: text(item.remark, "", limits.ruleRemark?.maxLength || 200)
      });
    }
    return result;
  }

  function normalizeGridColumns(value) {
    const source = isPlainObject(value) ? value : {};
    const result = {};
    for (const key of Object.keys(config.gridBreakpoints || defaults.gridColumns || {})) {
      const fallback = Number(defaults.gridColumns?.[key] || 1);
      result[key] = Math.round(bounded(source[key], limits.gridColumn, fallback));
    }
    return result;
  }

  function normalizeOrderedConfig(value, allowed, fallback) {
    if (!Array.isArray(value)) {
      return clone(fallback);
    }
    const seen = new Set();
    const result = value
      .filter((item) => isPlainObject(item) && allowed.has(item.key) && !seen.has(item.key) && seen.add(item.key))
      .map((item, index) => ({
        key: item.key,
        visible: boolean(item.visible, true),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index
      }))
      .sort((left, right) => left.order - right.order);
    if (!result.length) {
      return clone(fallback);
    }
    // 新增的配置项按默认值补齐：否则已经保存过这份配置的用户永远看不到后来加的入口
    for (const item of clone(fallback)) {
      if (!seen.has(item.key)) {
        result.push(item);
      }
    }
    return result.sort((left, right) => left.order - right.order);
  }

  function normalizeNavigationConfig(value) {
    const fallback = clone(defaults.topicNavigationConfig);
    if (!Array.isArray(value)) {
      return fallback;
    }
    const seen = new Set();
    const result = value
      .filter((item) => isPlainObject(item) && navigationItems.has(item.id) && !seen.has(item.id) && seen.add(item.id))
      .map((item, index) => ({
        id: item.id,
        visible: boolean(item.visible, true),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index
      }))
      .sort((left, right) => left.order - right.order);
    if (!result.length) {
      return fallback;
    }
    if (!result.some((item) => item.visible)) {
      result[0].visible = true;
    }
    return result;
  }

  function normalizeSearchHistory(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const maxItems = limits.searchHistory?.maxItems || 50;
    const maxLength = limits.searchHistory?.maxLength || 200;
    const seen = new Set();
    return value
      .map((item) => text(item, "", maxLength))
      .filter((item) => item && !seen.has(item.toLocaleLowerCase()) && seen.add(item.toLocaleLowerCase()))
      .slice(0, maxItems);
  }

  function normalizeShortcuts(value) {
    const source = isPlainObject(value) ? value : {};
    const maxLength = limits.shortcut?.maxLength || 24;
    return {
      refreshTopics: text(source.refreshTopics, defaults.shortcuts.refreshTopics, maxLength),
      openSettings: text(source.openSettings, defaults.shortcuts.openSettings, maxLength),
      toggleListControls: text(source.toggleListControls, defaults.shortcuts.toggleListControls, maxLength)
    };
  }

  function normalizeShadowCurve(value) {
    const source = Array.isArray(value) ? value : [];
    const fallback = Array.isArray(defaults.shadowCurve) ? defaults.shadowCurve : [
      { position: 0, opacity: 0.12 },
      { position: 0.5, opacity: 0.08 },
      { position: 1, opacity: 0 }
    ];
    const opacityLimit = limits.shadowCurveOpacity || { min: 0, max: 1 };
    return [0, 0.5, 1].map((position, index) => {
      const candidate = source.find((item) => Number(item?.position) === position) || source[index] || fallback[index];
      return {
        position,
        opacity: Math.min(opacityLimit.max, Math.max(opacityLimit.min, Number.isFinite(Number(candidate?.opacity)) ? Number(candidate.opacity) : fallback[index].opacity))
      };
    });
  }

  function normalizeSettings(value) {
    const source = isPlainObject(value) ? value : {};
    const result = defaultSettings();
    const legacyWallpaper = text(source.wallpaper, defaults.wallpaper);
    const validModes = Object.values(modes);
    let wallpaperMode = validModes.includes(source.wallpaperMode)
      ? source.wallpaperMode
      : (legacyWallpaper ? modes.url : defaults.wallpaperMode);
    let wallpaperId = text(source.wallpaperId, defaults.wallpaperId);
    const wallpaperUrl = safeHttpsUrl(source.wallpaperUrl || (wallpaperMode === modes.url ? legacyWallpaper : ""));

    if (wallpaperMode === modes.random) {
      wallpaperId = config.wallpaperCatalog.find((item) => item.mode === modes.random)?.id || "";
    } else if (wallpaperMode === modes.builtin && !config.wallpaperCatalog.some((item) => item.id === wallpaperId && item.mode === modes.builtin)) {
      wallpaperMode = modes.none;
      wallpaperId = "";
    } else if (wallpaperMode !== modes.builtin) {
      wallpaperId = "";
    }

    result.wallpaper = legacyWallpaper;
    result.wallpaperMode = wallpaperMode;
    result.wallpaperId = wallpaperId;
    result.wallpaperUrl = wallpaperUrl;
    result.wallpaperLocalId = text(source.wallpaperLocalId, defaults.wallpaperLocalId, 120);
    result.wallpaperRandomDate = safeDate(source.wallpaperRandomDate);
    result.wallpaperRandomUrl = safeHttpsUrl(source.wallpaperRandomUrl);
    const cacheDays = Number(source.wallpaperRemoteCacheDays);
    result.wallpaperRemoteCacheDays = (config.settingsEnums.wallpaperRemoteCacheDays || []).includes(cacheDays)
      ? cacheDays
      : defaults.wallpaperRemoteCacheDays;
    result.settingsVersion = Number(defaults.settingsVersion);

    for (const key of enumKeys) {
      if (Object.prototype.hasOwnProperty.call(defaults, key)) {
        result[key] = enumValue(key, source[key]);
      }
    }
    for (const key of booleanKeys) {
      result[key] = boolean(source[key], defaults[key]);
    }
    for (const key of rangedKeys) {
      result[key] = bounded(source[key], limits[key], defaults[key]);
      if (key === "cardMinSize" || key === "cardSideGutter" || key === "gridGap" || key === "shadowHeight" || key === "topicFilterMaxAgeDays") {
        result[key] = Number(result[key].toFixed(key === "shadowHeight" ? 1 : 0));
      }
    }
    for (const key of textKeys) {
      result[key] = key === "fontFamily"
        ? safeFontFamily(source[key], defaults[key])
        : text(source[key], defaults[key], textLimits[key]);
    }

    result.themeScheduleStart = safeTime(source.themeScheduleStart, defaults.themeScheduleStart);
    result.themeScheduleEnd = safeTime(source.themeScheduleEnd, defaults.themeScheduleEnd);
    result.themeColor = safeColor(source.themeColor, defaults.themeColor);
    result.darkModeBaseColor = safeColor(source.darkModeBaseColor, defaults.darkModeBaseColor);
    result.gridColumns = normalizeGridColumns(source.gridColumns);
    result.shadowCurve = normalizeShadowCurve(source.shadowCurve);
    result.topicNavigationConfig = normalizeNavigationConfig(source.topicNavigationConfig);
    result.actionRailItemsConfig = normalizeOrderedConfig(source.actionRailItemsConfig, actionRailItems, defaults.actionRailItemsConfig);
    result.topicCardContextMenuConfig = normalizeOrderedConfig(source.topicCardContextMenuConfig, contextMenuActions, defaults.topicCardContextMenuConfig);
    ruleGroupKeys.forEach((key) => {
      result[key] = normalizeRules(source[key]);
    });
    result.shortcuts = normalizeShortcuts(source.shortcuts);
    result.searchPageWallpaperId = text(source.searchPageWallpaperId, defaults.searchPageWallpaperId, 120);
    result.searchPageWallpaperUrl = safeHttpsUrl(source.searchPageWallpaperUrl);
    result.webdavUrl = safeWebdavUrl(source.webdavUrl);
    result.searchHistory = normalizeSearchHistory(source.searchHistory);

    return result;
  }

  function validateCustomCss(value) {
    const css = text(value, "", limits.customCss?.maxLength || 64 * 1024);
    if (!css) {
      return { valid: true, css, errors: [] };
    }
    if (forbiddenCustomCssValue.test(css)) {
      return { valid: false, css, errors: ["自定义 CSS 包含外部资源或脚本表达式"] };
    }
    if (!globalThis.document?.implementation?.createHTMLDocument) {
      return { valid: false, css, errors: ["当前页面不支持 CSSOM 校验"] };
    }

    const errors = [];
    try {
      const detachedDocument = document.implementation.createHTMLDocument("betterLD custom CSS");
      const style = detachedDocument.createElement("style");
      style.textContent = css;
      detachedDocument.head.append(style);
      const rules = style.sheet?.cssRules;
      if (!rules?.length) {
        errors.push("自定义 CSS 没有可解析的规则");
      }
      for (const rule of rules || []) {
        if (rule.type !== 1) {
          errors.push("只允许普通 CSS 规则，不允许 at-rule");
          continue;
        }
        const selectors = String(rule.selectorText || "").split(",").map((item) => item.trim()).filter(Boolean);
        if (!selectors.length) {
          errors.push("CSS 选择器为空");
          continue;
        }
        for (const selector of selectors) {
          if (!/(?:\.betterld-[\w-]+|\[data-betterld-[\w-]+(?:[~|^$*]?=|\]))/i.test(selector)) {
            errors.push("每个选择器必须包含 betterLD 命名空间");
          }
          if (selector.includes("*") || /\b(?:html|body)\b|:root/i.test(selector)) {
            errors.push("选择器不能包含通配符、html、body 或 :root");
          }
        }
        for (const { property, value } of declaredProperties(rule.cssText)) {
          if (!allowedCustomCssProperties.has(property)) {
            errors.push(`不允许的 CSS 属性：${property}`);
          }
          if (forbiddenCustomCssValue.test(value)) {
            errors.push(`CSS 属性值包含禁止内容：${property}`);
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "自定义 CSS 解析失败");
    }
    return { valid: errors.length === 0, css, errors: [...new Set(errors)] };
  }

  function validateSettings(value) {
    const settings = normalizeSettings(value);
    const errors = [];
    const css = validateCustomCss(settings.customCss);
    if (settings.customCssEnabled && !css.valid) {
      errors.push(...css.errors);
    }
    errors.push(...validateRuleArrays(settings));
    return { valid: errors.length === 0, settings, errors };
  }

  function validateRuleArrays(value) {
    const errors = [];
    const matchMode = value.topicFilterMatchMode ?? defaults.topicFilterMatchMode;
    ruleGroupKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return;
      }
      if (!Array.isArray(value[key])) {
        errors.push(`${key} 必须是数组`);
        return;
      }
      value[key].forEach((item, index) => {
        if (!isPlainObject(item) || !text(item.keyword)) {
          errors.push(`${key}[${index}] 的关键词不能为空`);
          return;
        }
        if (matchMode === "regex") {
          try {
            new RegExp(text(item.keyword));
          } catch (error) {
            errors.push(`${key}[${index}] 不是合法的正则表达式`);
          }
        }
      });
    });
    return errors;
  }

  function normalizeImportedSettings(value, current = defaults) {
    if (!isPlainObject(value)) {
      throw new Error("设置文件必须是 JSON 对象");
    }
    const knownKeys = new Set(Object.keys(defaults));
    const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key) && key !== "schema" && key !== "exportedAt");
    const sourceVersion = Number(value.settingsVersion);
    const warnings = [];
    if (Number.isFinite(sourceVersion) && sourceVersion > defaults.settingsVersion) {
      warnings.push(`设置文件版本 ${sourceVersion} 高于当前版本 ${defaults.settingsVersion}`);
    }
    const settings = normalizeSettings({ ...normalizeSettings(current), ...value });
    const validation = validateSettings(settings);
    const webdavErrors = text(value.webdavUrl) && !webdavUrlAllowed(value.webdavUrl)
      ? ["WebDAV 地址无效：只接受 https:// 地址，http:// 仅允许本机地址"]
      : [];
    const ruleErrors = validateRuleArrays(value);
    const errors = [...webdavErrors, ...ruleErrors, ...validation.errors];
    const rejectedKeys = [];
    if (!validation.valid) {
      rejectedKeys.push("customCss");
    }
    ruleGroupKeys.forEach((key) => {
      if (ruleErrors.some((error) => error.startsWith(`${key} `) || error.startsWith(`${key}[`))) {
        rejectedKeys.push(key);
      }
    });
    return {
      settings,
      unknownKeys,
      warnings,
      rejectedKeys,
      errors: [...new Set(errors)]
    };
  }

  function cloneForSync(value) {
    return clone(value);
  }

  function toSyncSettings(value) {
    const settings = normalizeSettings(value);
    const excluded = new Set([
      "wallpaperLocalId",
      "wallpaperRandomDate",
      "wallpaperRandomUrl",
      "searchHistory",
      "webdavPassword"
    ]);
    const result = {};
    for (const [key, item] of Object.entries(settings)) {
      if (!excluded.has(key)) {
        result[key] = cloneForSync(item);
      }
    }
    if (settings.wallpaperMode === modes.local) {
      result.wallpaperMode = modes.none;
      result.wallpaperId = "";
      result.wallpaperUrl = "";
      result.localWallpaperOmitted = true;
    }
    return result;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(",")}]`;
    }
    if (isPlainObject(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  globalThis.BETTERLD_SETTINGS = Object.freeze({
    defaultSettings,
    normalizeSettings,
    normalizeImportedSettings,
    normalizeRules,
    webdavUrlAllowed,
    validateCustomCss,
    validateSettings,
    toSyncSettings,
    stableStringify,
    settingKeys: Object.freeze(Object.keys(defaults)),
    allowedCustomCssProperties: Object.freeze([...allowedCustomCssProperties])
  });
})();
