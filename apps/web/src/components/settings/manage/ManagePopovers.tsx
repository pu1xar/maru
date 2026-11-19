// The session management toolbar's filter form and its dialogs. What they hold follows the
// an earlier dashboard's MANAGE page (the earlier dashboard MANAGE_HTML: #filterPopover, openTrash(),
// deleteUnit()): size and period filters with reset and done, the trash with restore, purge and
// purge-all, the permanent unit delete. The look is the app's (T3 popover, dialog, toggle group,
// select, number field, calendar and buttons, adapted in components/ui; a date opens a calendar
// popover as in T3's CustomSnoozeDialog). Local change: the form also holds this app's provider,
// account and list facets, and purging the whole trash lists each entry's outcome.
import type { PurgeTrashResult, TrashItem, UnitRow } from "@maru/shared";
import { CalendarIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { deleteUnit, describeError, purgeTrash } from "~/projectsApi";
import { TrashEntries, refreshTrash, trashSummary, useTrash } from "../../SessionManageDialogs";
import { Button } from "../../ui/button";
import { Calendar } from "../../ui/calendar";
import { dayKey, parseDayKey } from "../../ui/calendarGrid";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../../ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { BulkRunDialog, type BulkJob } from "../BulkRunDialog";
import { EMPTY_FIELDS, SLIDER_STEPS, kbToSliderPos, shortAccount, sliderPosToKb, type FilterFields } from "../manageModel";
import { formatSize } from "../parts";
import { plural } from "../../../lib/plural.ts";

export { EMPTY_FIELDS, type FilterFields };

const ALL_ACCOUNTS = "__all__";

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-3">
      <span className="text-xs leading-7 font-medium text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}

/** The filter form: size (a log slider and KB boxes), period, and this app's facets; reset and done. */
export function FilterForm(props: {
  fields: FilterFields;
  onChange: (next: FilterFields) => void;
  /** The slider's top, in KB. */
  maxKb: number;
  accounts: readonly string[];
  facets: number;
  onDone: () => void;
}) {
  const { fields: f, maxKb } = props;
  const set = (patch: Partial<FilterFields>) => props.onChange({ ...f, ...patch });
  const minPos = kbToSliderPos(f.minKb === "" ? 0 : Number(f.minKb), maxKb);
  const maxPos = f.maxKb === "" ? SLIDER_STEPS : Math.max(minPos, kbToSliderPos(Number(f.maxKb), maxKb));
  return (
    <div className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-3">
      <Field label="Size KB">
        <span className="relative h-7 min-w-36 flex-1" title="Size range (log scale)">
          <span className="pointer-events-none absolute inset-x-[7px] top-[13px] h-[3px] rounded-sm bg-input">
            <span className="absolute h-full rounded-sm bg-primary" style={{ left: `${minPos / 10}%`, width: `${Math.max(0, maxPos - minPos) / 10}%` }} />
          </span>
          <input
            type="range"
            min={0}
            max={SLIDER_STEPS}
            value={minPos}
            aria-label="Minimum size slider"
            className="range-thumbs"
            onChange={(e) => {
              const pos = Math.min(Number(e.currentTarget.value), maxPos);
              set({ minKb: pos === 0 ? "" : String(sliderPosToKb(pos, maxKb)) });
            }}
          />
          <input
            type="range"
            min={0}
            max={SLIDER_STEPS}
            value={maxPos}
            aria-label="Maximum size slider"
            className="range-thumbs"
            onChange={(e) => {
              const pos = Math.max(Number(e.currentTarget.value), minPos);
              set({ maxKb: pos === SLIDER_STEPS ? "" : String(sliderPosToKb(pos, maxKb)) });
            }}
          />
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <KbField label="Minimum size KB" placeholder="Min" value={f.minKb} onChange={(minKb) => set({ minKb })} />
          <span aria-hidden className="text-muted-foreground">-</span>
          <KbField label="Maximum size KB" placeholder="Max" value={f.maxKb} onChange={(maxKb) => set({ maxKb })} />
        </span>
      </Field>
      <Field label="Period">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <DateField
            label="Start date"
            placeholder="Start"
            value={f.from}
            onChange={(from) => set({ from })}
            disabled={(d) => f.to !== "" && dayKey(d) > f.to}
          />
          <span aria-hidden className="text-muted-foreground">-</span>
          <DateField
            label="End date"
            placeholder="End"
            value={f.to}
            onChange={(to) => set({ to })}
            disabled={(d) => f.from !== "" && dayKey(d) < f.from}
          />
        </span>
      </Field>
      <Field label="Kind">
        <ToggleGroup
          aria-label="Kind"
          value={[f.provider]}
          onValueChange={(v) => {
            const next = v[0];
            if (next === "all" || next === "claude" || next === "codex") set({ provider: next, account: "" });
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="claude">Claude</ToggleGroupItem>
          <ToggleGroupItem value="codex">Codex</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field label="Account">
        <Select
          value={f.account || ALL_ACCOUNTS}
          onValueChange={(v) => {
            if (typeof v === "string") set({ account: v === ALL_ACCOUNTS ? "" : v });
          }}
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Account">
            <SelectValue>{f.account ? shortAccount(f.account) : "All accounts"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={ALL_ACCOUNTS}>
              All accounts
            </SelectItem>
            {props.accounts.map((a) => (
              <SelectItem hideIndicator key={a} value={a}>
                {shortAccount(a)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field label="List">
        <ToggleGroup
          aria-label="List"
          value={[f.list]}
          onValueChange={(v) => {
            const next = v[0];
            if (next === "all" || next === "in" || next === "out") set({ list: next });
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="in">In list</ToggleGroupItem>
          <ToggleGroupItem value="out">Not in list</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <div className="flex items-center justify-between border-t border-border pt-3">
        <Button size="xs" variant="ghost-muted" disabled={props.facets === 0} onClick={() => props.onChange(EMPTY_FIELDS)}>
          <RotateCcwIcon />
          Reset
        </Button>
        <Button size="xs" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** A KB bound (T3 NumberField): the slider moves it by steps, the box takes a typed value. */
function KbField(props: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <NumberField
      size="sm"
      min={0}
      step={1}
      format={{ maximumFractionDigits: 0 }}
      value={props.value === "" ? null : Number(props.value)}
      onValueChange={(v) => props.onChange(v === null || !Number.isFinite(v) ? "" : String(Math.max(0, Math.round(v))))}
      className="min-w-0 flex-1"
    >
      <NumberFieldGroup>
        <NumberFieldInput aria-label={props.label} placeholder={props.placeholder} className="text-right" />
      </NumberFieldGroup>
    </NumberField>
  );
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric" });
/** `11/8/2026`: the numeric date as a label. */
const dayText = (d: Date) => DAY_FORMAT.format(d).replace(/\.$/, "");

/**
 * A day bound (`YYYY-MM-DD` or empty): an outline button that opens T3's calendar in a popover,
 * as T3's CustomSnoozeDialog picks its date; a set day has a clear button beside it.
 */
function DateField(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: (date: Date) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const day = parseDayKey(props.value);
  return (
    <span className="relative flex min-w-0 flex-1 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="outline" aria-label={day ? `${props.label} ${dayText(day)}` : props.label} className={cn("w-full min-w-0 justify-between font-normal", day && "pe-7")} />
          }
        >
          <span className={cn("truncate tabular-nums", !day && "text-placeholder")}>{day ? dayText(day) : props.placeholder}</span>
          {day ? null : <CalendarIcon className="size-3.5 text-muted-foreground" />}
        </PopoverTrigger>
        <PopoverPopup align="start" aria-label={props.label}>
          <Calendar
            autoFocus
            selected={day ?? undefined}
            disabled={props.disabled}
            onSelect={(d) => {
              props.onChange(dayKey(d));
              setOpen(false);
            }}
          />
        </PopoverPopup>
      </Popover>
      {day ? (
        <Button size="icon-micro" variant="ghost-muted" className="absolute right-1.5" aria-label={`Clear ${props.label}`} onClick={() => props.onChange("")}>
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </span>
  );
}

/** The trash (opened from the toolbar's trash button), with the whole-trash purge. */
export function TrashModal(props: { open: boolean; onClose: () => void }) {
  const list = useTrash();
  const items = list?.items ?? [];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the trash again each time the dialog opens
  useEffect(() => {
    if (props.open) refreshTrash();
  }, [props.open]);
  const [bulk, setBulk] = useState<{ seq: number; open: boolean; job: BulkJob<TrashItem, PurgeTrashResult> } | null>(null);
  const purgeAll = () =>
    setBulk((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      open: true,
      job: {
        title: `Permanently delete ${plural(items.length, "item")} in Trash?`,
        description: `This cannot be undone. ${formatSize(list?.totalBytes ?? 0)}`,
        confirmLabel: "Delete permanently",
        items: [...items].sort((a, b) => b.deletedAt - a.deletedAt),
        label: (t) => t.name || t.id,
        sublabel: (t) => `${shortAccount(t.account)}, ${formatSize(t.sizeBytes)}`,
        run: (t) => purgeTrash(t.key),
        detail: (r) => `${formatSize(r.freedBytes)} freed`,
        onFinished: () => refreshTrash(),
      },
    }));
  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(next) => {
          if (!next) props.onClose();
        }}
      >
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trash</DialogTitle>
            {items.length || list?.unreadable.length ? <DialogDescription>{trashSummary(list)}</DialogDescription> : null}
          </DialogHeader>
          <DialogPanel className="max-h-[60vh] overflow-y-auto p-0">
            <TrashEntries list={list} itemClassName="border-b border-border/60 px-6 last:border-b-0" />
          </DialogPanel>
          {items.length ? (
            <DialogFooter>
              <Button size="xs" variant="destructive-outline" onClick={purgeAll}>
                <Trash2Icon />
                Delete all permanently
              </Button>
            </DialogFooter>
          ) : null}
        </DialogPopup>
      </Dialog>
      {bulk ? (
        <BulkRunDialog
          key={bulk.seq}
          open={bulk.open}
          job={bulk.job}
          onClose={() => setBulk((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setBulk((prev) => (prev && !prev.open ? null : prev))}
        />
      ) : null}
    </>
  );
}

/** Confirms a unit's permanent delete. */
export function DeleteUnitDialog(props: {
  open: boolean;
  unit: UnitRow;
  onClose: () => void;
  onClosed: () => void;
  onDeleted: (u: UnitRow) => void;
}) {
  const { unit: u } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // The row leaves the table, so no toast: it would sit over the page's header controls.
      await deleteUnit({ provider: "claude", account: u.account, id: u.id, kind: u.kind, unitId: u.unitId });
      props.onDeleted(u);
      props.onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !busy) props.onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Delete {u.kind} {u.unitId}?
          </DialogTitle>
          <DialogDescription>
            Permanently deleted without going through Trash. {formatSize(u.sizeBytes)}, {plural(u.files, "file")}
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />} disabled={busy}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void run()}>
            {busy ? "Deleting" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
