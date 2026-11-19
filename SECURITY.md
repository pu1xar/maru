# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability" (https://github.com/pu1xar/maru/security/advisories/new).

- Please do not open a public issue or pull request for a vulnerability
- Include the version (`maru x.y.z` at the bottom of the settings menu, or `/healthz`), what you did, what you expected, and what happened
- maru is a personal project. A reply may take some days, and there is no bug bounty

## Security model in short

maru runs coding agents with permission prompts off and opens shells, so anyone who can use its UI can run commands as the user that runs the server. The model that follows from this is documented in the [Security model](README.md#security-model) section of the README. In short:

- The web listener binds to `127.0.0.1` only. It has no login of its own, and it checks the `Host` header (DNS rebinding) and the browser `Origin` (other pages in the same browser)
- The Android and desktop apps connect to a separate device listener (`MARU_DEVICE_PORT`, off by default, also loopback). A one-time pairing code, valid while the pairing dialog is open, is exchanged for a device token. The server stores only SHA-256 hashes of codes and tokens. A device's kind decides which routes its token reaches, and device management is available on the web listener only
- The Claude session host listens on a unix socket with mode 0600
- Reaching maru from outside the machine needs your own authenticating reverse proxy in front of it, with HTTPS
- maru is a single-user tool. It is not meant to host sessions for other people, and Anthropic's terms do not allow routing other users through your Claude plan credentials (see [Authentication and Anthropic's terms](README.md#authentication-and-anthropics-terms))

## Scope

In scope: the server (`apps/server`), the web UI, the desktop and Android apps, the pairing and device token flow, the update signing flow, and the build scripts in this repository.

Out of scope: the Claude Code CLI, the Codex CLI, and the third-party packages that maru depends on (report those to their maintainers), and a deployment that exposes the web port without authentication.

## Supported versions

Only the latest commit on `main` is supported.
