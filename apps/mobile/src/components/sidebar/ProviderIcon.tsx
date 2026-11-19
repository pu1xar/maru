// The provider marks the web's sidebar shows (components/Icons.tsx: Claude in its orange, OpenAI in
// the foreground color), as images made from those same paths (assets/providers). An image is an
// asset the over-the-air update carries.
import { Image } from "react-native";
import type { ProviderId } from "@maru/shared";
import { usePalette } from "../../theme.ts";

const CLAUDE = require("../../../assets/providers/claude.png") as number;
const OPENAI = require("../../../assets/providers/openai.png") as number;

export function ProviderIcon(props: { provider: ProviderId; size: number; opacity?: number }) {
  const p = usePalette();
  const { provider, size } = props;
  return (
    <Image
      source={provider === "claude" ? CLAUDE : OPENAI}
      // The OpenAI mark is one color; it takes the text color, as the web's `text-foreground`.
      style={[{ width: size, height: size, opacity: props.opacity ?? 1 }, provider === "codex" ? { tintColor: p.text } : null]}
      resizeMode="contain"
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
