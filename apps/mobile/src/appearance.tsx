// The display settings as the app's components read them: one provider at the root holds the
// stored settings (lib/appearanceStore.ts), the font files that have arrived, and the sizes and
// fonts Text applies (lib/appearance.logic.ts). Everything that reads a color or draws a Text
// reads it here, so a change in Settings shows at once. The theme is the phone's color scheme with
// the choice laid over it (applyTheme), so useColorScheme follows it everywhere.
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { facesFor } from "./lib/appFonts.logic.ts";
import {
  DEFAULT_APPEARANCE,
  NEUTRAL_ENV,
  normalizeAppearance,
  textEnv,
  type AppearancePrefs,
  type TextEnv,
  type TextScope,
} from "./lib/appearance.logic.ts";
import type { AppPalette } from "./lib/appearancePalette.ts";
import { applyTheme, loadAppearance, loadFace, saveAppearance } from "./lib/appearanceStore.ts";

/** Whether a font file is on its way, and why one did not arrive. */
export interface FontStatus {
  loading: boolean;
  error: string | null;
}

export interface Appearance {
  prefs: AppearancePrefs;
  /** False until the stored settings are read; the root shows nothing before, so no screen flashes in the default look. */
  ready: boolean;
  env: TextEnv;
  fonts: FontStatus;
  set(change: Partial<AppearancePrefs>): void;
}

const NOOP_APPEARANCE: Appearance = {
  prefs: DEFAULT_APPEARANCE,
  ready: true,
  env: NEUTRAL_ENV,
  fonts: { loading: false, error: null },
  set: () => undefined,
};

const AppearanceCtx = createContext<Appearance>(NOOP_APPEARANCE);

/** A palette that replaces the page's inside a subtree (the contents of a blue user bubble). */
export const PaletteScope = createContext<AppPalette | null>(null);

const TextScopeCtx = createContext<TextScope>("ui");
/** Whether a Text is inside another: a nested one with no size takes its parent's. */
export const NestedTextCtx = createContext(false);

export function useAppearance(): Appearance {
  return use(AppearanceCtx);
}

export function useTextScope(): TextScope {
  return use(TextScopeCtx);
}

/** Marks a subtree as the conversation or the drawer, whose text sizes and font follow their own settings. */
export function TextScopeProvider(props: { scope: TextScope; children: ReactNode }) {
  return <TextScopeCtx value={props.scope}>{props.children}</TextScopeCtx>;
}

export function AppearanceProvider(props: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_APPEARANCE);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [fonts, setFonts] = useState<FontStatus>({ loading: false, error: null });
  const current = useRef(DEFAULT_APPEARANCE);
  const inFlight = useRef(new Set<string>());
  // Faces whose file did not arrive; a change in Settings tries them again.
  const failed = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    loadAppearance().then(
      (stored) => {
        if (!live) return;
        current.current = stored;
        applyTheme(stored.theme);
        setPrefs(stored);
        setReady(true);
      },
      () => live && setReady(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // The files the chosen fonts need, each fetched once; the text stays in the phone's font until its file is in.
  useEffect(() => {
    if (!ready) return;
    for (const face of facesFor(prefs.uiFont, prefs.chatFont, prefs.monoFont)) {
      if (loaded.has(face.family) || inFlight.current.has(face.family) || failed.current.has(face.family)) continue;
      inFlight.current.add(face.family);
      setFonts({ loading: true, error: null });
      loadFace(face).then(
        () => {
          inFlight.current.delete(face.family);
          setLoaded((prev) => new Set(prev).add(face.family));
          setFonts((f) => ({ loading: inFlight.current.size > 0, error: f.error }));
        },
        (e: unknown) => {
          inFlight.current.delete(face.family);
          failed.current.add(face.family);
          setFonts({ loading: inFlight.current.size > 0, error: e instanceof Error ? e.message : String(e) });
        },
      );
    }
  }, [ready, prefs.uiFont, prefs.chatFont, prefs.monoFont, loaded]);

  const set = useCallback((change: Partial<AppearancePrefs>) => {
    const before = current.current;
    const next = normalizeAppearance({ ...before, ...change });
    current.current = next;
    failed.current.clear();
    saveAppearance(next);
    if (next.theme !== before.theme) applyTheme(next.theme);
    setPrefs(next);
  }, []);

  const env = useMemo(() => textEnv(prefs, loaded), [prefs, loaded]);
  const value = useMemo<Appearance>(() => ({ prefs, ready, env, fonts, set }), [prefs, ready, env, fonts, set]);
  return <AppearanceCtx value={value}>{props.children}</AppearanceCtx>;
}
