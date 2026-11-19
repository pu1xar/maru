// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Layout sources: components/AppSidebarLayout.tsx (provider, resizable sidebar, floating toggle) and
// components/threadSidebarWidth.ts (width bounds). Session state and filtering are maru's own,
// and so are the screens in the conversation's place: the split view (lib/panesRoute.ts, DESIGN.md
// 6k), the settings screen (lib/settingsRoute.ts), the dashboard (lib/dashboardRoute.ts) and the
// terminal screen (lib/terminalRoute.ts, DESIGN.md 6s).
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { SessionSummary } from "@maru/shared";

import { AreaZoomScope } from "./components/AreaZoomIndicator.tsx";
import { LeanDragOut } from "./components/LeanDragOut.tsx";
import { SessionDetail } from "./components/SessionDetail.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { SettingsView } from "./components/settings/SettingsView.tsx";
import { SplitWorkspace } from "./components/split/SplitWorkspace.tsx";
import { WorkspaceDndContext } from "./components/split/paneDnd.tsx";
import { paneActions, useFocusedSessionKey } from "./components/split/paneStore.ts";
import { useAreaZoom } from "./lib/areaZoom.ts";
import { GroupNamesContext } from "./lib/groupNames.ts";
import { onOpenSession } from "./lib/openSession.ts";
import { requestFind } from "./lib/pendingFind.ts";
import { onSessionRekey, onSessionSummary, rekeySession } from "./lib/sessionViewState.ts";
import { closeSettings, useMainRoute } from "./lib/settingsRoute.ts";
import { isBareSessionId, keyForSessionId, sessionUrlValue } from "./lib/sessionUrl.ts";
import { lastViewOf, readLastView, sameLastView, writeLastView } from "./lib/lastView.ts";
import { sessionActivity, type SessionActivity } from "./components/sessionPresentation.ts";
import { closeDashboard, useDashboardOpen } from "./lib/dashboardRoute.ts";
import { closeTerminal, useTerminalOpen } from "./lib/terminalRoute.ts";
import { newShellCwd } from "./lib/shellTabs.ts";
import { useTerminalKeys } from "./components/shell/useTerminalKeys.ts";
import { closePanesView, isPanesBase, usePanesBase, usePanesView } from "./lib/panesRoute.ts";
import { ToastProvider } from "./components/ui/toast.tsx";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useMobileSidebarSheetMounted,
  useSidebar,
} from "./components/ui/sidebar.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip.tsx";
import { cn } from "./lib/utils.ts";
import { leaveToShell } from "./lib/shellKeys.ts";
import { getLocalStorageItem, isStoredFiniteNumber, removeLocalStorageItem } from "./lib/storage.ts";
import { groupByProject, sortProjects, type ProviderFilter } from "./model.ts";
import { useSessions } from "./useSessions.ts";
// Loaded on first open: the main chunk stays under the 500 kB warning (DESIGN.md 6j).
const DashboardView = lazy(() =>
  import("./components/dashboard/DashboardView.tsx").then((m) => ({ default: m.DashboardView })),
);

const ShellScreen = lazy(() => import("./components/shell/ShellScreen.tsx").then((m) => ({ default: m.ShellScreen })));

const SIDEBAR_OPEN_STORAGE_KEY = "maru_sidebar_open";
const SIDEBAR_WIDTH_STORAGE_KEY = "maru_sidebar_width";
const SIDEBAR_DEFAULT_WIDTH = 16 * 16;
const SIDEBAR_MIN_WIDTH = 13 * 16;
const MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function resolveSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH);
}

