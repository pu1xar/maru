# Architecture

This document describes how maru is put together: the processes, how Claude and Codex are driven, how conversations are projected for the UI, and how the web, desktop and Android clients connect. It is a map for readers of the code, with file paths to start from.

Source comments cite numbered sections of `DESIGN.md` (for example "DESIGN.md 6k"). That is the author's private design log, kept in Korean, and it is intentionally not published; this document covers the same structure in English.

Contents

1. Overview
2. Processes: web server and session host
3. Sources: how sessions are found
4. Driving Claude and Codex
5. Who may write to a session
6. Transcript projection
7. Server state
8. Web client
9. Split view
10. Shell terminals
11. Devices: pairing, tokens, OTA updates
12. Releases and versions

## 1. Overview

```text
  browser, desktop app, Android app
        |  HTTP and WebSocket (/ws)
        v
  +------------------------ maru web server (Node) ------------------------+
  |  HTTP API and WebSocket        device listener (optional second port)   |
  |                                                                         |
  |  session index <- Claude source   <- ~/.claude*/projects, sessions      |
  |                <- Codex source    <- Codex app-server daemon (socket)   |
  |                                                                         |
  |  thread views: transcript projection, windowed subscriptions            |
  |  drivers: Claude runs (via the session host), Codex runs                |
  |  management, usage, search, shells, attachments, devices, push          |
  +------------------------------------------------------------------------+
        |  unix socket                         ^
        v                                      |
  Claude session host --- claude CLI child processes (Agent SDK)
```

- One server watches the sources, normalizes what it finds, and sends the UI a provider-neutral model over a WebSocket. The UI does not know Claude or Codex record formats
- The truth about a session stays in each tool's own files and daemon. The server's SQLite file holds an index cache and the few facts that have no home in the tools' files (Groups, locks, which sessions are listed, paired devices)
- The server is TypeScript that Node 26 runs directly by stripping types, so there is no build step for `apps/server` and only erasable syntax is used

Code map

| Path | Role |
|---|---|
| `apps/server/src/main.ts` | wires every service and starts the listeners |
| `apps/server/src/claude/` | Claude index, transcript meta, driver, projection |
| `apps/server/src/codex/` | app-server JSON-RPC client, index, projection, generated protocol types |
| `apps/server/src/host/` | the session host process |
| `apps/server/src/threads/` | per-session thread views and the windowed subscription logic |
| `apps/server/src/drive/` | runs: sending, interrupting, answering, queueing, rewind, fork |
| `apps/server/src/http/` | web listener, Host and Origin guard |
| `apps/server/src/devices/`, `mobile/`, `desktop/` | pairing, tokens, OTA and installer serving |
| `packages/shared/src/` | the contract between server and clients, and pure helpers |

## 2. Processes: web server and session host

A Claude turn can take minutes, and the server restarts whenever it is updated. To keep turns, pending questions and background agents alive across those restarts, the Claude CLI processes are children of a separate process, the session host (`apps/server/src/host/`).

```text
 browser --/ws--> web server
                    claude/driver.ts       options, permission decisions, session ownership
                    drive/claudeRuns.ts    session keys, questions
                    drive/idleCloser.ts    closes idle runs
                       |
                       |  unix socket (mode 0600), one JSON message per line
                       v
                  session host (host/core.ts)
                    one run = one Agent SDK query()
                       |
                       v
                  claude CLI child processes
```

- The host is a generic RPC wrapper around the SDK `Query` object. Decisions (which tool request goes to a person, session keys, names, idle policy) are in the web server, so the host rarely changes
- Protocol (`host/protocol.ts`): requests with ids (`hello`, `run.start`, `run.send`, `run.call`, `run.close`, `callback.reply`, `host.drain`, `host.status`) and events (`run.message`, `run.state`, `run.exit`, `callback`, `host.state`). `run.call` accepts an allowlist of `Query` control methods only
- Web server restart: the server connects to the host, receives a snapshot of live runs and pending callbacks, and adopts them. Messages emitted while it was away are caught up from the transcript
- Host down: the server retries the connection every second. Claude sends fail with a clear error, Codex is unaffected, and the UI shows a notice
- Host restart (rare, when host code or the SDK changes): `scripts/host-drain.ts` stops accepting new runs, waits for running turns, questions and tasks to finish, then lets the host exit
- Fingerprint: `scripts/host-fingerprint.ts` hashes the host's import graph (read the way Node reads it, including package contents) into one value `v1-<sha256>`. The host reports its own value at startup, and the release script restarts the host only when a new release has a different value
- Socket: `~/.config/maru/session-host.sock`, readable and writable by the user only. A socket file that nobody answers on (left by a dead host) is replaced, and a live host or a non-socket file makes the new host refuse to start
- The CLI's environment is built by the web server and passed in the run options. The SDK uses it as the whole environment, so the host's own environment never reaches the CLI

