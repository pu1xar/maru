// Whether a Claude process this server starts keeps file checkpoints (DESIGN.md 6o).
//
// The CLI 2.1.325 keeps them in the terminal unless the `fileCheckpointingEnabled` setting is
// false or CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING is set; an SDK process keeps them only when
// started with enableFileCheckpointing (its mL(): the SDK branch reads the env alone, not the
// setting). So this server turns them on as the terminal does and reads the setting itself, in
// the CLI's order: the folder's .claude/settings.local.json, its .claude/settings.json, then the
// account's settings.json. The env stays with the CLI (buildEnv does not pass it on).
import fs from "node:fs";
import path from "node:path";

function settingOf(file: string): boolean | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { fileCheckpointingEnabled?: unknown }).fileCheckpointingEnabled;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function fileCheckpointingFor(accountDir: string, cwd: string): boolean {
  for (const file of [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json"), path.join(accountDir, "settings.json")]) {
    const v = settingOf(file);
    if (v !== undefined) return v;
  }
  return true;
}
