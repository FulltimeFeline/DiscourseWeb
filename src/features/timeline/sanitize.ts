// HTML sanitisation for `org.matrix.custom.html` message bodies. Matrix events
// can carry attacker-controlled HTML, so every formatted body runs through
// DOMPurify before it reaches `dangerouslySetInnerHTML`. Only the Matrix "safe"
// tag subset is allowed, and external links are forced to open safely.

import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "font", "del", "s", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a",
  "ul", "ol", "sup", "sub", "li", "b", "i", "u", "strong", "em", "strike", "code",
  "hr", "br", "div", "table", "thead", "tbody", "tr", "th", "td", "caption",
  "pre", "span", "img", "details", "summary", "mx-reply",
];

const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "class", "data-mx-color", "data-mx-bg-color",
  "color", "data-mx-spoiler", "start", "rel", "target", "width", "height",
];

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  // Force anchors to open in a new context without leaking the opener.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // Only mxc: images may load. A remote http(s) src is a working tracking
    // pixel — it would hand the sender our IP and exact read time, inside an
    // encrypted room. Keep the element so it degrades to its alt text.
    if (node.tagName === "IMG" && !node.getAttribute("src")?.startsWith("mxc://")) {
      node.removeAttribute("src");
    }
  });
}

export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["mx-reply"], // reply fallback rendered separately
  });
}
