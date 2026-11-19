// The sidebar's and the right panel's zoom without the browser (areaZoom.ts keeps the wheel, the
// storage and the hooks): the areas, the steps, the defaults and the storage keys. The Android app
// reads the sidebar's steps and key from here.
import { rangeOfSteps } from "./settingControl.logic.ts";

/** The areas whose value lives in areaZoom.ts. */
export type ScaledArea = "sidebar" | "panel";

/** The sidebar's and the right panel's steps (percent). */
export const AREA_ZOOM_STEPS: readonly number[] = [85, 90, 100, 110, 120, 135, 150];
/** The whole percents a typed sidebar or panel scale may take: from the first to the last step (the wheel moves on the steps). */
export const AREA_ZOOM_RANGE = rangeOfSteps(AREA_ZOOM_STEPS);
export const DEFAULT_AREA_ZOOM = 100;
/** Each scaled area's default: the sidebar at 90% (the user's own setting made the default, 2026-11-16). */
export const AREA_ZOOM_DEFAULTS: Record<ScaledArea, number> = { sidebar: 90, panel: DEFAULT_AREA_ZOOM };

export const AREA_ZOOM_STORAGE_KEY: Record<ScaledArea, string> = {
  sidebar: "maru_sidebar_zoom",
  panel: "maru_right_panel_zoom",
};
