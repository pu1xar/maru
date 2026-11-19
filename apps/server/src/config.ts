import os from "node:os";
import path from "node:path";
import { STATE_FILE as STATE_FILE_PATH } from "./host/dataPaths.ts";
import { ConfigError, loadUserConfig, resolveClaudeBin } from "./userConfig.ts";
import type { ClaudeAccount, CodexAccount, LoadedConfig } from "./userConfig.ts";

const HOME = os.homedir();

export type { ClaudeAccount, CodexAccount } from "./userConfig.ts";

// The accounts and the usage switches come from the user's config file (userConfig.ts, README).
// Settings that cannot be read stop the server with the reason, so a typo is never run as defaults.
function load(): LoadedConfig {
  try {
    return loadUserConfig(process.env, HOME);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`maru: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const loaded = load();

/** The config file in use, null when there is none and the accounts were found on disk. */
export const CONFIG_FILE: string | null = loaded.file;

export const CLAUDE_ACCOUNTS: ClaudeAccount[] = loaded.config.claudeAccounts;

export const CODEX_ACCOUNTS: CodexAccount[] = loaded.config.codexAccounts;

/** Read Claude's rate-limit usage with Claude Code's stored login (config `claudeUsage`, default off). */
export const CLAUDE_USAGE: boolean = loaded.config.claudeUsage;

/** Read Codex's rate-limit usage with the Codex CLI's stored login and daemon (config `codexUsage`, default off). */
export const CODEX_USAGE: boolean = loaded.config.codexUsage;

/** The Claude Code CLI sessions run with: config `claudeBin`, else `claude` on PATH, else ~/.local/bin/claude. */
export const CLAUDE_BIN: string = resolveClaudeBin(loaded.config.claudeBin, HOME);

/** ports.env MARU; the number is the fallback when PORT is unset. */
export const PORT = Number(process.env.PORT || 8024);
export const HOST = "127.0.0.1";

export const HOME_DIR = HOME;

// The state file and the session host's socket (host/dataPaths.ts keeps them out of the host's
// dependence on this file).
export { HOST_SOCKET, STATE_FILE } from "./host/dataPaths.ts";

/** The client's trash (DESIGN.md 6, 삭제): one folder per deleted session. */
export const TRASH_DIR = process.env.MARU_TRASH || path.join(HOME, ".config", "maru", "trash");

/** Uploaded attachments (DESIGN.md 6n): one folder per upload, next to the state file. */
export const ATTACHMENTS_DIR = process.env.MARU_ATTACHMENTS || path.join(path.dirname(STATE_FILE_PATH), "attachments");

/** A metadata-only transcript that a move or rehome replaces goes here (the macOS user Trash). */
export const STUB_TRASH_DIR = path.join(HOME, ".Trash", "claude-migrate-stubs");

// Paired devices (DESIGN.md 2d).
/** The device listener's port (ports.env MARU_DEVICE); without it no device can connect or pair. */
export const DEVICE_PORT = process.env.MARU_DEVICE_PORT ? Number(process.env.MARU_DEVICE_PORT) : null;
/** Extra Host values the device listener accepts besides loopback and MARU_HOSTS. */
export const DEVICE_HOSTS = (process.env.MARU_DEVICE_HOSTS || "").split(",").map((x) => x.trim()).filter(Boolean);
/** The server URL pairing links carry; unset, the web page's own origin (or the loopback device port). */
export const DEVICE_URL = process.env.MARU_DEVICE_URL || null;
/** The OTA read token built into every APK (mobile/updateToken.ts); build-apk.sh creates it. */
export const UPDATE_TOKEN_FILE = process.env.MARU_UPDATE_TOKEN_FILE || path.join(HOME, ".config", "maru", "mobile-update-token");
/** Built APKs (apps/mobile/scripts/build-apk.sh), outside the releases. */
export const MOBILE_DIR = process.env.MARU_MOBILE_DIR || path.join(HOME, ".local", "share", "maru", "mobile");
/** The Firebase service account pushes are sent with (push/fcm.ts); without the file pushes are off. */
export const FCM_SERVICE_ACCOUNT_FILE = process.env.MARU_FCM_SERVICE_ACCOUNT_FILE || path.join(HOME, ".config", "maru", "firebase", "service-account.json");

/**
 * The tmux socket of the shell terminals (DESIGN.md 6s), next to the state file. tmux runs in this
 * folder and names the socket relative to it (shell/tmux.ts), so a long scratch path works too.
 */
export const SHELL_SOCKET = process.env.MARU_SHELL_SOCKET || path.join(path.dirname(STATE_FILE_PATH), "shell-tmux.sock");