## 3. Sources: how sessions are found

Claude (`apps/server/src/claude/source.ts`, `meta.ts`, `registry.ts`)

- A session is a top-level transcript `<config dir>/projects/<encoded cwd>/<session id>.jsonl`. Subagent and workflow files live under `<session id>/`
- List fields (cwd, first prompt, name, title) come from the head and the tail of the file, because transcripts reach hundreds of megabytes. The newest `custom-title` is found by a byte search that continues from where the last read stopped
- Status comes from the CLI's registration files `<config dir>/sessions/<pid>.json` (busy, idle, waiting) and whether the pid is alive, checked together with the process start time because pids are reused
- Both folders are watched with `fs.watch`, and a periodic sweep notices crashed processes that left a registration behind

Codex (`apps/server/src/codex/`)

- The server connects to each account's app-server daemon over `<CODEX_HOME>/app-server-control/app-server-control.sock` (WebSocket on a unix socket). One connection per account lists threads and receives status notifications. Threads shown on screen are subscribed with `thread/resume`, other clients' turns arrive in the same order
- Generated protocol types are in `codex/protocol/`, produced by `codex app-server generate-ts` (`codex/gen-protocol.ts`). A few experimental requests are written by hand in `codex/experimental.ts`
- The archive flag comes from the account's state database, because the thread list does not report it
- A paginated thread whose history projection is empty in the daemon is read from its rollout file (`codex/projection/rolloutFallback.ts`), so opening a thread to read it does not have to load it into the daemon

Unified status (`packages/shared/src/index.ts`): `running`, `waiting-input`, `open-idle`, `closed`, `error`, mapped from each provider's own states.

## 4. Driving Claude and Codex

Claude

- A run is an Agent SDK `query()` in the session host with `permissionMode: "bypassPermissions"`. `pathToClaudeCodeExecutable` points at the same CLI binary the terminal uses, and user, project and local settings, hooks and skills are loaded as in a terminal
- The account is chosen through `CLAUDE_CONFIG_DIR` in the CLI's environment
- `canUseTool` sends only AskUserQuestion, ExitPlanMode and requests that require a person to the UI, and allows everything else at once. Other requests would stall the turn
- The entrypoint is set to `maru`, so sessions started here show up in the terminal's `claude --resume` list, and the index can tell them from terminal sessions
- Session functions of the SDK that take no config directory (rename, delete) are implemented directly. Fork calls the SDK in a child process with the account's `CLAUDE_CONFIG_DIR`

Codex

- `apps/server/src/drive/codexRuns.ts` uses one driver connection per account, apart from the connections that only watch
- A send is `turn/steer` while a turn started by this server is running and `turn/start` otherwise. Turns started by maru use approval policy `never` and a full-access sandbox
- The daemon serializes its clients, so ownership of a thread follows who started the running turn
- Ownership held by the server survives a restart: the held threads are stored and re-subscribed at startup unless the daemon unloaded them or another client has a turn running

Messages sent while a turn runs (`drive/pendingSends.ts`)

- The server keeps the list of messages the model has not taken in yet and publishes the whole list per session. Claude holds the message in the CLI's command queue and can take it back. A Codex steer lands in the running turn and cannot be taken back

## 5. Who may write to a session

Only one party writes to a session at a time. Claude does not prevent two processes from resuming the same session, and the conversation then forks inside one file.

| Session state | Owner | The UI can |
|---|---|---|
| a terminal CLI holds it (pid alive, entrypoint `cli`) | terminal | read live, nothing else |
| a process started by maru holds it | ui | read, send, interrupt, answer |
| closed | none | resume, which makes maru the owner |

