// The screen chrome's colors for the current theme (lib/chromeColors.ts has the roles and where they come from).
import { useColorScheme } from "react-native";
import { darkChrome, lightChrome, type ChromeColors } from "../../lib/chromeColors.ts";

export function useChrome(): ChromeColors {
  return useColorScheme() === "light" ? lightChrome : darkChrome;
}
