// The pairing screen (DESIGN.md 2e). The main process checks and claims; this page only collects
// the server address and the code (or the dialog's link) and shows the answer.
const shell = window.maruShell;
const $ = (id) => document.getElementById(id);
const server = $("server");
const code = $("code");
const button = $("connect");
const error = $("error");
const notice = $("notice");

function render(state) {
  if (state.page !== "pair") return;
  $("version").textContent = `maru ${state.version}`;
  notice.hidden = !state.notice;
  notice.textContent = state.notice ?? "";
  if (state.prefill) {
    server.value = state.prefill.server;
    code.value = state.prefill.code;
    // A link filled the form: the user reads the server first, so one key press does not connect.
    server.focus();
    server.select();
  } else if (!server.value) {
    server.focus();
  }
}

// A link pasted into the code box fills the server box too.
code.addEventListener("input", () => {
  const m = /^maru:\/\/pair\/?\?(.*)$/.exec(code.value.trim());
  if (!m) return;
  const q = new URLSearchParams(m[1]);
  if (q.get("server")) server.value = q.get("server");
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  button.disabled = true;
  error.textContent = "";
  button.textContent = "Connecting";
  try {
    const r = await shell.pair(server.value, code.value);
    if (r && r.error) error.textContent = r.error;
  } catch (err) {
    error.textContent = String(err && err.message ? err.message : err);
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
});

shell.onState(render);
shell.state().then(render);