- Claude ownership is decided by whether the registered pid is alive and not by the status value, since an idle terminal TUI reports `idle` too. The server re-checks right before a resume and takes a per-session lock
- Codex ownership is decided by who started the running turn. A send into a thread whose rollout is open in another `codex` process (found with `lsof`) is refused
- Every write request is checked again on the server. A disabled button in the UI is a convenience only

## 6. Transcript projection

The UI shows one model for both providers: a thread is a list of turn items (`packages/shared/src/turnItems.ts`), each with a kind (user message, assistant message, reasoning, command, file change, tool call, subagent, plan, system notice and others), a status and its raw source position.

- Claude (`claude/projection/`): `extract.ts` turns each transcript line into facts that depend on that line alone. `projector.ts` folds the facts in file order: tool results merge into their tool item, meta lines write thread state, user lines open runs. Ids are deterministic, so refolding after older pages are loaded keeps the ids of items already shown. After a refold the result equals a projection of the same lines read in one piece
- Codex (`codex/projection/`): `mapItems.ts` maps app-server `ThreadItem`s to the same turn items, and `rolloutFallback.ts` supplies turns from the rollout when the daemon has none
- Following a file: `transcript/transcriptHub.ts` runs one follower per transcript, shared by every screen showing it. A screen reads a page from the end, then subscribes from the page's end offset, and receives each later record exactly once
- Windowed subscriptions (`threads/windowed.ts`, `packages/shared/src/threadWindow.ts`): the client subscribes with a row count and gets the newest rows. Older rows are requested in pages, and the server remembers what each subscriber holds, so live events outside the window are not sent. Reading an older page renumbers positions and can change rows already shown, so live row events are held back while a page is read and the difference is sent afterwards
- Large tool results are not stored in the index. Only their position is kept, and the UI reads the original when a row is expanded
- Search (`search/sessionSearch.ts`): a conversation search runs over the projected rows of the open thread, and the all-sessions search keeps the user and assistant text of every top-level session the server lists (not only the sessions in the sidebar) in memory and updates it from file size and modification time at each search

## 7. Server state

State lives in `~/.config/maru/state.sqlite` (`node:sqlite`) and a few folders next to it.

- Cache (rebuildable): sessions, items and edges of the index
- State (not rebuildable): Groups and session assignments and order, pins, the list of sessions shown, archive flags, locks, model choices, UI preferences, folded sidebar folders, usage history, queued messages, held Codex threads, paired devices (token hashes only)
- Folders: the trash (one folder per deleted session with its metadata), uploaded attachments, the shell tmux socket, the session host socket
- Rows keyed by a session are cleaned up when the session is gone from every place it could be. If any place cannot be read, no row of that provider is removed
- HTTP and WebSocket contract: `packages/shared/src/index.ts` (`ServerMessage`, `ClientMessage`). A `/ws` connection starts with a hello that carries the server version, then the list, then per-session subscriptions

## 8. Web client

