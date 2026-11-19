// A new session from the phone (DESIGN.md 6f, 2d): the web's NewSessionDialog at phone width
// (components/ui/Sheet.tsx): the agent as a segmented group, the working folder, an optional name,
// the account, model and Group as three selects in a row, the first message, and the footer's
// start and cancel buttons. The rules are the web dialog's (packages/shared/src/newSession.ts). The
// folder is typed as a path with the subfolders listed under it (FolderPathInput.tsx, DESIGN.md 6z),
// the recent folders (web model.ts recentCwds) listed while the field is empty; the web's Finder
// button opens a dialog on the Mac, which the phone cannot answer, so it has no counterpart here.
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import * as SecureStore from "expo-secure-store";
import type { AccountInfo, NewSessionMemory, Project, ProviderId, SessionSummary } from "@maru/shared";
import {
  canStartNewSession,
  chooseNewSessionAccount,
  NEW_SESSION_MODELS,
  parseNewSessionMemory,
  providerAccounts,
  rememberNewSession,
} from "@maru/shared";
import { recentCwds } from "../../../web/src/model.ts";
import type { Connection } from "../lib/connection.ts";
import { fetchAccounts, type Pairing } from "../lib/pairing.ts";
import { createSession } from "../lib/useMaru.ts";
import { FolderPathInput } from "./FolderPathInput.tsx";
import { ProviderIcon } from "./sidebar/ProviderIcon.tsx";
import { Btn } from "./ui/Btn.tsx";
import { Field, SelectField, Segmented, TextField } from "./ui/Fields.tsx";
import { ui } from "./ui/metrics.ts";
import { Sheet } from "./ui/Sheet.tsx";
import { useChrome } from "./ui/useChrome.ts";

const MEMORY_KEY = "maru.newSession.v1";

async function readMemory(): Promise<NewSessionMemory> {
  try {
    return parseNewSessionMemory(JSON.parse((await SecureStore.getItemAsync(MEMORY_KEY)) ?? "null"));
  } catch {
    return {};
  }
}

export function NewSessionSheet(props: {
  open: boolean;
  pairing: Pairing;
  conn: Connection;
  online: boolean;
  sessions: ReadonlyMap<string, SessionSummary>;
  projects: readonly Project[];
  /** The Group it starts in; null for Unsorted. */
  projectId: string | null;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const c = useChrome();
  const [memory, setMemory] = useState<NewSessionMemory>({});
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState<string | null>(props.projectId);
  // The folder field's text, and the folder it names once the server read it as one.
  const [folderText, setFolderText] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the remembered agent and account, the given Group, and no folder.
  // The Group is read when the sheet opens, so a list update while it is open keeps the picks.
  const startGroup = useRef(props.projectId);
  startGroup.current = props.projectId;
  // Whether the sheet is still open when a start answers: a closed sheet does not navigate.
  const shown = useRef(props.open);
  shown.current = props.open;
  useEffect(() => {
    if (!props.open) return;
    let live = true;
    setError(null);
    setProjectId(startGroup.current);
    setFolderText("");
    setCwd(null);
    setName("");
    setModel("");
    setAccount("");
    void readMemory().then((m) => {
      if (!live) return;
      setMemory(m);
      setProvider(m.provider ?? "claude");
    });
    fetchAccounts(props.pairing).then(
      (a) => live && setAccounts(a),
      (e: unknown) => live && setError(`Could not load accounts: ${e instanceof Error ? e.message : String(e)}`),
    );
    return () => {
      live = false;
    };
  }, [props.open, props.pairing]);

  const recent = useMemo(() => recentCwds(props.sessions.values()), [props.sessions]);
  const chosenAccount = chooseNewSessionAccount(accounts, provider, account, memory);
  const canStart = props.online && canStartNewSession({ cwd, account: chosenAccount, prompt, busy });

  const start = async () => {
    if (!canStart || cwd === null) return;
    setBusy(true);
    setError(null);
    try {
      const key = await createSession(props.conn, {
        provider, account: chosenAccount, cwd, prompt: prompt.trim(), projectId, ...(model ? { model } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await SecureStore.setItemAsync(MEMORY_KEY, JSON.stringify(rememberNewSession(memory, provider, chosenAccount, cwd))).catch(() => undefined);
      setPrompt("");
      setName("");
      if (shown.current) props.onCreated(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Closing is always allowed, also while a start waits: the session then joins the list on
    // its own, and the sheet does not jump to it.
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="New session"
      closeButton={false}
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill onPress={props.onClose} />
          <Btn label={busy ? "Starting" : props.online ? "Start" : "Connecting"} fill disabled={!canStart} onPress={() => void start()} />
        </>
      }
    >
      <Segmented
        label="Agent"
        items={[
          { value: "claude", label: "Claude", icon: <ProviderIcon provider="claude" size={14} /> },
          { value: "codex", label: "Codex", icon: <ProviderIcon provider="codex" size={14} /> },
        ]}
        value={provider}
        onPick={(v) => {
          // As the web: the model resets, the picked account stays for when the agent comes back.
          setProvider(v as ProviderId);
          setModel("");
        }}
      />
      <Field label="Working folder">
        <FolderPathInput
          pairing={props.pairing}
          value={folderText}
          onValueChange={setFolderText}
          recent={recent}
          onResolved={setCwd}
          editable={!busy}
        />
      </Field>
      <Field label="Name (optional)">
        <TextField
          value={name}
          onChangeText={setName}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!busy}
          placeholder="Leave empty to name it from the first message"
        />
      </Field>
      <View style={styles.selects}>
        <View style={styles.cell}>
          <SelectField
            label="Account"
            value={chosenAccount}
            options={providerAccounts(accounts, provider).map((a) => ({ value: a.id, label: a.id }))}
            empty={accounts.length ? "No accounts for this agent" : "Loading accounts"}
            onChange={setAccount}
          />
        </View>
        <View style={styles.cell}>
          <SelectField label="Model" value={model} options={NEW_SESSION_MODELS[provider].map((m) => ({ value: m.value, label: m.label }))} onChange={setModel} />
        </View>
        <View style={styles.cell}>
          <SelectField
            label="Group"
            value={projectId ?? ""}
            options={[...props.projects.map((g) => ({ value: g.id, label: g.name })), { value: "", label: "Unsorted" }]}
            onChange={(v) => setProjectId(v || null)}
          />
        </View>
      </View>
      <Field label="First message">
        <TextField value={prompt} onChangeText={setPrompt} rows={4} />
      </Field>
      {error ? (
        <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground }]}>{error}</Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // grid grid-cols-3 gap-2.
  selects: { flexDirection: "row", gap: 8 },
  cell: { flex: 1, minWidth: 0 },
});
