(() => {
  "use strict";

  const config = globalThis.BETTERLD_CONFIG;

  function relativeLuminance(rgb) {
    const linear = rgb.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function wallpaperPrimary(settings, wallpaperColor) {
    const dark = document.documentElement.dataset.betterldMode === "dark";
    const background = dark ? hexToRgb(settings.darkModeBaseColor).split(" ").map(Number) : [255, 255, 255];
    const base = relativeLuminance(background);
    const rgb = [...wallpaperColor];
    const target = dark ? 255 : 0;
    // 逐步调整亮度，保留壁纸色相并保证强调文本的对比度。
    while (true) {
      const luminance = relativeLuminance(rgb);
      if ((Math.max(base, luminance) + 0.05) / (Math.min(base, luminance) + 0.05) >= 4.5 || rgb.every((channel) => channel === target)) break;
      rgb.forEach((channel, index) => { rgb[index] = channel + Math.sign(target - channel); });
    }
    return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  function themeFromValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return "";
    }
    if (/(?:^|[-_\s])dark(?:$|[-_\s])/.test(normalized) || /(?:^|[-_\s])dark-mode(?:$|[-_\s])/.test(normalized)) {
      return "dark";
    }
    if (/(?:^|[-_\s])light(?:$|[-_\s])/.test(normalized) || /(?:^|[-_\s])light-mode(?:$|[-_\s])/.test(normalized)) {
      return "light";
    }
    return "";
  }

  function computedThemeValue(element) {
    const scheme = element ? getComputedStyle(element).colorScheme.trim().toLowerCase() : "";
    return scheme === "dark" || scheme === "light" ? scheme : "";
  }

  function hexToRgb(value) {
    const color = String(value || "").trim().replace("#", "");
    if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) {
      return "";
    }
    const expanded = color.length === 3 ? color.split("").map((part) => part + part).join("") : color;
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)).join(" ");
  }

  function contrastColor(value) {
    const rgb = hexToRgb(value).split(" ").map(Number);
    if (rgb.length !== 3 || rgb.some((part) => !Number.isFinite(part))) {
      return "#ffffff";
    }
    return relativeLuminance(rgb) > 0.179 ? "#000000" : "#ffffff";
  }

  function scheduledMode(settings) {
    const start = String(settings.themeScheduleStart || "18:00").split(":").map(Number);
    const end = String(settings.themeScheduleEnd || "07:00").split(":").map(Number);
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = start[0] * 60 + start[1];
    const endMinutes = end[0] * 60 + end[1];
    const inRange = startMinutes <= endMinutes
      ? minutes >= startMinutes && minutes <= endMinutes
      : minutes >= startMinutes || minutes <= endMinutes;
    return inRange ? "dark" : "light";
  }

  function setThemeProperty(name, value) {
    const style = document.documentElement.style;
    if (style.getPropertyValue(name) === value) return;
    if (value) style.setProperty(name, value);
    else style.removeProperty(name);
  }

  function applyThemeTokens(settings, wallpaperColor) {
    const root = document.documentElement;
    const fromWallpaper = settings.wallpaperThemeColor && wallpaperColor;
    const primary = fromWallpaper ? wallpaperPrimary(settings, wallpaperColor) : settings.themeColor;
    root.dataset.betterldWallpaperColor = fromWallpaper ? "ready" : "manual";
    const background = settings.darkModeBaseColor;
    const primaryRgb = hexToRgb(primary);
    const backgroundRgb = hexToRgb(background);
    if (primaryRgb) {
      setThemeProperty("--betterld-primary", primary);
      setThemeProperty("--betterld-primary-rgb", primaryRgb.split(" ").join(", "));
      setThemeProperty("--betterld-on-primary", contrastColor(primary));
    }
    if (root.dataset.betterldMode === "dark" && backgroundRgb) {
      setThemeProperty("--betterld-background-rgb", backgroundRgb);
    } else {
      setThemeProperty("--betterld-background-rgb", "");
    }
    if (settings.useGradientThemeColorBackground && primary) {
      setThemeProperty("--betterld-default-wallpaper", `radial-gradient(circle at 18% 12%, color-mix(in srgb, ${primary} 42%, transparent), transparent 34%), radial-gradient(circle at 86% 84%, color-mix(in srgb, ${primary} 30%, transparent), transparent 38%), linear-gradient(135deg, color-mix(in srgb, ${primary} 26%, rgb(var(--betterld-background-rgb))), rgb(var(--betterld-background-rgb)))`);
    } else {
      setThemeProperty("--betterld-default-wallpaper", "");
    }
  }

  function applyColorMode(settings, wallpaperColor) {
    const root = document.documentElement;
    const body = document.body;
    const explicitValues = [
      root.dataset.colorScheme,
      body?.dataset.colorScheme,
      root.dataset.theme,
      body?.dataset.theme,
      root.dataset.themeName,
      body?.dataset.themeName,
      root.className,
      body?.className
    ];
    const explicitMode = explicitValues.map(themeFromValue).find(Boolean) || "";
    const computedMode = [computedThemeValue(root), computedThemeValue(body)]
      .map(themeFromValue)
      .find(Boolean) || "";
    const prefersDark = Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    const configuredMode = settings?.themeMode || "auto";
    const detectedMode = explicitMode || computedMode || (prefersDark ? "dark" : "light");
    const mode = configuredMode === "light" || configuredMode === "dark"
      ? configuredMode
      : configuredMode === "system"
        ? (prefersDark ? "dark" : "light")
        : configuredMode === "scheduled"
          ? scheduledMode(settings)
          : detectedMode;
    if (root.dataset.betterldMode !== mode) root.dataset.betterldMode = mode;
    applyThemeTokens(settings, wallpaperColor);
  }

  function userPageAppearance(settings) {
    const match = location.pathname.match(/^\/u\/[^/]+\/(.*)/);
    if (!match) return "";
    const path = match[1].replace(/\/+$/, "");
    const entry = config.userPageAppearances.find((item) => item.path === path
      || (item.path === "messages" && path.startsWith("messages/")));
    return entry ? settings[entry.key] : "";
  }

  function applyUserPageAppearance(settings) {
    const mode = userPageAppearance(settings);
    const root = document.documentElement;
    if (mode) root.dataset.betterldUserPageAppearance = mode;
    else delete root.dataset.betterldUserPageAppearance;
  }

  // 首屏与即时设置共用同一份 Token 投影；这里不扫描或增强原站内容。
  function apply(settings, wallpaperColor) {
    applyUserPageAppearance(settings);
    const root = document.documentElement;
    const materialSupported = Boolean(
      globalThis.CSS?.supports?.("backdrop-filter", "blur(1px)")
      || globalThis.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)")
    );
    root.dataset.betterldMaterial = materialSupported ? "ready" : "fallback";
    root.dataset.betterldShadowMode = settings.shadowMode;
    root.dataset.betterldFrostedGlass = String(settings.frostedGlassEnabled);
    root.dataset.betterldShowTopicAvatar = String(settings.showTopicAvatar);
    root.dataset.betterldShowTopicAuthor = String(settings.showTopicAuthor);
    root.dataset.betterldShowTopicCategory = String(settings.showTopicCategory);
    root.dataset.betterldShowTopicExcerpt = String(settings.showTopicExcerpt);
    root.dataset.betterldShowTopicTags = String(settings.showTopicTags);
    root.dataset.betterldShowTopicMeta = String(settings.showTopicMeta);
    root.dataset.betterldShowTopicActivityTime = String(settings.showTopicActivityTime);
    root.dataset.betterldShowTopicReplies = String(settings.showTopicReplies);
    root.dataset.betterldShowTopicLikes = String(settings.showTopicLikes);
    root.dataset.betterldShowTopicViews = String(settings.showTopicViews);
    root.dataset.betterldShowTopicUnreadState = String(settings.showTopicUnreadState);
    root.dataset.betterldShowTopicPinnedState = String(settings.showTopicPinnedState);
    root.dataset.betterldShowTopicWatchedState = String(settings.showTopicWatchedState);
    root.dataset.betterldTopicTitleSize = settings.topicTitleFontSize;
    root.dataset.betterldTopicAuthorSize = settings.topicAuthorFontSize;
    root.dataset.betterldTopicMetaSize = settings.topicMetaFontSize;
    root.dataset.betterldFontScope = settings.fontScope;
    root.dataset.betterldRemovePunctuationIndent = String(settings.removeChinesePunctuationIndent);
    const fontFamily = settings.fontMode === "recommended"
      ? config.fontRecommendedStack
      : settings.fontMode === "custom"
        ? settings.fontFamily
        : "";
    if (fontFamily) {
      root.style.setProperty("--betterld-font-family", fontFamily);
    } else {
      root.style.removeProperty("--betterld-font-family");
    }
    root.style.setProperty("--betterld-mask-opacity", String(settings.maskOpacity));
    root.style.setProperty("--betterld-background-blur", `${settings.blurPx}px`);
    root.style.setProperty("--betterld-card-opacity", String(settings.cardOpacity));
    root.style.setProperty("--betterld-reading-panel-alpha", String(settings.readingPanelBackgroundOpacity));
    root.style.setProperty("--betterld-card-motion", `${config.topicCardMotion.durationMs}ms ${config.topicCardMotion.easing}`);
    root.style.setProperty("--betterld-card-hover-spread", `${config.topicCardMotion.spreadPx}px`);
    root.style.setProperty("--betterld-card-hover-opacity", String(config.topicCardMotion.hoverOpacity));
    root.style.setProperty("--betterld-card-active-opacity", String(config.topicCardMotion.activeOpacity));
    root.style.setProperty("--betterld-topic-list-max-width", `${config.topicListMaxWidthPx}px`);
    root.style.setProperty("--betterld-topic-detail-width", `${config.topicDetailWidthPercent}%`);
    root.style.setProperty("--betterld-topic-detail-max-width", `${config.topicDetailMaxWidthPx}px`);
    root.style.setProperty("--betterld-reply-author-name-max-width", `${config.replyTreeAuthorNameMaxWidthEm}em`);
    root.style.setProperty("--betterld-topic-timeline-space", `${config.topicTimelineSpacePx}px`);
    root.style.setProperty("--betterld-surface-blur", settings.frostedGlassEnabled ? `${settings.surfaceBlurPx}px` : "0px");
    root.style.setProperty("--betterld-header-blur-fade", `${config.headerBlurFadePx}px`);
    root.style.setProperty("--betterld-sidebar-top-gap", `${config.sidebarTopGapPx}px`);
    root.style.setProperty("--betterld-user-card-cover-mask-opacity", settings.userCardCoverMaskEnabled ? String(settings.userCardCoverMaskOpacity) : "0");
    root.style.setProperty("--betterld-shadow-level-2", `0 ${2 * settings.shadowHeight}px 6px rgb(var(--betterld-shadow-color) / 0.10), 0 ${12 * settings.shadowHeight}px 28px rgb(var(--betterld-shadow-color) / 0.16)`);
    root.style.setProperty("--betterld-shadow-level-2-hover", `0 ${4 * settings.shadowHeight}px 10px rgb(var(--betterld-shadow-color) / 0.12), 0 ${18 * settings.shadowHeight}px 36px rgb(var(--betterld-shadow-color) / 0.20)`);
    if (settings.shadowMode === "custom") {
      const curve = settings.shadowCurve || [];
      const blurSizes = [12, 28, 56];
      const offsets = [4, 12, 28].map((offset) => offset * settings.shadowHeight);
      const shadow = curve.map((point, index) => `0 ${offsets[index]}px ${blurSizes[index]}px rgb(var(--betterld-shadow-color) / ${point.opacity})`).join(", ");
      root.style.setProperty("--betterld-card-shadow", shadow);
    } else {
      root.style.removeProperty("--betterld-card-shadow");
    }
    applyColorMode(settings, wallpaperColor);
  }

  globalThis.BETTERLD_APPEARANCE = Object.freeze({ apply, applyColorMode, applyThemeTokens, userPageAppearance, applyUserPageAppearance });
})();
