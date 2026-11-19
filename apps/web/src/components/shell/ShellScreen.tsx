// The terminal screen (DESIGN.md 6s): the main area shows every shell as a tab, like the split
// view's tab strip (SplitTabs.tsx) and in the place of the conversation the way the dashboard does.
// The shells are the server's (so every browser sees the same ones) and belong to no session; a tab
// shows one shell's terminal (ShellView). Closing the screen keeps the shells running; a tab's close
// button ends its shell, and ending the last one closes the screen. The tabs read the page's one shell
// list (lib/shellList.ts) and its shown tab (shellTabs.ts), which the sidebar's terminal group reads
// too, so the two always list and select the same shells.
import type { ShellInfo } from "@maru/shared";
import { MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { createShellIn, refreshShells, useActiveShellId, useShellList } from "~/lib/shellList";
import { cycleShell, pickActive, rememberActiveShell, shellLabels } from "~/lib/shellTabs";
import { matchShellKey, shellKeyLabels } from "~/lib/shellKeys";
import { takeNewShellRequest, useNewShellRequests } from "~/lib/terminalRoute";
import { cn } from "~/lib/utils";
import { PageHeader } from "../PageHeader";
import { BAR_LINE_CLASS, StripButton, TAB_CLASS, TAB_STATE_CLASS } from "../split/SplitTabs";
import { ShellActionMenu, useAnchoredMenu } from "../ProjectMenus";
import { Button } from "../ui/button";
import { endShell, openShellInSplit, shellGone } from "./shellActions";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../PaneHeader";

const ShellView = lazy(() => import("./ShellView"));

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const KEYS = shellKeyLabels(IS_MAC);

/**
 * `sessionCwd` is the folder of the session the screen covers (the focused pane's in the split
 * view); a new shell starts there.
 */
export function ShellScreen({ sessionCwd }: { sessionCwd: string | null }) {
  // The page's shell list, read every few seconds while the screen shows (tab names follow the foreground command).
  const shells = useShellList(true);
  const activeId = useActiveShellId();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [focusSeq, setFocusSeq] = useState(1);
  const autoCreated = useRef(false);
  const creatingRef = useRef(false);
  const coarse = useMediaQuery("(pointer: coarse)");
  const requests = useNewShellRequests();
  const menu = useAnchoredMenu<string>();
  const active = pickActive(shells ?? [], activeId);
  const latest = useRef({ shells, active, sessionCwd });
  latest.current = { shells, active, sessionCwd };

  const create = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const shell = await createShellIn(latest.current.sessionCwd);
      rememberActiveShell(shell.id);
      setFocusSeq((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const select = (id: string) => {
    rememberActiveShell(id);
    setFocusSeq((n) => n + 1);
  };

  const end = async (id: string) => {
    try {
      await endShell(id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // A tab picked from the sidebar changes the shown shell without a click here: the terminal takes the keyboard.
  useEffect(() => {
    if (active) setFocusSeq((n) => n + 1);
  }, [active]);

  // The list is read now rather than at the next poll (the sidebar may have read it a while ago).
  useEffect(() => {
    void refreshShells();
  }, []);

  // A new shell: asked for by a key (lib/terminalRoute.ts), or the first open with none to show
  // (T3's drawer opens a terminal the same way). Waits for the first read of the list.
  useEffect(() => {
    if (shells === null) return;
    const asked = takeNewShellRequest();
    if (asked || (shells.length === 0 && !autoCreated.current)) {
      autoCreated.current = true;
      void create();
    }
    // Runs for each request and each list read.
  }, [requests, shells]);

  // The tab keys (lib/shellKeys.ts); the toggle and new-shell keys are the page's (useTerminalKeys).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // AltGr is reported as Ctrl+Alt on Windows: a character typed with it is not a shortcut.
      if (!IS_MAC && event.getModifierState("AltGraph")) return;
      const action = matchShellKey(event, IS_MAC);
      if (action !== "prev" && action !== "next") return;
      event.preventDefault();
      event.stopPropagation();
      const cur = latest.current;
      const next = cycleShell(cur.shells ?? [], cur.active, action === "next" ? 1 : -1);
      if (next) select(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const labels = shellLabels(shells ?? []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none" data-terminal-screen="">
      <PageHeader data-shell-tabs="" className="gap-0 border-b-0 p-0 [[data-sidebar-state=collapsed]_&]:pl-0 max-md:[[data-sidebar-state=expanded]_&]:pl-0">
        {/* The header's own padding (the sidebar toggle's room on the left, the window controls' on
            the right) moves into these pieces so the bottom line runs under them (SplitTabs.tsx). */}
        <div aria-hidden className={cn("h-full shrink-0 pl-(--workspace-gutter-start)", BAR_LINE_CLASS, COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS)} />
        <div role="tablist" aria-label="Shell" className="flex h-full w-auto min-w-0 flex-[0_1_auto] overflow-x-auto [scrollbar-width:none]">
          {(shells ?? []).map((s, i) => (
            <ShellTab
              key={s.id}
              shell={s}
              index={i}
              label={labels.get(s.id) ?? s.command}
              active={s.id === active}
              onSelect={() => select(s.id)}
              onEnd={() => void end(s.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                menu.showAtPointer(s.id, event);
              }}
            />
          ))}
        </div>
        <div className={cn("flex h-full shrink-0 items-center px-1", BAR_LINE_CLASS)}>
          <StripButton label={`New shell (${KEYS.create})`} disabled={creating} onClick={() => void create()}>
            {creating ? <Spinner className="size-3.5" /> : <PlusIcon />}
          </StripButton>
        </div>
        {/* The free space after the buttons: the window's drag area, with the bar's line under it. */}
        <div aria-hidden className={cn("h-full min-w-0 flex-1", BAR_LINE_CLASS)} />
        <div className={cn("flex h-full shrink-0 items-center pl-1 pr-[calc(var(--workspace-controls-right)+1px)]", BAR_LINE_CLASS)}>
          <StripButton
            label="Shell menu"
            disabled={!active}
            popup
            onClick={(event) => {
              if (active) menu.toggleFromButton(active, event.currentTarget);
            }}
          >
            <MoreHorizontalIcon />
          </StripButton>
        </div>
      </PageHeader>
      <ShellActionMenu menu={menu} onOpenInSplit={openShellInSplit} onEnd={(id) => void end(id)} />
      <div data-page-surface="" className="relative min-h-0 min-w-0 flex-1 bg-background">
        {error ? (
          <div role="alert" className="absolute inset-x-3 top-3 z-10 rounded-md border border-border bg-popover px-3 py-2 text-xs text-error-foreground">
            {error}
          </div>
        ) : null}
        {shells === null ? (
          <div className="flex h-full items-center justify-center"><Spinner className="size-4" /></div>
        ) : shells.length === 0 && !creating ? (
          <div className="flex h-full items-center justify-center">
            <Button size="sm" variant="outline" onClick={() => void create()}>
              <PlusIcon />
              New shell
            </Button>
          </div>
        ) : (
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-4" /></div>}>
            {shells.map((s) => (
              <ShellView key={s.id} shell={s} active={s.id === active} focusSeq={focusSeq} onGone={shellGone} keyBar={coarse} />
            ))}
          </Suspense>
        )}
      </div>
    </SidebarInset>
  );
}

function ShellTab({
  shell,
  index,
  label,
  active,
  onSelect,
  onEnd,
  onContextMenu,
}: {
  shell: ShellInfo;
  index: number;
  label: string;
  active: boolean;
  onSelect: () => void;
  onEnd: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-active-tab={active}
      className={cn(TAB_CLASS, "w-44", active ? TAB_STATE_CLASS.active : TAB_STATE_CLASS.idle)}
      onContextMenu={onContextMenu}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onEnd();
        }
      }}
      onMouseDown={(event) => {
        // A middle press would start the browser's autoscroll; its click ends the shell.
        if (event.button === 1) event.preventDefault();
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-shell-tab={shell.id}
        title={shell.path}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 outline-none focus-visible:underline"
        onClick={onSelect}
      >
        <span aria-hidden className="shrink-0 tabular-nums text-muted-foreground/70">
          {index + 1}
        </span>
        <span className="truncate font-mono text-xs">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`End shell: ${label}`}
        title="End shell"
        className={cn(
          "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:size-7",
          // Touch has no hover: the shown tab keeps its close button, the others have none.
          !active && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 max-sm:hidden",
        )}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onEnd}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
