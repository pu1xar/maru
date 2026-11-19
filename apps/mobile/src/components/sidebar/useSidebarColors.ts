// The drawer's colors for the current theme (lib/sidebarColors.ts has the roles and where they come from).
import { useColorScheme } from "react-native";
import { darkSidebar, lightSidebar, type SidebarColors } from "../../lib/sidebarColors.ts";

export function useSidebarColors(): SidebarColors {
  return useColorScheme() === "light" ? lightSidebar : darkSidebar;
}
