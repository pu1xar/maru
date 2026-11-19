// A session's activity as the web draws it (sessionPresentation.ts TOP_STATUS), with the same lucide
// icons: a ring while the main agent works (CircleIcon), a dashed ring while only subagents or
// workflows do (CircleDashedIcon), and an icon for a question (MessageCircleQuestionIcon) or a
// failure (CircleAlertIcon).
import { CircleAlertIcon, CircleDashedIcon, CircleIcon, MessageCircleQuestionIcon } from "lucide-react-native";
import type { SessionMark } from "../../lib/sessionMark.ts";
import { usePalette } from "../../theme.ts";
import { useSidebarColors } from "./useSidebarColors.ts";

export function ActivityMark(props: { mark: SessionMark; size: number }) {
  const p = usePalette();
  const sc = useSidebarColors();
  const { mark, size } = props;
  // The web's icon colors: info-foreground, attention, error-foreground.
  const color = mark.role === "info" ? p.info : mark.role === "attention" ? p.attention : sc.errorForeground;
  if (mark.shape === "solid") return <CircleIcon size={size} color={color} />;
  if (mark.shape === "dashed") return <CircleDashedIcon size={size} color={color} />;
  if (mark.shape === "question") return <MessageCircleQuestionIcon size={size} color={color} />;
  return <CircleAlertIcon size={size} color={color} />;
}
