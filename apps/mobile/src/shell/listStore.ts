// The shells as the app reads them (DESIGN.md 6s; the web's lib/shellList.ts for one page): one list
// from the server, shared by the drawer's Terminal group and the shell screen, so both list the
// same shells under the same names. React-free: the store takes the api and is read through
// subscribe and snapshot (useShells.ts wraps it). The folder rule for a new shell, the tab names
// and what ending a shell leaves behind are the web's own (lib/shellTabs.ts).
import type { ShellInfo } from "@maru/shared";
import { newShellCwd } from "../../../web/src/lib/shellTabs.ts";
import type { ShellApi } from "./api.ts";

export interface ShellListState {
  /** Every shell the server has; null before the first read. */
  shells: ShellInfo[] | null;
  /** A shell is being made. */
  creating: boolean;
}

export class ShellListStore {
  private state: ShellListState = { shells: null, creating: false };
  /** Bumped by every change this store makes: a read that began before one may not list it, so it is not used. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private making: Promise<ShellInfo> | null = null;
  private readonly api: ShellApi;

  constructor(api: ShellApi) {
    this.api = api;
  }

  getSnapshot = (): ShellListState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Partial<ShellListState>): void {
    this.state = { ...this.state, ...next };
    for (const l of [...this.listeners]) l();
  }

  /** Reads the list. A failed read leaves it as it was; the caller polls again. Resolves with the ids the read listed, or null when it was not used. */
  async refresh(): Promise<ReadonlySet<string> | null> {
    const gen = this.generation;
    let next: ShellInfo[];
    try {
      next = await this.api.list();
    } catch {
      return null;
    }
    if (gen !== this.generation) return null;
    this.set({ shells: next });
    return new Set(next.map((s) => s.id));
  }

  /**
   * Makes a shell in `sessionCwd` (the folder of the session the screen covers) and adds it to the
   * list. The home folder starts it when there is no usable folder or the server says the folder
   * is gone, as the web does. A second call while one is on its way gets that one's shell, so a
   * tap and the screen's first-open rule cannot make two.
   */
  create(sessionCwd: string | null | undefined): Promise<ShellInfo> {
    if (this.making) return this.making;
    const run = async (): Promise<ShellInfo> => {
      const cwd = newShellCwd(sessionCwd);
      let shell: ShellInfo;
      try {
        shell = await this.api.create({ cwd });
      } catch (err) {
        if (cwd === null) throw err;
        shell = await this.api.create({ cwd: null });
      }
      this.generation++;
      this.set({ shells: [...(this.state.shells ?? []).filter((s) => s.id !== shell.id), shell] });
      return shell;
    };
    this.set({ creating: true });
    this.making = run().finally(() => {
      this.making = null;
      this.set({ creating: false });
    });
    return this.making;
  }

  /** Takes a shell that is over (ended here, or exited) out of the list at once; a read that began before is not used. */
  forget(id: string): void {
    this.generation++;
    const shells = this.state.shells;
    if (!shells?.some((s) => s.id === id)) return;
    this.set({ shells: shells.filter((s) => s.id !== id) });
  }

  /** Ends the shell on the server (the caller then calls shellGone). A failure leaves everything as it was and is thrown. */
  close(id: string): Promise<void> {
    return this.api.close(id);
  }
}
