// The HTML page the shell screen's WebView shows (DESIGN.md 6s): xterm.js and its fit addon
// inlined (xtermBundle.generated.ts), so the page opens with no network, plus a small script that
// connects the terminal to the app through bridge.ts. The page has no socket of its own: the app
// holds the /shell connection, and a content security policy lets the page load nothing but the
// monospace font's files.
import { SHELL_SCROLLBACK_LINES } from "./look.ts";
import type { PageLook } from "./bridge.ts";
import { XTERM_CSS, XTERM_FIT_JS, XTERM_JS } from "./xtermBundle.generated.ts";

/** Script text that sits inside a script element: the end tag cannot appear in it. */
export function inScript(text: string): string {
  return text.replace(/<\/(script)/gi, "<\\/$1");
}

/** JSON that sits inside a script element. */
function inScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const PAGE_CSS = `
html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;-webkit-tap-highlight-color:transparent}
#o{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;padding:4px 8px 0 8px;box-sizing:border-box}
#t{flex:1;min-width:0;min-height:0;overflow:hidden}
`;

/**
 * The page script. It reads the settings from window.__MARU_PAGE__ and exposes window.maru.recv,
 * which the app calls (bridge.ts AppMessage); everything it says goes out with
 * ReactNativeWebView.postMessage (PageMessage). It is plain ES2017 text, run by the WebView and by
 * the headless check (shell/page.test.mts), and holds no backtick or dollar-brace.
 */
export const PAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var cfg = window.__MARU_PAGE__;
  function post(m) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {}
  }
  window.addEventListener("error", function (e) { post({ t: "error", message: String(e && e.message ? e.message : e) }); });

  var box = document.getElementById("t");
  var faces = document.getElementById("faces");
  var term = new Terminal({
    scrollback: cfg.scrollback,
    fontFamily: cfg.look.fontFamily,
    fontSize: cfg.look.fontSize,
    theme: cfg.look.theme,
    cursorBlink: true,
    allowProposedApi: false,
    macOptionIsMeta: false
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);

  function paint(look) {
    document.documentElement.style.background = look.theme.background;
    document.body.style.background = look.theme.background;
  }
  paint(cfg.look);

  function refit() {
    if (!box.clientWidth || !box.clientHeight) return false;
    try { fit.fit(); } catch (e) { return false; }
    return true;
  }

  var readySent = false;
  function maybeReady() {
    if (readySent || !refit()) return;
    readySent = true;
    post({ t: "ready", cols: term.cols, rows: term.rows });
  }
  term.onResize(function (size) {
    if (readySent) post({ t: "resize", cols: size.cols, rows: size.rows });
  });
  new ResizeObserver(function () { refit(); maybeReady(); }).observe(box);
  maybeReady();

  // A font file that arrives after the first draw changes the cell size: measure again.
  function remeasure() {
    var f = term.options.fontFamily;
    term.options.fontFamily = f + " ";
    term.options.fontFamily = f;
    refit();
  }
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", remeasure);

  term.onData(function (d) { post({ t: "in", d: d }); });
  term.onBinary(function (d) { post({ t: "bin", d: d }); });

  var appCursor = false;
  function reportMode() {
    var now = !!term.modes.applicationCursorKeysMode;
    if (now !== appCursor) { appCursor = now; post({ t: "mode", appCursor: now }); }
  }

  function decode(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // A tap on the terminal asks for the keyboard.
  box.addEventListener("click", function () { term.focus(); });

  // Scrolling the history with a finger: the terminal's own viewport does not take touch drags.
  var touchY = null;
  var carry = 0;
  box.addEventListener("touchstart", function (e) {
    touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    carry = 0;
  }, { passive: true });
  box.addEventListener("touchmove", function (e) {
    if (touchY === null || e.touches.length !== 1) return;
    var y = e.touches[0].clientY;
    var rowHeight = box.clientHeight / term.rows;
    carry += (touchY - y) / rowHeight;
    touchY = y;
    var whole = carry < 0 ? Math.ceil(carry) : Math.floor(carry);
    if (whole !== 0) { term.scrollLines(whole); carry -= whole; }
  }, { passive: true });
  box.addEventListener("touchend", function () { touchY = null; }, { passive: true });

  window.maru = {
    recv: function (m) {
      if (m.t === "out") {
        term.write(decode(m.b), reportMode);
      } else if (m.t === "reset") {
        // After what is queued, so output from before the attach cannot land on the new screen.
        term.write(new Uint8Array(0), function () { term.reset(); });
      } else if (m.t === "focus") {
        term.focus();
      } else if (m.t === "paste") {
        term.paste(m.text);
      } else if (m.t === "look") {
        var look = m.look;
        if (faces.textContent !== look.faceCss) faces.textContent = look.faceCss;
        paint(look);
        term.options.theme = look.theme;
        term.options.fontFamily = look.fontFamily;
        term.options.fontSize = look.fontSize;
        refit();
      }
    }
  };
})();
`;

/** The page for a look. The look's later changes arrive as `look` messages, not as a new page. */
export function shellPageHtml(look: PageLook): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src https:; img-src data:; connect-src 'none'";
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    `<style>${XTERM_CSS}</style>`,
    `<style id="faces">${look.faceCss}</style>`,
    `<style>${PAGE_CSS}</style>`,
    `</head><body style="background:${look.theme.background}"><div id="o"><div id="t"></div></div>`,
    `<script>${inScript(XTERM_JS)}</script>`,
    `<script>${inScript(XTERM_FIT_JS)}</script>`,
    `<script>window.__MARU_PAGE__=${inScriptJson({ look, scrollback: SHELL_SCROLLBACK_LINES })};</script>`,
    `<script>${inScript(PAGE_SCRIPT)}</script>`,
    "</body></html>",
  ].join("");
}
