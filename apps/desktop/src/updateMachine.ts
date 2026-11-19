// The shell update's state (DESIGN.md 2e), a pure reducer after T3 Code's updates/updateMachine.ts.
// The app downloads a newer build as soon as it sees it (T3 asks first), so the "available" step
// of T3 is the start of "downloading". A build already downloaded stays ready through a later
// failed check, as in T3.
import type { DesktopUpdateState } from "@maru/shared";

export type UpdateEvent =
  | { type: "check-start" }
  | { type: "check-failed"; message: string; at: number }
  | { type: "no-update"; at: number }
  | { type: "download-start"; version: string; total: number }
  | { type: "download-progress"; received: number }
  /** A differential download knows how many bytes it will fetch once it has compared blocks. */
  | { type: "download-total"; total: number }
  | { type: "download-failed"; message: string; at: number }
  | { type: "downloaded"; version: string }
  | { type: "install-failed"; message: string; at: number };

export interface UpdateModel {
  state: DesktopUpdateState;
  /** The build on disk, ready to install, whatever the state shows. */
  downloaded: string | null;
}

export function initialModel(disabledReason: string | null): UpdateModel {
  return { state: disabledReason ? { status: "disabled", reason: disabledReason } : { status: "idle" }, downloaded: null };
}

export function reduce(m: UpdateModel, e: UpdateEvent): UpdateModel {
  if (m.state.status === "disabled") return m;
  const ready = (): DesktopUpdateState => ({ status: "downloaded", version: m.downloaded! });
  switch (e.type) {
    case "check-start":
      return { ...m, state: { status: "checking" } };
    case "check-failed":
      return { ...m, state: m.downloaded ? ready() : { status: "error", context: "check", message: e.message, checkedAt: e.at } };
    case "no-update":
      return { ...m, state: m.downloaded ? ready() : { status: "up-to-date", checkedAt: e.at } };
    case "download-start":
      return { ...m, state: { status: "downloading", version: e.version, received: 0, total: e.total } };
    case "download-progress":
      return m.state.status === "downloading" ? { ...m, state: { ...m.state, received: e.received } } : m;
    case "download-total":
      return m.state.status === "downloading" ? { ...m, state: { ...m.state, total: e.total } } : m;
    case "download-failed":
      return { ...m, state: m.downloaded ? ready() : { status: "error", context: "download", message: e.message, checkedAt: e.at } };
    case "downloaded":
      return { state: { status: "downloaded", version: e.version }, downloaded: e.version };
    case "install-failed":
      return { ...m, state: { status: "error", context: "install", message: e.message, checkedAt: e.at } };
  }
}
