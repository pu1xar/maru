// The web's two glyphs that are not lucide icons, drawn from the web's own SVG paths with
// react-native-svg: the browser app icon of a tool row (TimelineToolActivityIcon.tsx BrowserAppIcon)
// and the composer's send arrow (ThreadComposer.tsx). IconComponent is the shape both these and
// lucide's icons share, so a table can hold either.
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

export interface IconProps {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}
export type IconComponent = ComponentType<IconProps>;

export function BrowserAppIcon({ size = 24, color = "#000000", style }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <Path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <Circle cx={7.4} cy={7.2} r={0.75} fill={color} stroke="none" />
      <Path d="M11.2 7.2h4.3" />
      <Path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill={color} stroke="none" />
    </Svg>
  );
}

/** The web's send arrow: a 14 box, stroke 1.8 (a send button draws it at 14). */
export function SendArrowIcon({ size = 14, color = "#000000", style }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={style}>
      <Path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
