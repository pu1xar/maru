import assert from "node:assert/strict";
import { test } from "node:test";
import { mapRolloutItem, redactSecrets, rolloutItemKey, shellJoin, shellQuote, turnError } from "./rolloutItems.ts";

const T = { startedAtMs: 1000, completedAtMs: 2000 };

test("shellQuote picks the longest unquoted, single or double quoted run, like the shlex crate", () => {
  assert.equal(shellQuote("ls"), "ls");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("/bin/zsh"), "/bin/zsh");
  assert.equal(shellQuote("a b"), "'a b'");
  // A single quote rules out single quotes: double quotes, with " and \ escaped.
  assert.equal(shellQuote(`it's "x" \\n`), `"it's \\"x\\" \\\\n"`);
  // A backquote cannot sit in double quotes: the run ends and a single quoted run takes over.
  assert.equal(shellQuote("a'b `c`"), `"a'b "'\`c\`'`);
  // ^ only right after an opening single quote.
  assert.equal(shellQuote("x'^\\y"), `"x'"'^'"\\\\y"`);
  // Non-ASCII needs quoting but fits either quote style.
  assert.equal(shellQuote("한글"), "'한글'");
  assert.equal(shellJoin(["/bin/zsh", "-lc", "echo 'hi' && ls"]), `/bin/zsh -lc "echo 'hi' && ls"`);
});

test("redactSecrets applies the daemon's four secret patterns", () => {
  assert.equal(redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop1234'"), "curl -H 'Authorization: Bearer [REDACTED_SECRET]'");
  assert.equal(redactSecrets("export OPENAI=sk-abcdefghijklmnopqrstuvwx"), "export OPENAI=[REDACTED_SECRET]");
  assert.equal(redactSecrets("id AKIAABCDEFGHIJKLMNOP end"), "id [REDACTED_SECRET] end");
  assert.equal(redactSecrets(`f(token="abcdefgh1234") and API_KEY: zzzzzzzzzz`), `f(token="[REDACTED_SECRET]") and API_KEY: [REDACTED_SECRET]`);
  // Too short, or the keyword inside a longer word: kept.
  assert.equal(redactSecrets("token=short"), "token=short");
  assert.equal(redactSecrets("mytoken=abcdefghijk"), "mytoken=abcdefghijk");
  assert.equal(redactSecrets("한글token=abcdefghijk"), "한글token=abcdefghijk", "Unicode word boundary");
  // The daemon also hides code that looks like an assignment (measured: an arrow function).
  assert.equal(redactSecrets("const token=>{run()}"), "const token=[REDACTED_SECRET]");
  assert.equal(redactSecrets("token=>{x}"), "token=>{x}");
});

test("rolloutItemKey names extension items by kind", () => {
  assert.equal(rolloutItemKey({ type: "Reasoning" }), "Reasoning");
  assert.equal(rolloutItemKey({ type: "Extension", kind: "web.search" }), "Extension/web.search");
  assert.equal(rolloutItemKey({}), "(missing)");
});

test("user, agent, reasoning and compaction items", () => {
  assert.deepEqual(
    mapRolloutItem({ type: "UserMessage", id: "u1", client_id: "c1", content: [{ type: "text", text: "hi", text_elements: [] }, { type: "local_image", path: "file:///tmp/a%20b.png" }] }, T),
    { type: "userMessage", id: "u1", clientId: "c1", content: [{ type: "text", text: "hi", text_elements: [] }, { type: "localImage", path: "/tmp/a b.png" }], ...T },
  );
  assert.deepEqual(mapRolloutItem({ type: "UserMessage", id: "u2", content: [] }, T), { type: "userMessage", id: "u2", clientId: null, content: [], ...T });
  assert.deepEqual(
    mapRolloutItem({ type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "one " }, { type: "Text", text: "two" }], phase: "commentary" }, T),
    { type: "agentMessage", id: "a1", text: "one two", phase: "commentary", moderation: null, memoryCitation: null, delivery: null, questions: null, ...T },
  );
  const q = mapRolloutItem({ type: "AgentMessage", id: "a2", content: [{ type: "Text", text: "Pick" }], phase: "final_answer", delivery: "async", questions: [{ title: "Pick", options: ["x", "y"] }] }, T);
  assert.equal(q?.type === "agentMessage" && q.delivery, "async");
  assert.deepEqual(q?.type === "agentMessage" && q.questions, [{ title: "Pick", options: ["x", "y"] }]);
  assert.deepEqual(mapRolloutItem({ type: "Reasoning", id: "r1", summary_text: ["s1", { text: "s2" }], raw_content: [] }, T), {
    type: "reasoning",
    id: "r1",
    summary: ["s1", "s2"],
    content: [],
    ...T,
  });
  assert.deepEqual(mapRolloutItem({ type: "ContextCompaction", id: "c1" }, T), { type: "contextCompaction", id: "c1", ...T });
});

