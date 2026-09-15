(() => {
  "use strict";

  function safeHref(value) {
    const input = String(value || "").trim();
    if (!input || input.startsWith("javascript:") || input.startsWith("data:")) {
      return "";
    }
    if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(input)) {
      try {
        return new URL(input, location.href).href;
      } catch {
        return "";
      }
    }
    try {
      const url = new URL(input, location.href);
      return ["https:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function appendInline(parent, source) {
    const value = String(source || "");
    let index = 0;
    while (index < value.length) {
      const remainder = value.slice(index);
      if (value[index] === "`") {
        const end = value.indexOf("`", index + 1);
        if (end > index + 1) {
          const code = document.createElement("code");
          code.textContent = value.slice(index + 1, end);
          parent.append(code);
          index = end + 1;
          continue;
        }
      }

      if (value[index] === "[") {
        const match = remainder.match(/^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/);
        const href = match ? safeHref(match[2]) : "";
        if (match && href) {
          const link = document.createElement("a");
          link.href = href;
          link.textContent = match[1];
          parent.append(link);
          index += match[0].length;
          continue;
        }
      }

      const emphasis = [
        ["**", "strong"],
        ["__", "strong"],
        ["*", "em"],
        ["_", "em"]
      ].find(([delimiter]) => value.startsWith(delimiter, index));
      if (emphasis) {
        const [delimiter, tagName] = emphasis;
        const end = value.indexOf(delimiter, index + delimiter.length);
        const content = value.slice(index + delimiter.length, end);
        if (end > index + delimiter.length && content.trim()) {
          const element = document.createElement(tagName);
          appendInline(element, content);
          parent.append(element);
          index = end + delimiter.length;
          continue;
        }
      }

      const next = remainder.search(/[`[*_]/);
      const length = next < 0 ? remainder.length : Math.max(next, 1);
      parent.append(document.createTextNode(value.slice(index, index + length)));
      index += length;
    }
  }

  function listMatch(line) {
    const match = String(line || "").match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (!match) {
      return null;
    }
    return {
      ordered: Boolean(match[2]),
      start: match[2] || "",
      text: match[3]
    };
  }

  function blockStart(line) {
    return Boolean(String(line || "").match(/^\s*(?:#{1,6}\s+|`{3,}|~{3,}|>\s?|(?:[-+*]\s+|\d+[.)]\s+))/));
  }

  function renderBlocks(container, source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const size = fence[1].length;
        const codeLines = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${marker}{${size},}\\s*$`).test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const language = fence[2].replace(/[^\w-]/g, "");
        if (language) {
          code.className = `language-${language}`;
        }
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const element = document.createElement(`h${heading[1].length}`);
        appendInline(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        const quote = document.createElement("blockquote");
        const paragraph = document.createElement("p");
        appendInline(paragraph, quoteLines.join("\n"));
        quote.append(paragraph);
        container.append(quote);
        continue;
      }

      const firstList = listMatch(line);
      if (firstList) {
        const list = document.createElement(firstList.ordered ? "ol" : "ul");
        if (firstList.ordered && firstList.start) {
          list.setAttribute("start", firstList.start);
        }
        while (index < lines.length) {
          const item = listMatch(lines[index]);
          if (!item || item.ordered !== firstList.ordered) {
            break;
          }
          const listItem = document.createElement("li");
          appendInline(listItem, item.text);
          list.append(listItem);
          index += 1;
        }
        container.append(list);
        continue;
      }

      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      appendInline(paragraph, paragraphLines.join("\n"));
      container.append(paragraph);
    }
  }

  function render(container, source) {
    if (!container || typeof container.replaceChildren !== "function") {
      throw new TypeError("Markdown target is unavailable");
    }
    container.replaceChildren();
    if (String(source || "").trim()) {
      renderBlocks(container, source);
    }
  }

  globalThis.BETTERLD_MARKDOWN = Object.freeze({ render });
})();
