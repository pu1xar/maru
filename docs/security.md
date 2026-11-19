# Security model

This page is the full version of the summary in the README. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

maru starts agents with permission prompts off (Claude with `bypassPermissions`, Codex with approval policy `never` and full filesystem access) and opens shells. Whoever can use the UI can run commands as your user. The web listener has no login, so that includes every process on this Mac and every other OS user of this Mac: a request without an `Origin` header (curl, a script) passes the checks below and can start a shell.

- Network binding: the web listener binds to `127.0.0.1`, so other machines cannot reach it directly. On this machine the port is open to every local process and user. The `Host` and `Origin` checks stop web pages (DNS rebinding, cross-site requests), not local programs. On a Mac with several users, each of them controls your agents
- The web listener has no login of its own. Its protections are
  - `Host` check: a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (plus `MARU_HOSTS`) is refused with 403, which blocks DNS rebinding
  - `Origin` check: a browser request with an `Origin` that is not in the allowed list (loopback plus `MARU_ORIGINS`) is refused for HTTP and WebSocket
- Devices (the Android and desktop apps) connect to a second listener, the device listener, on `MARU_DEVICE_PORT` (also loopback, started only when the variable is set). Source: `apps/server/src/devices/`
  - Pairing: in the web UI (Settings, Devices) you open a pairing dialog. It shows a one-time code (a QR code for Android, a short code or link for desktop) that is valid while the dialog is open. The app sends it to `POST /api/device/pair` and receives a device token
  - Secrets are 256 random bits with a prefix (`maru_p_` pairing code, `maru_d_` device token, `maru_u_` update token). The server stores only their SHA-256 hashes. Pairing codes live in memory and end when the dialog closes or when a restart happens
  - Every request and WebSocket upgrade on the device listener is checked, and a request that names an `Origin` must come from a page of the host it asks. Removing a device in the web UI closes its open sockets at once
  - What a token reaches depends on the device kind, which the pairing code fixes. An Android token reaches an allowlist of routes (sessions, messages, rewind and fork, session management, attachments, shells, pictures). A desktop token reaches everything the web listener serves except device management. Device management exists only on the web listener
  - The OTA update token, built into every APK, opens only the update routes
- Session host: a unix socket in `~/.config/maru/`, mode 0600. The host runs Claude with permissions bypassed, so the socket is a command execution path for your user
- To reach maru from outside the machine, put it behind a reverse proxy that you configure and that authenticates users first
  - Route requests that carry `Authorization: Bearer maru_...` to the device port, and send everything else through your authentication to the web port
  - Add the public hostname to `MARU_HOSTS` (and `MARU_DEVICE_HOSTS`) and its origin, such as `https://maru.example.com`, to `MARU_ORIGINS`. Browser requests through the proxy carry that origin, and without it they fail the `Origin` check (`apps/server/src/http/guard.ts`). Serve HTTPS. The apps accept only `https` server addresses, with `http` allowed for loopback
  - Without your own authentication in front, anyone who can reach the web port controls the agents

