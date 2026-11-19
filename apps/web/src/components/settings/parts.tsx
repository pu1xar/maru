// Small pieces shared by the settings pages: provider icon, byte and time text, the table pager.
// Drawn with the app's T3 parts (ui/button) and the sidebar's provider icons.
import type { ProviderId } from "@maru/shared";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { pagerItems } from "./manageModel";

/** T3 ProviderInstanceIcon, as the sidebar draws it: Codex in the foreground color, Claude in its orange. */
export function ProviderIcon({ provider, className }: { provider: ProviderId; className?: string }) {
  return provider === "claude" ? (
    <ClaudeAI aria-label="Claude" className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <OpenAI aria-label="Codex" className={cn("size-3.5 shrink-0 text-black dark:text-white", className)} />
  );
}

export { formatSize, formatWhen } from "./parts.logic";

/** Page buttons around the current page, and the count line ("전체 N개 중 M개"). */
export function Pager(props: { page: number; pages: number; onPage: (p: number) => void; info: string }) {
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-center gap-1 px-3 py-2.5 sm:px-4">
      {props.pages > 1 ? (
        <>
          <Button size="icon-xs" variant="ghost-muted" aria-label="Previous page" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>
            <ChevronLeftIcon />
          </Button>
          {pagerItems(props.page, props.pages).map((p, i) =>
            p === null ? (
              <span key={`gap-${i}`} aria-hidden className="px-1 text-xs text-muted-foreground">
                ...
              </span>
            ) : (
              <Button
                key={p}
                size="xs"
                variant={p === props.page ? "secondary" : "ghost-muted"}
                aria-current={p === props.page ? "page" : undefined}
                className="min-w-7 tabular-nums"
                onClick={() => props.onPage(p)}
              >
                {p}
              </Button>
            ),
          )}
          <Button size="icon-xs" variant="ghost-muted" aria-label="Next page" disabled={props.page >= props.pages} onClick={() => props.onPage(props.page + 1)}>
            <ChevronRightIcon />
          </Button>
        </>
      ) : null}
      <span className="mx-2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {props.info}
      </span>
    </nav>
  );
}
