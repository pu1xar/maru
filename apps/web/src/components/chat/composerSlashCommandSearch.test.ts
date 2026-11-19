import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionCommand } from "@maru/shared";
import { pickCommand, searchSlashCommands, slashQuery } from "./composerSlashCommandSearch.ts";

const cmd = (name: string, over: Partial<SessionCommand> = {}): SessionCommand => ({
  name, sigil: "/", description: "", argumentHint: "", aliases: [], source: "custom", ...over,
});

test("the menu opens only while the message is a lone /word", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/comp"), "comp");
  assert.equal(slashQuery("/humanize-korean:hu"), "humanize-korean:hu");
  assert.equal(slashQuery("/compact "), null, "a space ends the word");
  assert.equal(slashQuery("/goal\nship it"), null);
  assert.equal(slashQuery(" /compact"), null, "only at the very start");
  assert.equal(slashQuery("say /compact"), null);
  assert.equal(slashQuery(""), null);
  assert.equal(slashQuery("$cave"), null);
});

test("names rank before descriptions: exact, prefix, word boundary, substring, then fuzzy", () => {
  const list = [
    cmd("review", { description: "Review a pull request" }),
    cmd("security-review"),
    cmd("compact", { description: "Clear history but keep a summary" }),
    cmd("humanize-korean:review-ko"),
    cmd("rename", { description: "Rename the conversation" }),
    cmd("clear", { aliases: ["reset", "new"] }),
    cmd("caveman", { sigil: "$", description: "terse replies" }),
  ];
  const names = (q: string) => searchSlashCommands(list, q).map((c) => `${c.sigil}${c.name}`);
  assert.deepEqual(names(""), list.map((c) => `${c.sigil}${c.name}`), "an empty query keeps the list's order");
  // Exact first; then word boundaries, the earlier boundary first.
  assert.deepEqual(names("review"), ["/review", "/security-review", "/humanize-korean:review-ko"]);
  // Prefixes rank by the length left over (the alias "reset" is shortest), then by name.
  assert.deepEqual(names("re").slice(0, 3), ["/clear", "/rename", "/review"]);
  assert.deepEqual(names("reset"), ["/clear"], "an alias counts as a name");
  assert.deepEqual(names("summary"), ["/compact"], "a description matches after names");
  assert.deepEqual(names("cvmn"), ["$caveman"], "fuzzy");
  assert.deepEqual(names("/rev")[0], "/review", "a leading slash in the query is ignored");
  assert.deepEqual(names("zzz"), []);
});

test("Enter runs a command that takes no arguments; one with arguments, a skill, Tab and a click only fill it in", () => {
  assert.deepEqual(pickCommand(cmd("compact"), "enter"), { text: "/compact", send: true });
  assert.deepEqual(pickCommand(cmd("compact"), "tab"), { text: "/compact ", send: false });
  assert.deepEqual(pickCommand(cmd("compact"), "click"), { text: "/compact ", send: false });
  assert.deepEqual(pickCommand(cmd("rename", { argumentHint: "<name>" }), "enter"), { text: "/rename ", send: false });
  assert.deepEqual(pickCommand(cmd("caveman", { sigil: "$" }), "enter"), { text: "$caveman ", send: false });
});