function clampSidebarWidth(width: number, maximumWidth: number): number {
  return Math.min(maximumWidth, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function resolveInitialSidebarWidth(storedWidth: number | null, viewportWidth: number): number {
  const preferred =
    storedWidth === null ? SIDEBAR_DEFAULT_WIDTH : Math.max(SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferred, resolveSidebarMaximumWidth(viewportWidth));
}

function readInitialSidebarWidth(): number {
  try {
    return resolveInitialSidebarWidth(
      getLocalStorageItem(SIDEBAR_WIDTH_STORAGE_KEY, isStoredFiniteNumber),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted sidebar width.", error);
    return resolveInitialSidebarWidth(null, window.innerWidth);
  }
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

export function App() {
  const { sessions, projects, connection, loaded, folded: collapsed, setFolded } = useSessions();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  // The selected session lives in the address (`?s=<session id>`, lib/sessionUrl.ts), so a reload or a
  // shared link opens it. A bare id is looked up into its key below; an old full-key link works too.
  const [selected, setSelectedState] = useState<string | null>(readSelectedFromUrl);
  const setSelected = (key: string | null) => {
    setSelectedState(key);
    // The address follows in the effect below (it leaves `?s=` out under settings and the dashboard).
  };
  const now = useNow(30_000);
  // The conversation, or the settings screen in its place (`?view=settings`).
  const route = useMainRoute();
  // The dashboard (DESIGN.md 6j) takes the conversation's place like the settings screen does.
  const dashboardOpen = useDashboardOpen();
  // The terminal screen (DESIGN.md 6s) is the third screen that covers the conversation.
  const terminalOpen = useTerminalOpen();
  useTerminalKeys(terminalOpen);
  // Settings, the dashboard and the terminal stand in for the conversation, so their address leaves
  // `?s=` out (user request); the chosen session stays in state and comes back to the address with
  // the conversation.
  const overlayShown = route.view === "settings" || dashboardOpen || terminalOpen;
  useEffect(() => {
    writeSelectedToUrl(overlayShown ? null : selected);
  }, [overlayShown, selected]);
  // The split view (DESIGN.md 6k) is the other base view: settings and the dashboard cover it and
  // return to it. There the selected session is the focused pane's, and the single view's `?s=`
  // stays as it was, so each view keeps its own state.
  const panesView = usePanesView();
  const panesBase = usePanesBase();
  const focusedKey = useFocusedSessionKey(panesBase);
  const activeKey = panesBase ? focusedKey : selected;
  // The screen shown is kept per device, so a reload or a relaunch comes back to it (lib/lastView.ts).
  const settingsShown = route.view === "settings";
  useEffect(() => {
    const now = lastViewOf({ selected, panesView, settings: settingsShown, settingsTab: route.tab, dashboard: dashboardOpen, terminal: terminalOpen, panesBase });
    if (!sameLastView(readLastView(), now)) writeLastView(now);
  }, [selected, panesView, settingsShown, route.tab, dashboardOpen, terminalOpen, panesBase]);
  /** Opens a session in the base view: the focused pane of the split view, or the single view. */
  const openHere = (key: string) => (isPanesBase() ? paneActions.open(key) : setSelected(key));
  // A session opened from settings that is not in the list: shown as it was when opened, since
  // /ws only keeps the list's sessions current. A pane reads such a session itself.
  const [peek, setPeek] = useState<SessionSummary | null>(null);
  const openFromSettings = (s: SessionSummary) => {
    if (!isPanesBase()) setPeek(sessions.has(s.key) ? null : s);
    openHere(s.key);
    closeSettings();
  };
  // A conversation opening another session (Codex /fork) opens it here instead of reloading.
  // openHere only reads the base and calls the pane store or setSelected (the state setter and the
  // address writer), so the first one stays valid.
  useEffect(() => onOpenSession(openHere), []);
  // A session that moved to another account (sidebar, settings, the header's account chip, or seen
  // by the split view): the single view's selection follows to the new key in either base view,
  // after its view state went along (lib/sessionViewState.ts). The address keeps the session id,
  // which a move does not change.
  useEffect(() => onSessionRekey((from, to) => setSelectedState((key) => (key === from ? to : key))), []);
  // The off-list session's summary is the one it was opened with; a change made here (a rehome)
  // brings the server's new one.
  useEffect(() => onSessionSummary((s) => setPeek((p) => (p?.key === s.key ? s : p))), []);

  const all = useMemo(() => [...sessions.values()], [sessions]);
  const orderedProjects = useMemo(() => sortProjects(projects), [projects]);
  const groups = useMemo(
    () => groupByProject(all, orderedProjects, { query, provider, activeOnly }),
    [all, orderedProjects, query, provider, activeOnly],
  );
  const counts = useMemo(() => {
    const c: Partial<Record<SessionActivity, number>> = {};
    for (const s of all) {
      const a = sessionActivity(s);
      c[a] = (c[a] ?? 0) + 1;
    }
    return c;
  }, [all]);
  // A bare id from the address: the listed session's key, else the server's answer (off the list).
  useEffect(() => {
    if (!selected || !isBareSessionId(selected)) return;
    const listed = keyForSessionId(selected, sessions.values());
    if (listed) {
      setSelectedState(listed);
      return;
    }
    if (!loaded) return;
    const ctrl = new AbortController();
    fetch(`/api/session?${new URLSearchParams({ id: selected })}`, { signal: ctrl.signal })
      .then((r) => {
        if (r.status === 404) setMissingKey(selected);
        return r.ok ? (r.json() as Promise<{ session: SessionSummary }>) : null;
      })
      .then((b) => {
        if (!b) return;
        setPeek(b.session);
        setSelectedState(b.session.key);
      })
      .catch(() => {
        // Unreachable server: the look-up runs again with the next list.
      });
    return () => ctrl.abort();
  }, [selected, sessions, loaded]);
  const current = selected ? (sessions.get(selected) ?? (peek?.key === selected ? peek : null)) : null;
  // The key the server answered 404 for: the conversation says so instead of the empty state.
  const [missingKey, setMissingKey] = useState<string | null>(null);
  // A session off the list (opened from the settings' full list) comes back after a reload too.
  useEffect(() => {
    if (!selected || isBareSessionId(selected) || sessions.has(selected) || peek?.key === selected) return;
    const ctrl = new AbortController();
    fetch(`/api/session?${new URLSearchParams({ key: selected })}`, { signal: ctrl.signal })
      .then((r) => {
        if (r.status === 404) setMissingKey(selected);
        return r.ok ? (r.json() as Promise<{ session: SessionSummary }>) : null;
      })
      .then((b) => {
        if (b) setPeek(b.session);
      })
      .catch(() => {
        // Unreachable server: the look-up stays pending and runs again with the next list.
      });
    return () => ctrl.abort();
  }, [selected, sessions, peek]);
  const noSession = !selected ? "none" : missingKey === selected ? "missing" : "resolving";
  const groupNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // Folded sidebar Groups are the server's list (DESIGN.md 6v): one key per command, so another
  // client's folds are never overwritten.
  const toggleGroup = (key: string) => setFolded(key, !collapsed.has(key));

  // A clamped drag may not change the width, so viewport changes need their own subscription.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const sidebarMaximumWidth = resolveSidebarMaximumWidth(viewportWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted sidebar width.", error);
    }
    setSidebarWidth(resolveInitialSidebarWidth(null, viewportWidth));
  };
  const sidebarZoom = useAreaZoom("sidebar");
  const sidebarProviderStyle = {
    // The page header's height follows the sidebar's scale (index.css --page-header-height).
    "--sidebar-zoom": String(sidebarZoom / 100),
    "--sidebar-width": `${clampSidebarWidth(sidebarWidth, sidebarMaximumWidth)}px`,
    // T3's default panel animation duration is 0, which leaves panel transitions off.
    "--panel-animation-duration": "0ms",
  } as CSSProperties;

  return (
    <ToastProvider activeSessionKey={activeKey}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations="false"
        storageKey={SIDEBAR_OPEN_STORAGE_KEY}
        style={sidebarProviderStyle}
      >
        {/* One drag context for the page: sidebar rows drop on the list and on split view panes. */}
        <WorkspaceDndContext>
        <Sidebar
          side="left"
          collapsible="offcanvas"
          data-app-sidebar=""
          role="navigation"
          aria-label="Sessions"
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: SIDEBAR_MIN_WIDTH,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
              nextWidth <= currentWidth ||
              wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
            storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
        >
          {/* Ctrl+wheel over the list zooms it (lib/areaZoom.ts); the mark sits under its top bar.
              The rail stays outside, so its drag target keeps its width. */}
          <AreaZoomScope area="sidebar" indicatorClassName="top-[calc(var(--workspace-topbar-height)+0.5rem)] right-3">
            <SessionSidebar
              connection={connection}
              loaded={loaded}
              groups={groups}
              projects={orderedProjects}
              sessions={all}
              counts={counts}
              now={now}
              // In the split view only its own row (보기 menu) is highlighted, not the focused pane's
              // session (user request 2026-11-17).
              selectedKey={panesBase ? null : activeKey}
              onRekey={rekeySession}
              onSelect={(key) => {
                // Picking a session in the sidebar shows it alone (user request 2026-11-16): settings
                // and the dashboard close (no "back" button), and the split view gives way to the
                // single view. The split layout stays stored for the 분할 보기 row; panes are built by
                // dragging sessions onto it. The brand (null) opens the single view with nothing chosen.
                closeSettings();
                closeDashboard();
                closeTerminal();
                closePanesView();
                setSelected(key);
              }}
              collapsed={collapsed}
              onToggleGroup={toggleGroup}
              query={query}
              onQueryChange={setQuery}
              provider={provider}
              onProviderChange={setProvider}
              activeOnly={activeOnly}
              onActiveOnlyChange={setActiveOnly}
              onOpenSearchHit={(hit, session, hitQuery) => {
                // A hit opens its session as a sidebar row does (the single view), off the list
                // too, and the session's find at the hit (DESIGN.md 6u).
                closeSettings();
                closeDashboard();
                closePanesView();
                setPeek(sessions.has(session.key) ? null : session);
                requestFind(session.key, { query: hitQuery, hint: { itemId: hit.itemId, role: hit.role, at: hit.at } });
                setSelected(session.key);
              }}
            />
          </AreaZoomScope>
          <SidebarRail onDoubleClick={resetSidebarWidth} />
        </Sidebar>
        {route.view === "settings" ? (
          <SettingsView route={route} listed={all} now={now} onOpenSession={openFromSettings} onRekey={rekeySession} />
        ) : dashboardOpen ? (
          <Suspense fallback={null}>
            <DashboardView
              sessions={all}
              now={now}
              onOpenSession={(key) => {
                closeDashboard();
                openHere(key);
              }}
            />
          </Suspense>
        ) : terminalOpen ? (
          <Suspense fallback={null}>
            {/* A new shell starts in the covered session's folder (the focused pane's in the split view). */}
            <ShellScreen
              sessionCwd={newShellCwd(activeKey ? (sessions.get(activeKey)?.cwd ?? (peek?.key === activeKey ? peek.cwd : null)) : null)}
            />
          </Suspense>
        ) : panesView ? (
          <GroupNamesContext value={groupNames}>
            <SplitWorkspace sessions={sessions} />
          </GroupNamesContext>
        ) : (
          <GroupNamesContext value={groupNames}>
            <SessionDetail session={current} noSession={noSession} listEmpty={loaded && sessions.size === 0} onClearSelection={() => setSelected(null)} />
          </GroupNamesContext>
        )}
        {/* A session let go outside the window opens its lean window (DESIGN.md 6x). */}
        <LeanDragOut />
        </WorkspaceDndContext>
        {/* Last in the DOM, though it sits top left: the desktop app's window takes the top bars'
            drag and no-drag rectangles in document order, a later one over an earlier one, so the
            toggle's no-drag must come after the sidebar header and the page header it floats over.
            Tab therefore meets it last. */}
        <SidebarControl />
      </SidebarProvider>
    </ToastProvider>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
// T3's default keybinding for sidebar.toggle is mod+b.
const SIDEBAR_SHORTCUT_LABEL = IS_MAC ? "⌘B" : "Ctrl+Shift+B";

/** The floating sidebar toggle from T3's AppSidebarLayout, with its mod+b shortcut. */
function SidebarControl() {
  const { toggleSidebar } = useSidebar();
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();

  // Window keydown listener that toggles the sidebar on its shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      // code, not key: a Korean input source turns the B key into a jamo.
      // Windows and Linux leave Ctrl+B to sending running work to the background, as the CLI does
      // (lib/backgroundTasks.logic.ts), so the sidebar there is Ctrl+Shift+B.
      if (!mod || event.altKey || event.shiftKey !== !IS_MAC || event.code !== "KeyB") return;
      // Outside a Mac this is Ctrl+Shift+B, which a shell that has the keys gets (lib/shellKeys.ts).
      if (leaveToShell(event, IS_MAC)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggleSidebar]);

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={<SidebarTrigger className="pointer-events-auto" aria-label="Toggle sidebar" />}
        />
        <TooltipPopup side="bottom">Toggle sidebar ({SIDEBAR_SHORTCUT_LABEL})</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function readSelectedFromUrl(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get("s");
    // An old link with the full key: keep the key, show the short form in the address.
    if (value && !isBareSessionId(value)) writeSelectedToUrl(value);
    return value;
  } catch {
    return null;
  }
}

function writeSelectedToUrl(key: string | null): void {
  const url = new URL(window.location.href);
  if (key) url.searchParams.set("s", sessionUrlValue(key));
  else url.searchParams.delete("s");
  // The entry keeps its state (the base view it was written with, lib/panesRoute.ts).
  window.history.replaceState(window.history.state, "", url);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
