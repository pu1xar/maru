// The offline screen (DESIGN.md 2e): what failed, when the main process tries again (it does on its
// own, with a growing pause), and a way to try now or to pair again.
const shell = window.maruShell;
const $ = (id) => document.getElementById(id);
let state = null;

function tick() {
  if (!state || state.page !== "offline") return;
  if (state.retryAt === null) {
    $("retry").textContent = "Retrying";
    return;
  }
  const s = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
  $("retry").textContent = `Retrying in ${s}s`;
}

function render(next) {
  if (next.page !== "offline") return;
  state = next;
  $("version").textContent = `maru ${next.version}`;
  $("server").textContent = next.server;
  $("error").textContent = next.error;
  tick();
}

$("now").addEventListener("click", () => shell.retry());
$("reset").addEventListener("click", () => shell.reset());
setInterval(tick, 250);
shell.onState(render);
shell.state().then(render);
