// The sheets of the session table: the web's row menu (a sheet of its items), the dialogs of
// ManagePanel.tsx and ManagePopovers.tsx (delete, bulk delete, trash, unit delete, the filter form)
// and the pieces the web does with a native dialog or an inline box, as a phone does them: renaming
// in a sheet's field (the web edits the name in place), the working folder typed as a path with the
// subfolders listed under it (FolderPathInput.tsx; the web's Finder button opens a dialog on the
// Mac, which a phone cannot answer), the size and period filters as typed fields (the web has a log
// slider and a calendar; neither exists in React Native's own parts, and a native module is out of
// scope). Words are English (the interface is moving to English, and new text starts there).
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CheckIcon, RotateCcwIcon, Trash2Icon, XIcon, type LucideIcon } from "lucide-react-native";
import type { SessionSummary, TrashItem, TrashList, UnitRow } from "@maru/shared";
import { dayStart, deleteBytesOf, deleteOutcome, needsSubtreeBytes, runSequential, type BulkResult, type FilterFields } from "../../../../../web/src/components/settings/manageModel.ts";
import { formatSize } from "../../../../../web/src/components/settings/parts.logic.ts";
import { displayName, shortPath } from "../../../../../web/src/model.ts";
import {
  SORT_OPTIONS,
  bulkProgress,
  deleteDescription,
  trashEntries,
  trashMeta,
  trashSummary,
} from "../../../lib/manage.logic.ts";
import { fetchSessionUnits, purgeTrash, restoreTrash } from "../../../lib/manageApi.ts";
import type { Pairing } from "../../../lib/api.ts";
import { usePalette } from "../../../theme.ts";
import { FolderPathInput } from "../../FolderPathInput.tsx";
import { Press } from "../../Press.tsx";
import { ProviderIcon } from "../../sidebar/ProviderIcon.tsx";
import { Btn } from "../../ui/Btn.tsx";
import { Field, Segmented, SelectField, TextField } from "../../ui/Fields.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { ui } from "../../ui/metrics.ts";
import { useChrome } from "../../ui/useChrome.ts";

/** The text of a failed call: the server's `{ error }` reason or the connection failure (lib/api.ts call). */
export const failureText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---- The row menu ----

export interface MenuEntry {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Beside the label: a count, or why the entry cannot run now. */
  detail?: string | null;
  disabled?: boolean;
  destructive?: boolean;
  onPress: () => void;
}

/** The web's ⋮ menu as a sheet: the title is the row, its entries keep their place and say why one cannot run. */
export function MenuSheet(props: { open: boolean; title: string; description?: string | null; entries: readonly MenuEntry[]; onClose: () => void }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title} description={props.description}>
      <View style={{ marginHorizontal: -8 }}>
        {props.entries.map((e) => {
          const color = e.destructive ? c.errorForeground : p.text;
          return (
            <Press
              key={e.key}
              onPress={() => {
                if (!e.disabled) e.onPress();
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={e.detail && e.disabled ? `${e.label}, ${e.detail}` : e.label}
              accessibilityState={{ disabled: !!e.disabled }}
              android_ripple={{ color: c.accent, foreground: true }}
              style={[styles.entry, { opacity: e.disabled ? 0.64 : 1 }]}
            >
              <e.icon size={16} color={e.destructive ? c.errorForeground : p.muted} />
              <Text style={[ui.base, { color, flex: 1, minWidth: 0 }]} numberOfLines={1}>{e.label}</Text>
              {e.detail ? <Text style={[ui.xs, { color: p.muted }]}>{e.detail}</Text> : null}
            </Press>
          );
        })}
      </View>
    </Sheet>
  );
}

// ---- Rename ----

export function RenameSheet(props: { open: boolean; initial: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = useChrome();
  const next = value.trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(next);
      props.onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={props.open}
      onClose={() => !busy && props.onClose()}
      title="Rename session"
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill disabled={busy} onPress={props.onClose} />
          <Btn label="Save" fill busy={busy} disabled={next === "" || next === props.initial} onPress={() => void save()} />
        </>
      }
    >
      <Field label="New name">
        <TextField value={value} onChangeText={setValue} autoFocus selectTextOnFocus autoCorrect={false} editable={!busy} returnKeyType="done" onSubmitEditing={() => next && next !== props.initial && void save()} />
      </Field>
      {error ? <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text> : null}
    </Sheet>
  );
}

// ---- Working folder ----

