// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/ShellCommandBlock.tsx
// Local changes: the command is colored as bash by SyntaxHighlight.tsx (highlight.js) instead of
// the @pierre/diffs grammar with embedded-script detection. Until the highlighter loads, the
// plain words render with the same word spans, so lines break at the same places.
import { withVisibleControlCharacters } from "../../client-runtime/work-log/commandLabel.ts";
import { SyntaxTokens, useSyntaxTokens } from "./SyntaxHighlight";

const WORD_CLASS_NAME = "inline-block max-w-full [overflow-wrap:anywhere]";

function PlainWords({ code }: { code: string }) {
  return code.split(/(\s+)/u).map((part, index) =>
    index % 2 === 1 || part === "" ? (
      part
    ) : (
      // Positions are stable for one string.
      <span key={index} className={WORD_CLASS_NAME}>
        {part}
      </span>
    ),
  );
}

export function ShellCommandBlock({ command }: { command: string }) {
  const code = withVisibleControlCharacters(command.trim());
  const tokens = useSyntaxTokens(code, "bash");
  if (!code) return null;
  return (
    <div className="text-foreground/85">
      {tokens ? (
        <SyntaxTokens tokens={tokens} wordClassName={WORD_CLASS_NAME} />
      ) : (
        <PlainWords code={code} />
      )}
    </div>
  );
}