test("a command: argv joined, cwd and read paths local and absolute, empty output null, duration in ms", () => {
  const item = mapRolloutItem(
    {
      type: "CommandExecution",
      id: "e1",
      process_id: "42",
      command: ["/bin/zsh", "-lc", "cat a.md | rg x"],
      cwd: "file:///work/proj",
      parsed_cmd: [
        { type: "read", cmd: "cat a.md", name: "a.md", path: "docs/../a.md" },
        { type: "list_files", cmd: "ls", path: "src" },
        { type: "search", cmd: "rg x", query: "x", path: null },
        { type: "unknown", cmd: "make TOKEN=abcdefghijk" },
      ],
      source: "unified_exec_startup",
      status: "failed",
      aggregated_output: "",
      exit_code: 1,
      duration: { secs: 2, nanos: 720_349_125 },
      formatted_output: "",
      stdout: "",
      stderr: "",
    },
    T,
  );
  assert.deepEqual(item, {
    type: "commandExecution",
    id: "e1",
    pluginId: null,
    scriptPath: null,
    command: `/bin/zsh -lc 'cat a.md | rg x'`,
    cwd: "/work/proj",
    processId: "42",
    source: "unifiedExecStartup",
    status: "failed",
    commandActions: [
      { type: "read", command: "cat a.md", name: "a.md", path: "/work/proj/a.md" },
      { type: "listFiles", command: "ls", path: "src" },
      { type: "search", command: "rg x", query: "x", path: null },
      { type: "unknown", command: "make TOKEN=[REDACTED_SECRET]" },
    ],
    aggregatedOutput: null,
    exitCode: 1,
    durationMs: 2720,
    ...T,
  });
});

test("a file change: changes sorted by path, adds and deletes carry the content, a move ends the diff with its destination", () => {
  const item = mapRolloutItem(
    {
      type: "FileChange",
      id: "p1",
      changes: {
        "/w/b.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null },
        "/w/a.ts": { type: "add", content: "new\n" },
        "/w/c.ts": { type: "update", unified_diff: "", move_path: "/w/d/c.ts" },
        "/w/B.ts": { type: "delete", content: "old\n" },
      },
      status: "completed",
      stdout: "ok",
      stderr: "",
    },
    T,
  );
  assert.deepEqual(item, {
    type: "fileChange",
    id: "p1",
    changes: [
      { path: "/w/B.ts", kind: { type: "delete" }, diff: "old\n" },
      { path: "/w/a.ts", kind: { type: "add" }, diff: "new\n" },
      { path: "/w/b.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "/w/c.ts", kind: { type: "update", move_path: "/w/d/c.ts" }, diff: "\n\nMoved to: /w/d/c.ts" },
    ],
    status: "completed",
    ...T,
  });
});

test("an MCP call: app context from the connector fields, result normalized, an Err result as the error", () => {
  const base = { type: "McpToolCall", id: "m1", server: "codex_apps", tool: "drive.search", arguments: { q: 1 }, readOnlyHint: true, status: "completed", duration: { secs: 0, nanos: 110_180_208 } };
  assert.deepEqual(
    mapRolloutItem({ ...base, connectorId: "conn", linkId: "link", appName: "Drive", actionName: "search", result: { content: [{ type: "text", text: "ok" }], structuredContent: { n: 1 }, isError: false } }, T),
    {
      type: "mcpToolCall",
      id: "m1",
      server: "codex_apps",
      tool: "drive.search",
      status: "completed",
      arguments: { q: 1 },
      appContext: { connectorId: "conn", linkId: "link", resourceUri: null, appName: "Drive", actionName: "search" },
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: true,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: { n: 1 }, _meta: null },
      error: null,
      durationMs: 110,
      ...T,
    },
  );
  const failed = mapRolloutItem({ ...base, status: "failed", result: { Err: "server gone" } }, T);
  assert.equal(failed?.type === "mcpToolCall" && failed.appContext, null);
  assert.deepEqual(failed?.type === "mcpToolCall" && [failed.result, failed.error], [null, { message: "server gone" }]);
});