/** A folder typed as a path, for the session's transcript to move to; the folders the listed sessions use are listed while the field is empty. */
export function RehomeSheet(props: {
  open: boolean;
  pairing: Pairing;
  session: SessionSummary;
  folders: readonly string[];
  onClose: () => void;
  onSave: (cwd: string) => Promise<void>;
}) {
  const c = useChrome();
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (cwd === null) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave(cwd);
      props.onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };
  const current = props.session.cwd;
  const folders = props.folders.filter((f) => f !== current);
  return (
    <Sheet
      open={props.open}
      onClose={() => !busy && props.onClose()}
      title="Change working folder"
      description={`${displayName(props.session)} now works in ${shortPath(current)}`}
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill disabled={busy} onPress={props.onClose} />
          <Btn label="Change folder" fill busy={busy} disabled={cwd === null} onPress={() => void save()} />
        </>
      }
    >
      <Field label="Folder">
        <FolderPathInput
          pairing={props.pairing}
          value={text}
          onValueChange={setText}
          recent={folders}
          onResolved={setCwd}
          reject={(dir) => (dir === current ? "This is the current working folder" : null)}
          editable={!busy}
        />
      </Field>
      {error ? <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text> : null}
    </Sheet>
  );
}

// ---- Delete ----

/** The size the server's delete weighs against the trash threshold, read when the sheet opens (web useDeleteBytes). */
function useDeleteBytes(pairing: Pairing, s: SessionSummary): number | null {
  const [subtree, setSubtree] = useState<{ key: string; bytes: number } | null>(null);
  const needs = needsSubtreeBytes(s);
  useEffect(() => {
    if (!needs) return;
    let live = true;
    fetchSessionUnits(pairing, s.account, s.id)
      .then((u) => live && setSubtree({ key: s.key, bytes: u.totalBytes }))
      .catch(() => {
        // Unknown: the sheet states the rule instead.
      });
    return () => {
      live = false;
    };
  }, [needs, pairing, s.account, s.id, s.key]);
  return deleteBytesOf(s, subtree?.key === s.key ? subtree.bytes : null);
}

/** The web's DeleteSessionDialog: says where the session goes, then deletes it. */
export function DeleteSessionSheet(props: { open: boolean; pairing: Pairing; session: SessionSummary; onClose: () => void; onDelete: () => Promise<void> }) {
  const c = useChrome();
  const bytes = useDeleteBytes(props.pairing, props.session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onDelete();
      props.onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={props.open}
      onClose={() => !busy && props.onClose()}
      title={`Delete "${displayName(props.session)}"?`}
      description={deleteDescription(deleteOutcome(bytes), bytes)}
      closeButton={false}
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill disabled={busy} onPress={props.onClose} />
          <Btn variant="destructive" label="Delete" fill busy={busy} onPress={() => void run()} />
        </>
      }
    >
      {error ? <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text> : null}
    </Sheet>
  );
}

/** The web's DeleteUnitDialog: a unit goes for good, without the trash. */
export function DeleteUnitSheet(props: { open: boolean; unit: UnitRow; onClose: () => void; onDelete: () => Promise<void> }) {
  const c = useChrome();
  const u = props.unit;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onDelete();
      props.onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={props.open}
      onClose={() => !busy && props.onClose()}
      title={`Delete ${u.kind} ${u.unitId}?`}
      description={`Deleted for good, without the trash. ${formatSize(u.sizeBytes)}, ${u.files} ${u.files === 1 ? "file" : "files"}`}
      closeButton={false}
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill disabled={busy} onPress={props.onClose} />
          <Btn variant="destructive" label="Delete for good" fill busy={busy} onPress={() => void run()} />
        </>
      }
    >
      {error ? <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text> : null}
    </Sheet>
  );
}

// ---- A confirmed bulk write (the web's BulkRunDialog) ----

export interface BulkJob<T, R> {
  title: string;
  /** Facts the reader needs before confirming (permanence, the trash rule). */
  description?: string;
  confirmLabel: string;
  items: readonly T[];
  label: (item: T) => string;
  sublabel?: (item: T) => string;
  run: (item: T) => Promise<R>;
  detail: (value: R) => string;
  onFinished?: (results: ReadonlyArray<BulkResult<T, R>>) => void;
}

