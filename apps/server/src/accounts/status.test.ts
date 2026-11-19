import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLoginStatus, parseClaudeStatus, parseCodexStatus, type CliResult, type CliRunner } from "./status.ts";

// Output as the CLIs printed it (claude 2.x `auth status`, codex `login status`; email and org left out).
const CLAUDE_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: "/h/.claude", loginExpiresAt: "2026-12-15T08:11:07.190Z" }, null, 2);
const CLAUDE_OUT = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: "/h/.claude-x", loginExpiresAt: null }, null, 2);

test("claude auth status: the JSON's loggedIn decides, whatever the exit code", () => {
  assert.equal(parseClaudeStatus({ code: 0, stdout: CLAUDE_IN }), "signed-in");
  assert.equal(parseClaudeStatus({ code: 1, stdout: CLAUDE_OUT }), "not-signed-in");
  assert.equal(parseClaudeStatus({ code: 1, stdout: "Not logged in. Run claude auth login to authenticate.\n" }), "not-signed-in");
});

test("claude auth status: output of another shape is unknown, not a guess", () => {
  for (const stdout of ["", "{}", '{"loggedIn":"yes"}', "[1]", "Something new\n", "null"]) {
    assert.equal(parseClaudeStatus({ code: 0, stdout }), "unknown", JSON.stringify(stdout));
  }
});

test("codex login status: the text line and the exit code", () => {
  assert.equal(parseCodexStatus({ code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }), "signed-in");
  assert.equal(parseCodexStatus({ code: 0, stdout: "Logged in using an API key - sk-...abcd\n", stderr: "" }), "signed-in");
  assert.equal(parseCodexStatus({ code: 1, stdout: "", stderr: "Not logged in\n" }), "not-signed-in");
  assert.equal(parseCodexStatus({ code: 1, stdout: "Not logged in\n", stderr: "" }), "not-signed-in");
  // A warning line may come first.
  assert.equal(parseCodexStatus({ code: 0, stdout: "", stderr: "WARNING: could not create PATH aliases\nLogged in using ChatGPT\n" }), "signed-in");
});

test("codex login status: a failure that is not the login answer is unknown", () => {
  assert.equal(parseCodexStatus({ code: 1, stdout: "", stderr: "Error loading configuration: CODEX_HOME points to /x, but that path does not exist\n" }), "unknown");
  // "Logged in" on a failing exit is not trusted.
  assert.equal(parseCodexStatus({ code: 2, stdout: "Logged in using ChatGPT\n", stderr: "" }), "unknown");
  assert.equal(parseCodexStatus({ code: 0, stdout: "", stderr: "" }), "unknown");
});

function runner(result: Partial<CliResult>, seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []): CliRunner {
  return async (bin, args, env) => {
    seen.push({ bin, args, env });
    return { code: 0, stdout: "", stderr: "", missing: false, timedOut: false, ...result };
  };
}

test("the CLI runs with the account's folder in its own variable, and the commands are the status ones", async () => {
  const seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const dirExists = () => true;
  assert.equal(await accountLoginStatus("claude", "/h/.claude-w", { run: runner({ stdout: CLAUDE_IN }, seen), claudeBin: "/bin/claude", env: { PATH: "/bin" }, dirExists }), "signed-in");
  assert.equal(await accountLoginStatus("codex", "/h/.codex-w", { run: runner({ stdout: "Logged in using ChatGPT\n" }, seen), claudeBin: "/bin/claude", env: { PATH: "/bin" }, dirExists }), "signed-in");
  assert.deepEqual(seen.map((s) => [s.bin, ...s.args]), [["/bin/claude", "auth", "status"], ["codex", "login", "status"]]);
  assert.equal(seen[0]!.env.CLAUDE_CONFIG_DIR, "/h/.claude-w");
  assert.equal(seen[1]!.env.CODEX_HOME, "/h/.codex-w");
});

test("a missing CLI, a timeout and a folder that does not exist yet", async () => {
  const base = { claudeBin: "/bin/claude", env: {}, dirExists: () => true };
  assert.equal(await accountLoginStatus("claude", "/d", { ...base, run: runner({ code: null, missing: true }) }), "cli-missing");
  assert.equal(await accountLoginStatus("codex", "/d", { ...base, run: runner({ code: null, missing: true }) }), "cli-missing");
  assert.equal(await accountLoginStatus("claude", "/d", { ...base, run: runner({ code: null, timedOut: true }) }), "unknown");
  let ran = false;
  const never: CliRunner = async () => {
    ran = true;
    throw new Error("must not run");
  };
  assert.equal(await accountLoginStatus("claude", "/nope", { ...base, run: never, dirExists: () => false }), "not-signed-in");
  assert.equal(ran, false, "the CLI would create the folder just to answer");
});
