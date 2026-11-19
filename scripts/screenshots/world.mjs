// The fictional world that scripts/screenshots/capture.mjs shows: a scratch HOME with two Claude
// accounts and one Codex account, three small repositories, and sessions whose conversations
// are written here. Names, paths and accounts are all made up.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Transcript } from "./claudeTranscript.mjs";
import { ACME_API, ACME_WEB, CART_AFTER, CART_BEFORE, CART_TEST, MONEY, TRAIL_NOTES } from "./repos.mjs";

const MIN = 60_000;

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

const encodeCwd = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** Write one Claude session (and its subagents) into an account folder. */
function saveClaude(dir, t, { subagents = [], registry } = {}) {
  const projDir = path.join(dir, "projects", encodeCwd(t.cwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, `${t.sessionId}.jsonl`);
  fs.writeFileSync(file, t.jsonl());
  for (const s of subagents) {
    const sub = path.join(projDir, t.sessionId, "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `agent-${s.agentId}.jsonl`), s.transcript.jsonl());
    fs.writeFileSync(path.join(sub, `agent-${s.agentId}.meta.json`), JSON.stringify(s.meta));
  }
  if (registry) {
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(dir, "sessions", `${registry.pid}.json`), JSON.stringify({
      pid: registry.pid, sessionId: t.sessionId, status: registry.status, entrypoint: "cli", cwd: t.cwd, updatedAt: now, statusUpdatedAt: now,
    }));
  }
  fs.utimesSync(file, new Date(t.clock), new Date(t.clock));
  return file;
}

/** A commit history for a repository, with a made-up author and no global or system config. */
function commitHistory(dir, messages, startMs) {
  const env = {
    PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com",
  };
  const run = (...a) => execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("add", "-A");
  messages.forEach((m, i) => {
    const date = new Date(startMs + i * 5 * 3600_000).toISOString();
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
    run("commit", "-q", "--allow-empty", "-m", m);
  });
}

// ---------------------------------------------------------------------------------------------
// Claude sessions

function cartFix(cwd, startMs) {
  const t = new Transcript({ sessionId: randomUUID(), cwd, startMs });
  const f = (rel) => path.join(cwd, rel);
  t.user("The cart total on the checkout page sometimes shows values like $10.200000000000001. Find out why and fix it, and add a regression test.");
  t.text("I'll find where the total is computed first.");
  t.grep("cartTotal", f("src"), [f("src/lib/cart.ts"), f("src/components/CartSummary.tsx"), f("src/routes/checkout.ts")]);
  t.read(f("src/lib/cart.ts"), CART_BEFORE);
  t.text([
    "Found it. `cartTotal` adds prices as floating-point dollars, and `formatTotal` prints the raw number:",
    "",
    "```ts",
    "0.1 + 0.2        // 0.30000000000000004",
    "3 * 3.4          // 10.200000000000001",
    "```",
    "",
    "I'll keep money in **integer cents** from the moment a price enters the cart, and format it only for display.",
  ].join("\n"));
  t.write(f("src/lib/money.ts"), MONEY);
  t.edit(f("src/lib/cart.ts"), CART_BEFORE, CART_AFTER, CART_BEFORE, [
    { oldStart: 1, newStart: 1, lines: [
      ' import type { CartItem } from "./types";',
      '+import { formatCents, toCents } from "./money";',
      " ",
      "-export function lineTotal(item: CartItem): number {",
      "-  return item.price * item.quantity;",
      "+export function lineTotalCents(item: CartItem): number {",
      "+  return toCents(item.price) * item.quantity;",
      " }",
      " ",
      "-export function cartTotal(items: CartItem[]): number {",
      "-  return items.reduce((sum, item) => sum + lineTotal(item), 0);",
      "+export function cartTotalCents(items: CartItem[]): number {",
      "+  return items.reduce((sum, item) => sum + lineTotalCents(item), 0);",
      " }",
      " ",
      " export function formatTotal(items: CartItem[]): string {",
      "-  return `$${cartTotal(items)}`;",
      "+  return formatCents(cartTotalCents(items));",
      " }",
    ] },
  ]);
  t.edit(f("src/routes/checkout.ts"), "cartTotal(items)", "cartTotalCents(items)", "", [
    { oldStart: 1, newStart: 1, lines: [
      '-import { cartTotal } from "../lib/cart";',
      '+import { cartTotalCents } from "../lib/cart";',
      " ",
      " export async function createCheckout(req: Request) {",
      "   const { items } = await req.json();",
      "-  return Response.json({ amount: cartTotal(items) });",
      "+  return Response.json({ amount: cartTotalCents(items) });",
      " }",
    ] },
  ]);
  t.write(f("tests/cart.test.ts"), CART_TEST);
  t.bash("pnpm vitest run tests/cart.test.ts", "Run the cart tests", [
    "",
    " RUN  v3.2.4 ~/code/acme-web",
    "",
    " ✓ tests/cart.test.ts (3 tests) 4ms",
    "   ✓ cart totals > adds prices in whole cents 1ms",
    "   ✓ cart totals > formats the total as currency 2ms",
    "   ✓ cart totals > returns $0.00 for an empty cart 0ms",
    "",
    " Test Files  1 passed (1)",
    "      Tests  3 passed (3)",
    "   Start at  10:42:18",
    "   Duration  412ms",
    "",
  ].join("\n"));
  t.text([
    "Fixed. The total is now computed in integer cents and formatted with `Intl.NumberFormat`.",
    "",
    "| File | Change |",
    "|---|---|",
    "| `src/lib/money.ts` | New: `toCents` and `formatCents` |",
    "| `src/lib/cart.ts` | Totals in cents, formatting at the edge |",
    "| `src/routes/checkout.ts` | Sends `amount` in cents to the API |",
    "| `tests/cart.test.ts` | Three regression tests |",
    "",
    "The checkout route now sends `amount` in cents, which is what the payments provider expects.",
  ].join("\n"));
  t.turnEnd();
  t.title("Fix cart total rounding");
  return t;
}

function checkoutTests(cwd, startMs, pid) {
  const t = new Transcript({ sessionId: randomUUID(), cwd, startMs, gitBranch: "test/checkout" });
  const f = (rel) => path.join(cwd, rel);
  t.user("Add tests for the checkout flow: empty cart, a cart with discounts, and a failed payment. Use subagents to read the code in parallel if it helps.");
  t.text("I'll split this into tasks and have a subagent map the checkout code while I set up the test file.");
  t.taskCreate(1, "Map the checkout code path");
  t.taskCreate(2, "Test an empty cart");
  t.taskCreate(3, "Test a cart with discounts");
  t.taskCreate(4, "Test a failed payment");
  t.taskUpdate(1, "in_progress");

  const agentId = `a${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const sub = new Transcript({ sessionId: t.sessionId, cwd, startMs: t.clock, agentId, model: "claude-sonnet-5" });
  sub.user("Map the checkout flow in this repo: entry points, where totals and discounts are computed, and how payment failures surface. Report file paths and function names.");
  sub.grep("checkout", f("src"), [f("src/routes/checkout.ts"), f("src/components/CartSummary.tsx")]);
  sub.read(f("src/routes/checkout.ts"), ACME_WEB["src/routes/checkout.ts"]);
  sub.text("Checkout enters at `createCheckout` in `src/routes/checkout.ts`, totals come from `cartTotalCents` in `src/lib/cart.ts`. There is no discount code yet, and payment errors are not handled in the web app.");
  const agentUse = t.toolUse("Agent", {
    description: "Map the checkout code path",
    subagent_type: "Explore",
    model: "sonnet",
    prompt: "Map the checkout flow in this repo: entry points, where totals and discounts are computed, and how payment failures surface. Report file paths and function names.",
  });
  t.toolResult(agentUse, [{ type: "text", text: "Checkout enters at `createCheckout` in `src/routes/checkout.ts`, totals come from `cartTotalCents` in `src/lib/cart.ts`. There is no discount code yet, and payment errors are not handled in the web app." }], {
    status: "completed", prompt: "Map the checkout flow", agentId, agentType: "Explore",
    content: [{ type: "text", text: "Checkout enters at createCheckout ..." }],
    totalDurationMs: 48_200, totalTokens: 21_480, totalToolUseCount: 6,
  }, { stepMs: 50_000 });
  t.taskUpdate(1, "completed");
  t.taskUpdate(2, "in_progress");
  t.text("There is no discount logic yet, so task 3 needs a small `applyDiscount` helper first. Starting with the empty-cart test.");
  t.write(f("tests/checkout.test.ts"), 'import { describe, expect, it } from "vitest";\nimport { createCheckout } from "../src/routes/checkout";\n\ndescribe("checkout", () => {\n  it("rejects an empty cart", async () => {\n    const res = await createCheckout(new Request("http://x", { method: "POST", body: JSON.stringify({ items: [] }) }));\n    expect(res.status).toBe(400);\n  });\n});\n');
  const agent2 = `a${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const sub2 = new Transcript({ sessionId: t.sessionId, cwd, startMs: t.clock, agentId: agent2, model: "claude-sonnet-5" });
  sub2.user("Write an applyDiscount(items, code) helper in src/lib/cart.ts with percent and fixed-amount codes, in cents. Do not touch the tests.");
  sub2.read(f("src/lib/cart.ts"), CART_AFTER);
  sub2.text("I'll add the helper next to cartTotalCents.");
  const agentUse2 = t.toolUse("Agent", {
    description: "Write the discount helper",
    subagent_type: "general-purpose",
    model: "sonnet",
    prompt: "Write an applyDiscount(items, code) helper in src/lib/cart.ts with percent and fixed-amount codes, in cents. Do not touch the tests.",
    run_in_background: true,
  });
  t.toolResult(agentUse2, [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agent2}` }], { isAsync: true, status: "async_launched", agentId: agent2, description: "Write the discount helper", prompt: "Write an applyDiscount helper", resolvedModel: "claude-sonnet-5" });
  t.toolUse("Bash", { command: "pnpm vitest run tests/checkout.test.ts", description: "Run the checkout tests" });
  t.title("Add tests for the checkout flow");
  return { t, subagents: [
    { agentId, transcript: sub, meta: { agentType: "Explore", description: "Map the checkout code path", model: "sonnet", toolUseId: agentUse, finished: true } },
    { agentId: agent2, transcript: sub2, meta: { agentType: "general-purpose", description: "Write the discount helper", model: "sonnet", toolUseId: agentUse2, finished: false } },
  ] };
}

function authPlan(cwd, startMs) {
  const t = new Transcript({ sessionId: randomUUID(), cwd, startMs });
  const f = (rel) => path.join(cwd, rel);
  t.user("Plan a refactor of the login route so rate limiting and session checks live in one middleware chain. Show me the plan before you change anything.");
  t.read(f("src/routes/login.ts"), ACME_API["src/routes/login.ts"]);
  t.read(f("src/middleware/rateLimit.ts"), ACME_API["src/middleware/rateLimit.ts"]);
  const plan = [
    "## Plan: one middleware chain for the API routes",
    "",
    "1. Add `src/middleware/chain.ts` with a `compose(...steps)` helper",
    "2. Move the rate limiter out of `login.ts` into the chain, keyed by IP and route",
    "3. Add a `requireSession` step for routes that need a login",
    "4. Register the chain once in `router.ts`",
    "5. Tests: limiter order, 429 with `Retry-After`, 401 without a session",
    "",
    "No behavior change for clients except a consistent `Retry-After` header.",
  ].join("\n");
  const id = t.toolUse("ExitPlanMode", { plan });
  t.toolResult(id, "User has approved your plan. You can now start coding.", { plan, isAgent: false });
  t.text([
    "Approved. This is the request path after the change:",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant C as Client",
    "  participant R as router.ts",
    "  participant L as rateLimit",
    "  participant S as requireSession",
    "  participant H as Route handler",
    "  C->>R: POST /api/login",
    "  R->>L: check IP + route",
    "  alt over the limit",
    "    L-->>C: 429 Retry-After: 60",
    "  else allowed",
    "    L->>S: next()",
    "    S->>H: next()",
    "    H-->>C: 200",
    "  end",
    "```",
    "",
    "I'll start with step 1.",
  ].join("\n"));
  t.turnEnd();
  t.title("Refactor login middleware");
  return t;
}

function depsBump(cwd, startMs) {
  const t = new Transcript({ sessionId: randomUUID(), cwd, startMs });
  t.user("Bump the dev dependencies to their latest versions and run the tests.");
  t.bash("pnpm outdated --dev", "List outdated dev dependencies", [
    "┌──────────┬─────────┬─────────┐",
    "│ Package  │ Current │ Latest  │",
    "├──────────┼─────────┼─────────┤",
    "│ vite     │ 7.0.4   │ 8.0.1   │",
    "│ vitest   │ 3.2.4   │ 3.3.0   │",
    "└──────────┴─────────┴─────────┘",
  ].join("\n"));
  t.toolUse("AskUserQuestion", { questions: [{
    header: "vite 8",
    question: "vite 8.0 is a major release. Upgrade it now, or keep 7.x and only bump vitest?",
    multiSelect: false,
    options: [
      { label: "Upgrade to vite 8", description: "Read the migration guide and fix what breaks" },
      { label: "Keep vite 7", description: "Bump vitest only" },
    ],
  }] });
  t.title("Bump dev dependencies");
  return t;
}

function simple(cwd, startMs, title, prompt, answer, model) {
  const t = new Transcript({ sessionId: randomUUID(), cwd, startMs, model });
  t.user(prompt);
  t.text(answer);
  t.turnEnd();
  t.title(title);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Codex threads (served by the fake daemon in capture.mjs)

const sec = (ms) => Math.floor(ms / 1000);

function codexRateLimit(cwd, startMs) {
  const id = "019a7c2e-5d1b-7f30-9e64-3b8a1c0d2f47";
  const turnId = "019a7c2e-6a00-7c11-8d2e-4f5a6b7c8d90";
  let at = startMs;
  const step = (ms) => (at += ms);
  const cmd = (command, output, ms) => ({
    type: "commandExecution", id: `call_${randomUUID().slice(0, 8)}`, pluginId: null, scriptPath: null, command, cwd, processId: null, source: "agent",
    status: "completed", commandActions: [], aggregatedOutput: output, exitCode: 0, durationMs: ms, startedAtMs: step(4000), completedAtMs: step(ms),
  });
  const items = [
    { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Add rate limiting to POST /api/login: at most 5 attempts per minute per IP, answer 429 with Retry-After. Add a test.", text_elements: [] }], startedAtMs: at, completedAtMs: at },
    { type: "reasoning", id: "r1", summary: ["**Locating the login route**\n\nI'll find the route and see whether any middleware exists."], content: [], startedAtMs: step(2000), completedAtMs: step(3000) },
    cmd("rg -n \"login\" src", "src/router.ts:1:import { login } from \"./routes/login.ts\";\nsrc/router.ts:4:  if (req.url === \"/api/login\") return login(req, res);\nsrc/routes/login.ts:5:export async function login(req, res) {", 180),
    { type: "agentMessage", moderation: null, id: "a1", text: "There is no middleware yet. I'll add a small in-memory limiter and wire it into the login route.", phase: null, memoryCitation: null, delivery: null, questions: null, startedAtMs: step(2000), completedAtMs: step(500) },
    { type: "fileChange", id: "p1", status: "completed", startedAtMs: step(3000), completedAtMs: step(800), changes: [
      { path: path.join(cwd, "src/middleware/rateLimit.ts"), kind: { type: "add" }, diff: ACME_API["src/middleware/rateLimit.ts"] },
      { path: path.join(cwd, "src/routes/login.ts"), kind: { type: "update", move_path: null }, diff: [
        "@@ -1,5 +1,9 @@",
        "+import { rateLimit } from \"../middleware/rateLimit.ts\";",
        "+",
        "+const limit = rateLimit({ windowMs: 60_000, max: 5 });",
        "+",
        " export async function login(req, res) {",
        "+  if (!limit(req, res)) return;",
        "   res.end(\"ok\");",
        " }",
      ].join("\n") },
    ] },
    cmd("node --test test/", "✔ sixth login in a minute gets 429 (3.1ms)\n✔ a new minute resets the count (1.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0", 640),
    { type: "agentMessage", moderation: null, id: "a2", text: "Done. `POST /api/login` now allows 5 attempts per minute per IP and answers `429` with `Retry-After: 60` after that.\n\n- `src/middleware/rateLimit.ts`: sliding one-minute window per IP\n- `src/routes/login.ts`: uses the limiter\n- `test/rateLimit.test.ts`: two tests, both pass\n\nThe limiter keeps its counts in memory, so they reset when the server restarts and are not shared between instances.", phase: null, memoryCitation: null, delivery: null, questions: null, startedAtMs: step(3000), completedAtMs: step(1500) },
  ];
  const turn = { id: turnId, rootTurnId: turnId, items, itemsView: "full", status: "completed", error: null, startedAt: sec(startMs), completedAt: sec(at), durationMs: at - startMs };
  return {
    thread: {
      id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "Add rate limiting to POST /api/login", ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
      historyMode: "paginated", modelProvider: "openai", model: "gpt-6-astra", reasoningEffort: "high", createdAt: sec(startMs), updatedAt: sec(at), recencyAt: null,
      status: { type: "notLoaded" }, path: null, cwd, cliVersion: "0.169.0", originator: "codex-tui", source: "cli", threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: "Add rate limiting to login", turns: [],
    },
    turns: [turn],
  };
}

function codexCiCache(cwd, startMs) {
  const id = "019a7b11-0c2d-7e4f-8a9b-1c2d3e4f5a6b";
  const turnId = "019a7b11-1111-7222-8333-944455566677";
  const items = [
    { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Why does CI reinstall every dependency on each run?", text_elements: [] }], startedAtMs: startMs, completedAtMs: startMs },
    { type: "agentMessage", moderation: null, id: "a1", text: "The workflow restores the pnpm store with a cache key built from `package.json`, but the lockfile is `pnpm-lock.yaml`, so the key never matches. Keying the cache on `hashFiles('pnpm-lock.yaml')` fixes it.", phase: null, memoryCitation: null, delivery: null, questions: null, startedAtMs: startMs + 9000, completedAtMs: startMs + 12_000 },
  ];
  return {
    thread: {
      id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "Why does CI reinstall every dependency on each run?", ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
      historyMode: "paginated", modelProvider: "openai", model: "gpt-6-astra", reasoningEffort: "medium", createdAt: sec(startMs), updatedAt: sec(startMs + 12_000), recencyAt: null,
      status: { type: "notLoaded" }, path: null, cwd, cliVersion: "0.169.0", originator: "codex-tui", source: "cli", threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: "Speed up CI dependency cache", turns: [],
    },
    turns: [{ id: turnId, rootTurnId: turnId, items, itemsView: "full", status: "completed", error: null, startedAt: sec(startMs), completedAt: sec(startMs + 12_000), durationMs: 12_000 }],
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Build the world under `home`. `pids`: live processes (the caller started them) that stand in
 * for running CLI sessions. Returns the accounts, the sessions by role, and the Codex threads.
 */
export function buildWorld({ home, pids }) {
  const code = path.join(home, "code");
  const web = path.join(code, "acme-web");
  const api = path.join(code, "acme-api");
  const trail = path.join(code, "trail-notes");
  writeTree(web, ACME_WEB);
  writeTree(api, ACME_API);
  writeTree(trail, TRAIL_NOTES);
  const t0 = Date.now() - 6 * 24 * 3600_000;
  commitHistory(web, ["Initial storefront", "Add cart summary", "Lazy load product images", "Show an error when a payment fails", "Keep cart totals in cents", "Add cart regression tests"], t0);
  commitHistory(api, ["Initial API", "Add login route", "Rate limit POST /api/login"], t0);
  commitHistory(trail, ["Initial commit", "Fix dark mode contrast"], t0);
  // The shell shot's prompt: the folder only, no user or host name.
  fs.writeFileSync(path.join(home, ".zshrc"), "PROMPT='%F{cyan}%~%f %# '\nRPROMPT=''\nunsetopt BEEP\nexport CLICOLOR=1\n");

  const work = path.join(home, ".claude-work");
  const personal = path.join(home, ".claude-personal");
  const codexHome = path.join(home, ".codex-personal");
  for (const d of [work, personal, codexHome]) fs.mkdirSync(d, { recursive: true });

  const now = Date.now();
  const s = {};
  const add = (key, dir, t, opts) => {
    saveClaude(dir, t, opts);
    s[key] = { provider: "claude", account: dir === work ? "claude-work" : "claude-personal", id: t.sessionId, cwd: t.cwd };
  };

  add("cart", work, cartFix(web, now - 40 * MIN));
  const checkout = checkoutTests(web, now - 6 * MIN, pids[0]);
  add("checkout", work, checkout.t, { subagents: checkout.subagents, registry: { pid: pids[0], status: "busy" } });
  add("auth", work, authPlan(api, now - 3 * 60 * MIN));
  add("deps", work, depsBump(web, now - 12 * MIN), { registry: { pid: pids[1], status: "waiting" } });
  add("flaky", work, simple(web, now - 26 * 60 * MIN, "Investigate flaky e2e test",
    "The checkout e2e test fails about one run in ten. Find out why.",
    "The test clicks **Pay** before the price request resolves. On a slow run the button is still disabled, so the click does nothing. Waiting for `GET /api/prices` before the click makes it pass 50 out of 50 runs."));
  add("notes", work, simple(web, now - 2 * 24 * 60 * MIN, "Write release notes for v2.3",
    "Draft release notes for v2.3 from the merged pull requests.",
    "## v2.3\n\n- Cart totals are computed in cents (no more `$10.200000000000001`)\n- Checkout shows a clear error when a payment fails\n- Faster product page load (images are lazy loaded)"));
  add("contrast", personal, simple(trail, now - 5 * 60 * MIN, "Fix dark mode contrast",
    "Body text is hard to read in dark mode. Fix the colors.",
    "The dark theme used `#8b949e` for body text, which is 4.1:1 against the background. I changed it to `#e6edf3` (13.8:1) and kept the muted gray for captions only.", "claude-sonnet-5"));
  add("offline", personal, simple(trail, now - 3 * 24 * 60 * MIN, "Plan offline map caching",
    "How could the app cache map tiles for offline hikes?",
    "Two options: a service worker that caches tiles as you pan, or a \"download this area\" button that fetches a bounding box ahead of time. The second is more predictable for hikers, since they choose what is stored before they lose signal.", "claude-sonnet-5"));

  const codex = [codexRateLimit(api, now - 75 * MIN), codexCiCache(web, now - 30 * 60 * MIN)];
  for (const c of codex) s[c === codex[0] ? "ratelimit" : "ci"] = { provider: "codex", account: "codex-personal", id: c.thread.id, cwd: c.thread.cwd };

  return {
    accounts: { work, personal, codexHome },
    repos: { web, api, trail },
    sessions: s,
    codex,
  };
}