- React with Vite (`apps/web`). State is held in `useSessions.ts` (list) and `useThread.ts` with `threadState.ts` (a thread's windowed rows), over one WebSocket
- The timeline, markdown pipeline and many UI parts are adapted from T3 Code (see `THIRD_PARTY_NOTICES.md`). Markdown is rendered incrementally while a message streams, and long threads use a virtualized list
- Terminal mode (`components/terminal/`) draws the same thread in the layout of the Claude Code CLI. It is a web rendering, not a terminal emulator
- Right panel: a file explorer (lazy directory reads, `@pierre/trees` style icons), file preview tabs, and an Activity tab for subagents and background tasks
- Settings, usage dashboard, session management table, conversation search and the pairing dialogs are pages of the same app
- Per-device view state (last view, split layouts, composer drafts, display preferences) is kept in `localStorage`. Folded sidebar folders and Group order are server state shared by every client
- Lean window: `/?s=<session>&window=lean` renders one conversation with its header and composer. The desktop app opens it as a small window when a sidebar row or pane is dragged out of the main window
- The server version is compiled into the page. When a reconnect finds a different server version, the sidebar offers a reload

## 9. Split view

`?view=panes` shows several sessions and shell terminals at once, like tmux panes.

- Layout is a tree of splits and leaves (`lib/paneLayout.ts`): split, close, move, swap, resize, focus movement and drop zones are pure functions with unit tests. Pixel frames are computed from the tree, and inserting a pane redistributes the line evenly
- Tabs (`lib/paneTabs.ts`): each tab holds one layout, and layouts are stored in `localStorage`
- Panes are built by dragging a session row, a terminal header or a shell row, and moved by dragging a pane header. Keyboard shortcuts split, close and move focus
- A session pane is the same conversation view as the single-session page. A shell pane attaches to a shell terminal (section 10)

## 10. Shell terminals

- Shells are sessions of a tmux server that belongs to maru (its own socket, no user configuration file, no status bar and no prefix key). The web server holds one tmux client per open view, attached through `node-pty`, and relays bytes to the view's WebSocket (`/shell`)
- tmux sits under the shells so that a web server restart ends only the tmux clients. The shells keep running, and a view reattaches and reads its scrollback again from tmux. The same shell can also be attached from any terminal with `tmux -S <socket> attach`
- Values from the user (the working folder) are passed to tmux literally, with tmux format and command-separator characters escaped
- The shell environment is a short allowlist, and `MARU_*` variables and the server's own variables are not passed on
- Web: xterm.js (`components/shell/`). Android: xterm.js inside a WebView, with the library embedded in the app bundle

## 11. Devices: pairing, tokens, OTA updates

The device listener is a second port (`MARU_DEVICE_PORT`) on loopback. A reverse proxy decides which port a request reaches, so which listener answers is never decided by anything the client sends. The proxy sends requests that carry `Authorization: Bearer maru_...` to the device listener and everything else, after your own authentication, to the web listener.

Pairing

1. In the web UI a pairing dialog opens an event stream (`GET /api/devices/pairing`) that holds a one-time code for as long as the dialog is open. The kind of device (android or desktop) is fixed by the dialog
2. The app sends the code to `POST /api/device/pair` and receives a device token once
3. The server stores a SHA-256 hash of the token (`devices` table). Removing the row ends the token immediately, and the device's open WebSockets are closed

Secrets: 256 random bits in base64url behind a prefix (`maru_p_` pairing, `maru_d_` device, `maru_u_` update). A desktop pairing also has a short form of 60 bits for typing on another computer.

Access (`devices/access.ts`)

- Android tokens reach an allowlist of routes by method and exact path. Desktop tokens reach everything the web listener serves except device management
- Every request on the device listener is checked for `Host` and, when present, for an `Origin` that must be a page of the host it asks

OTA updates (Android)

- The server implements Expo Updates protocol 1 itself (`mobile/ota.ts`). The manifest is signed when the release is exported (`apps/mobile/scripts/ota-export.mts`), with a private key that stays on the build machine. The server serves the signed bytes and never holds the key. The APK carries the matching certificate and verifies every update
- The runtime version is the native fingerprint. An APK receives only updates with the same runtime version, so a native change needs a new APK
- The update read token (`maru_u_`) is built into every APK and opens only `/ota/*`
- The server can also offer the latest built APK, through a one-time link issued to a paired device

Desktop app

- Electron (`apps/desktop`). The window loads the paired server's web UI, so a web deployment is also the desktop UI update. The main process adds the device token as an `Authorization` header to requests for the server origin, and the page never sees the token
- The pairing screen and the offline screen are the app's own files, served from a custom protocol with a strict CSP
- Self-update: the app checks a manifest that the server serves, signed with the same update key, verifies file hashes, and downloads only changed blocks when it has the previous build

Push notifications are optional (Firebase Cloud Messaging, `push/`): the server sends them for questions and finished turns to devices that registered a token and have no open connection.

## 12. Releases and versions

- Versions have the form `<series>.N` (the series is `0.1` today), where N is the number of commits reachable from the built commit, so the same commit always gets the same version and no state file is needed. Outside a release a checkout reports `-dev`
- The author's deploy script (not published) exports a commit with `git archive`, installs and checks it (typecheck and tests of every package, web build, Android check and OTA export, desktop check and build), and switches a `current` link only when all of it passes. The server then runs from that fixed copy instead of from the working folder, so half-edited code is never served
- State and sockets live outside the release folder, so switching releases keeps them