/** Lists every item it will take, then calls the server one item at a time and lists each outcome. Mount with a fresh `key` per job. */
export function BulkRunSheet<T, R>(props: { open: boolean; job: BulkJob<T, R>; onClose: () => void }) {
  const { job } = props;
  const p = usePalette();
  const c = useChrome();
  const [results, setResults] = useState<ReadonlyArray<BulkResult<T, R>> | null>(null);
  const [running, setRunning] = useState(false);
  const total = job.items.length;
  const start = async () => {
    setRunning(true);
    setResults([]);
    const all = await runSequential(job.items, job.run, failureText, (sofar) => setResults([...sofar]));
    setRunning(false);
    job.onFinished?.(all);
  };
  const failed = results?.filter((r) => !r.ok).length ?? 0;
  const done = results?.length ?? 0;
  const finished = results !== null && !running;
  return (
    <Sheet
      open={props.open}
      onClose={() => !running && props.onClose()}
      title={job.title}
      description={results === null ? job.description : bulkProgress(done, total, failed, running)}
      closeButton={false}
      footer={
        finished ? (
          <Btn label="Close" fill onPress={props.onClose} />
        ) : (
          <>
            <Btn variant="outline" label="Cancel" fill disabled={running} onPress={props.onClose} />
            <Btn variant="destructive" label={running ? `${job.confirmLabel}...` : `${job.confirmLabel} ${total}`} fill busy={running} disabled={total === 0} onPress={() => void start()} />
          </>
        )
      }
    >
      {results === null
        ? job.items.map((item, i) => (
            <View key={i} style={[styles.item, { borderBottomColor: c.groupDivider }]}>
              <Text style={[ui.sm, { color: p.text }]} numberOfLines={1}>{job.label(item)}</Text>
              {job.sublabel ? <Text style={[ui.xs, { color: p.muted }]} numberOfLines={1}>{job.sublabel(item)}</Text> : null}
            </View>
          ))
        : results.map((r, i) => (
            <View key={i} style={[styles.result, { borderBottomColor: c.groupDivider }]}>
              {r.ok ? (
                <CheckIcon size={14} color={c.successForeground} style={{ marginTop: 3 }} accessibilityLabel="Succeeded" />
              ) : (
                <XIcon size={14} color={c.errorForeground} style={{ marginTop: 3 }} accessibilityLabel="Failed" />
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[ui.sm, { color: p.text }]} numberOfLines={1}>{job.label(r.item)}</Text>
                <Text style={[ui.xs, { color: r.ok ? p.muted : c.errorForeground }]}>{r.ok ? job.detail(r.value) : r.error}</Text>
              </View>
            </View>
          ))}
      {running && done < total ? (
        <View style={styles.result}>
          <ActivityIndicator size="small" color={p.muted} />
          <Text style={[ui.sm, { color: p.muted, flex: 1 }]} numberOfLines={1}>{job.label(job.items[done]!)}</Text>
        </View>
      ) : null}
    </Sheet>
  );
}

// ---- Trash ----

/** The trash: its entries newest first, each with restore and a two-step purge, and the purge of all of it. */
export function TrashSheet(props: {
  open: boolean;
  pairing: Pairing;
  list: TrashList | null;
  onChanged: () => void;
  onPurgeAll: () => void;
  onClose: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = trashEntries(props.list);
  // The entry's confirm step goes when the sheet closes.
  const was = useRef(props.open);
  useEffect(() => {
    if (was.current && !props.open) setConfirmPurge(null);
    was.current = props.open;
  }, [props.open]);
  const act = async (item: TrashItem, kind: "restore" | "purge") => {
    setBusyKey(item.key);
    setError(null);
    try {
      if (kind === "restore") await restoreTrash(props.pairing, item.key);
      else await purgeTrash(props.pairing, item.key);
      setConfirmPurge(null);
      props.onChanged();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusyKey(null);
    }
  };
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Trash"
      description={items.length || props.list?.unreadable.length ? trashSummary(props.list) : null}
      footer={
        items.length ? (
          <>
            <Btn variant="outline" label="Close" fill onPress={props.onClose} />
            <Btn variant="destructive-outline" label="Delete everything for good" fill icon={<Trash2Icon size={14} color={c.errorForeground} />} onPress={props.onPurgeAll} />
          </>
        ) : undefined
      }
    >
      {error ? <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text> : null}
      {props.list && items.length === 0 ? <Text style={[ui.sm, { color: p.muted }]}>Empty</Text> : null}
      {items.map((item) => (
        <View key={item.key} style={[styles.trash, { borderBottomColor: c.groupDivider }]}>
          <View style={styles.trashHead}>
            <ProviderIcon provider={item.provider} size={14} />
            <Text style={[ui.sm, { color: p.text, fontWeight: "500", flex: 1 }]} numberOfLines={1}>{item.name || item.id}</Text>
          </View>
          <Text style={[ui.xs, { color: p.muted }]}>{trashMeta(item)}</Text>
          {item.problem ? <Text style={[ui.xs, { color: c.warningForeground }]}>{item.problem}</Text> : null}
          <View style={styles.trashActions}>
            <Btn size="xs" variant="outline" label="Restore" icon={<RotateCcwIcon size={14} color={p.text} />} disabled={busyKey !== null || item.problem !== null} onPress={() => void act(item, "restore")} />
            {confirmPurge === item.key ? (
              <Btn size="xs" variant="destructive" label="Really delete for good" busy={busyKey === item.key} disabled={busyKey !== null} onPress={() => void act(item, "purge")} />
            ) : (
              <Btn size="xs" variant="ghost-muted" label="Delete for good" icon={<Trash2Icon size={14} color={p.muted} />} disabled={busyKey !== null} onPress={() => setConfirmPurge(item.key)} />
            )}
          </View>
        </View>
      ))}
    </Sheet>
  );
}

// ---- Filter ----

const PROVIDERS = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;
const LISTS = [
  { value: "all", label: "All" },
  { value: "in", label: "In list" },
  { value: "out", label: "Not in list" },
] as const;
const ALL_ACCOUNTS = "";

/** The web's filter form (size, period, provider, account, list) with the sort the web has on its column heads; reset and done. */
export function FilterSheet(props: {
  open: boolean;
  fields: FilterFields;
  facets: number;
  accounts: readonly string[];
  /** A sort choice (`manage.logic.ts sortValue`). */
  sort: string;
  onSort: (value: string) => void;
  onChange: (next: FilterFields) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const f = props.fields;
  const set = (patch: Partial<FilterFields>) => props.onChange({ ...f, ...patch });
  const badDay = (v: string) => v !== "" && dayStart(v) === null;
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Filter and sort"
      footer={
        <>
          <Btn variant="outline" label="Reset filters" fill disabled={props.facets === 0} onPress={props.onReset} />
          <Btn label="Done" fill onPress={props.onClose} />
        </>
      }
    >
      <SelectField label="Sort" value={props.sort} options={SORT_OPTIONS} onChange={props.onSort} />
      <Field label="Size in KB">
        <View style={styles.pair}>
          <View style={styles.cell}>
            <TextField value={f.minKb} onChangeText={(minKb) => set({ minKb: minKb.replace(/[^0-9]/g, "") })} placeholder="Min" keyboardType="number-pad" accessibilityLabel="Minimum size in KB" />
          </View>
          <Text style={[ui.base, { color: p.muted }]}>-</Text>
          <View style={styles.cell}>
            <TextField value={f.maxKb} onChangeText={(maxKb) => set({ maxKb: maxKb.replace(/[^0-9]/g, "") })} placeholder="Max" keyboardType="number-pad" accessibilityLabel="Maximum size in KB" />
          </View>
        </View>
      </Field>
      <Field label="Updated between">
        <View style={styles.pair}>
          <View style={styles.cell}>
            <TextField value={f.from} onChangeText={(from) => set({ from })} placeholder="YYYY-MM-DD" autoCorrect={false} autoCapitalize="none" accessibilityLabel="Start day" />
          </View>
          <Text style={[ui.base, { color: p.muted }]}>-</Text>
          <View style={styles.cell}>
            <TextField value={f.to} onChangeText={(to) => set({ to })} placeholder="YYYY-MM-DD" autoCorrect={false} autoCapitalize="none" accessibilityLabel="End day" />
          </View>
        </View>
        {badDay(f.from) || badDay(f.to) ? <Text style={[ui.xs, { color: c.warningForeground }]}>A day is written YYYY-MM-DD; a bound that is not one is left open</Text> : null}
      </Field>
      <Field label="Agent">
        <Segmented label="Agent" items={PROVIDERS} value={f.provider} onPick={(v) => set({ provider: v as FilterFields["provider"], account: "" })} />
      </Field>
      <SelectField
        label="Account"
        value={f.account}
        options={[{ value: ALL_ACCOUNTS, label: "All accounts" }, ...props.accounts.map((a) => ({ value: a, label: a }))]}
        onChange={(account) => set({ account })}
      />
      <Field label="List">
        <Segmented label="List" items={LISTS} value={f.list} onPick={(v) => set({ list: v as FilterFields["list"] })} />
      </Field>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // A menu item: a 44 row, the icon, the label, the detail.
  entry: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, borderRadius: 6, overflow: "hidden" },
  item: { paddingVertical: 8, borderBottomWidth: 1 },
  result: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "transparent" },
  trash: { paddingVertical: 10, gap: 2, borderBottomWidth: 1 },
  trashHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  trashActions: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 6, flexWrap: "wrap" },
  pair: { flexDirection: "row", alignItems: "center", gap: 6 },
  cell: { flex: 1, minWidth: 0 },
});
