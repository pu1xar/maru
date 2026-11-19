// The HTML page the diagram sheet's WebView shows (DESIGN.md 7g): the Pele renderer and DOMPurify
// inlined (peleBundle.generated.ts), so the page opens with no network, plus a small script that
// draws one diagram and tells the app whether it drew. The page loads nothing: its content
// security policy admits one script by nonce (nothing else can run, injected markup included),
// inline styles, and no connection, image, font or frame.
import { PELE_JS, PURIFY_JS } from "./peleBundle.generated.ts";
import { pageColors } from "./model.ts";
import type { Palette } from "../palette.ts";

/** Script text that sits inside a script element: the end tag cannot appear in it. */
export function inScript(text: string): string {
  return text.replace(/<\/(script)/gi, "<\\/$1");
}

/** JSON that sits inside a script element. */
function inScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The page script (plain ES5 text; it holds no backtick or dollar-brace, being inside a template string). */
export const PAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var cfg = window.__MARU_MERMAID__;
  function post(m) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {}
  }
  function failed(e) {
    post({
      t: "failed",
      code: e && typeof e.code === "string" ? e.code : "",
      line: e && typeof e.line === "number" ? e.line : 0,
      message: String(e && e.message ? e.message : e)
    });
  }
  window.addEventListener("error", function (e) { failed(e && e.error ? e.error : e); });
  var box = document.getElementById("d");
  try {
    pele.mount(box, cfg.source, {
      links: false,
      images: false,
      zoom: false,
      autoDirection: false,
      sanitize: function (svg) {
        return DOMPurify.sanitize(svg, {
          FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
          FORBID_TAGS: ["a", "image", "img", "foreignObject", "script", "style"],
          USE_PROFILES: { svg: true, svgFilters: true },
          RETURN_DOM_FRAGMENT: true
        });
      },
      onRender: function (result) {
        var svg = box.querySelector("svg");
        if (svg) svg.style.minWidth = Math.round(result.width * cfg.minScale) + "px";
        post({ t: "drawn" });
      },
      onError: failed
    });
  } catch (e) {
    failed(e);
  }
})();
`;

function randomNonce(): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) out += Math.random().toString(36).slice(2, 10);
  return out;
}

/** A diagram's narrowest width as a share of its own (web MERMAID_MIN_SCALE), then the page scrolls. */
const MIN_SCALE = 0.7;

/** The page for one diagram's Mermaid source, colored with the app palette. */
export function mermaidPageHtml(
  source: string,
  palette: Pick<Palette, "bg" | "text" | "muted" | "accent" | "danger">,
  nonce: string = randomNonce(),
): string {
  const vars = Object.entries(pageColors(palette))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const css = `
:root{${vars};--pele-font:system-ui,sans-serif;--pele-font-mono:ui-monospace,monospace}
html,body{margin:0;background:${palette.bg};color:${palette.text};-webkit-tap-highlight-color:transparent}
body{padding:12px;box-sizing:border-box}
#d{overflow-x:auto}
#d svg{display:block;margin:0 auto}
`;
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.5, maximum-scale=6, user-scalable=yes">',
    `<style>${css}</style></head>`,
    `<body><div id="d"></div>`,
    `<script nonce="${nonce}">window.__MARU_MERMAID__=${inScriptJson({ source, minScale: MIN_SCALE })};</script>`,
    `<script nonce="${nonce}">${inScript(PURIFY_JS)}</script>`,
    `<script nonce="${nonce}">${inScript(PELE_JS)}</script>`,
    `<script nonce="${nonce}">${inScript(PAGE_SCRIPT)}</script>`,
    "</body></html>",
  ].join("");
}
