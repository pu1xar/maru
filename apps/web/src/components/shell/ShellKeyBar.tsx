// Keys a phone's keyboard lacks, under the shell on a touch screen (DESIGN.md 6s). Ctrl latches for
// the next key typed. A press keeps the keyboard up: the buttons never take the focus.
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ShellBarKey as KeyName } from "~/lib/shellKeys";
import { cn } from "~/lib/utils";

export function ShellKeyBar({ ctrl, onCtrl, onKey }: { ctrl: boolean; onCtrl: () => void; onKey: (name: KeyName) => void }) {
  return (
    <div role="toolbar" aria-label="Terminal keys" data-shell-keybar="" className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 bg-black/40 px-2 py-1">
      <Key label="Esc" onPress={() => onKey("esc")}>Esc</Key>
      <Key label="Tab" onPress={() => onKey("tab")}>Tab</Key>
      <Key label="Ctrl" pressed={ctrl} onPress={onCtrl}>Ctrl</Key>
      <Key label="Ctrl+C" onPress={() => onKey("ctrl-c")}>^C</Key>
      <Key label="Left" onPress={() => onKey("left")}><ArrowLeftIcon className="size-4" /></Key>
      <Key label="Up" onPress={() => onKey("up")}><ArrowUpIcon className="size-4" /></Key>
      <Key label="Down" onPress={() => onKey("down")}><ArrowDownIcon className="size-4" /></Key>
      <Key label="Right" onPress={() => onKey("right")}><ArrowRightIcon className="size-4" /></Key>
    </div>
  );
}

function Key({ label, pressed, onPress, children }: { label: string; pressed?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      // The terminal keeps the focus (and the phone its keyboard).
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        "inline-flex h-8 min-w-10 shrink-0 items-center justify-center rounded-md px-2 font-mono text-xs text-white/85",
        pressed ? "bg-white/30" : "bg-white/10 active:bg-white/25",
      )}
    >
      {children}
    </button>
  );
}