test("image view, subagent activity, collab tool call and extension items", () => {
  assert.deepEqual(mapRolloutItem({ type: "ImageView", id: "i1", path: "file:///tmp/x.png" }, T), { type: "imageView", id: "i1", path: "/tmp/x.png", ...T });
  assert.deepEqual(
    mapRolloutItem({ type: "SubAgentActivity", id: "s1", kind: "started", agent_thread_id: "child", agent_path: "/root/a", model: "m", reasoning_effort: "high" }, T),
    { type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "child", agentPath: "/root/a", model: "m", reasoningEffort: "high", ...T },
  );
  assert.deepEqual(
    mapRolloutItem(
      { type: "CollabAgentToolCall", id: "c1", tool: "spawn_agent", status: "in_progress", sender_thread_id: "p", receiver_thread_ids: ["child"], receiver_agents: [], agents_states: { child: { status: "pending_init", message: null } } },
      T,
    ),
    {
      type: "collabAgentToolCall",
      id: "c1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "p",
      receiverThreadIds: ["child"],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { child: { status: "pendingInit", message: null } },
      ...T,
    },
  );
  assert.deepEqual(mapRolloutItem({ type: "Extension", kind: "web.search", id: "w1", query: "q", action: { type: "search", query: "q", queries: null }, results: [{ type: "text_result", ref_id: "r" }] }, T), {
    type: "webSearch",
    id: "w1",
    query: "q",
    action: { type: "search", query: "q", queries: null },
    results: [{ type: "text_result", ref_id: "r" }],
    ...T,
  });
  assert.deepEqual(mapRolloutItem({ type: "Extension", kind: "clock.sleep", id: "z1", durationMs: 20000 }, T), { type: "sleep", id: "z1", durationMs: 20000, ...T });
  const gen = { status: "completed", revisedPrompt: "p", result: "BASE64", transparentBackground: true, failure: null, savedPath: "/g/x.png", inputImages: [], generationId: "g1" };
  assert.deepEqual(mapRolloutItem({ type: "Extension", kind: "image_gen.generation", id: "g", ...gen }, T), { type: "imageGeneration", id: "g", ...gen, ...T });
});

test("types this table does not know map to null", () => {
  assert.equal(mapRolloutItem({ type: "Hologram", id: "h1" }, T), null);
  assert.equal(mapRolloutItem({ type: "Extension", kind: "future.tool", id: "f1" }, T), null);
  assert.equal(mapRolloutItem({ type: "UserMessage" }, T), null, "no id");
  assert.equal(mapRolloutItem("text", T), null);
});

test("turnError: snake_case codes become camelCase, struct variants keep their fields", () => {
  assert.deepEqual(turnError({ message: "limit", codex_error_info: "usage_limit_exceeded" }), {
    message: "limit",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: null,
    misalignment: null,
  });
  assert.deepEqual(turnError({ message: "down", codex_error_info: { http_connection_failed: { http_status_code: 502 } }, additional_details: "d" }), {
    message: "down",
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
    additionalDetails: "d",
    misalignment: null,
  });
  assert.equal(turnError(undefined), null);
});
