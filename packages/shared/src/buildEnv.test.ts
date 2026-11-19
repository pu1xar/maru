import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEnvFile, loadBuildEnv, parseBuildEnv } from "./buildEnv.ts";

test("parseBuildEnv reads KEY=VALUE lines, comments, export and one pair of quotes", () => {
  const out = parseBuildEnv(
    [
      "# a comment",
      "",
      "MARU_ANDROID_PACKAGE=com.example.maru",
      "export MARU_UPDATES_URL = https://maru.example.com/ota/manifest  ",
      'MARU_FONT_CDN="https://cdn.example.com/fonts/v1/bon-google-sans-code"',
      "EMPTY=",
      "RAW=$HOME/x",
    ].join("\n"),
  );
  assert.deepEqual(out, {
    MARU_ANDROID_PACKAGE: "com.example.maru",
    MARU_UPDATES_URL: "https://maru.example.com/ota/manifest",
    MARU_FONT_CDN: "https://cdn.example.com/fonts/v1/bon-google-sans-code",
    EMPTY: "",
    RAW: "$HOME/x",
  });
});

test("a line that is not KEY=VALUE names its number", () => {
  assert.throws(() => parseBuildEnv("A=1\nnot a pair"), /line 2 is not KEY=VALUE/);
  assert.throws(() => parseBuildEnv("1A=x"), /line 1/);
});

test("loadBuildEnv fills only what the environment lacks, and a missing file is no error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-buildenv-"));
  try {
    const file = path.join(dir, "build.env");
    fs.writeFileSync(file, "A=file-a\nB=file-b\n");
    const env: NodeJS.ProcessEnv = { A: "env-a" };
    assert.equal(loadBuildEnv(env, file), file);
    assert.deepEqual(env, { A: "env-a", B: "file-b" });
    assert.equal(loadBuildEnv({}, path.join(dir, "none.env")), null);
    fs.writeFileSync(file, "oops");
    assert.throws(() => loadBuildEnv({}, file), /build\.env: line 1 is not KEY=VALUE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is ~/.config/maru/build.env unless MARU_BUILD_ENV names another", () => {
  assert.equal(buildEnvFile({}), path.join(os.homedir(), ".config", "maru", "build.env"));
  assert.equal(buildEnvFile({ MARU_BUILD_ENV: "/x/y.env" }), "/x/y.env");
});
