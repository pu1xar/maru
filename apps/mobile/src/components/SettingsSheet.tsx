// The web's settings screen in a sheet, with its pages as a tab row: "Sessions" (the session table of
// settings/manage/ManagePanel.tsx, components/settings/ManageTab.tsx; usage lives in the drawer's footer, user request
// 2026-11-19), Accounts (AccountsPanel.tsx, read only), Appearance (DisplayPanel.tsx, components/settings/
// DisplayTab.tsx) and Devices. The Devices tab shows device and
// app facts, the update check and unpairing as the web's page does (DevicesPanel.tsx: the "This device"
// section of the desktop app, and the "Android app" section): sections of grouped rows with a title, a
// description and a control. Says when the server's update needs a newer APK (its runtime version,
// the native fingerprint, differs from this app's). Unpairing asks first, in the web's RemoveDialog
// words.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { DownloadIcon } from "lucide-react-native";
import * as Updates from "expo-updates";
import type { MobileAppInfo, SessionSummary } from "@maru/shared";
import { fetchAppInfo, type Pairing } from "../lib/pairing.ts";
import { INSTALL_HEADLINE, installDetail, installStatus } from "../lib/apkUpdate.logic.ts";
import { describeApk, describeAppUpdate, describeServerUpdate, updateBusy, type AppUpdateState } from "../lib/settingsText.ts";
import { describeApkDownload, useApkDownload } from "../lib/useInstall.ts";
import { releaseHeadline } from "../lib/releaseCheck.logic.ts";
import { RELEASES_REPO, useRelease } from "../lib/useRelease.ts";
import { usePalette } from "../theme.ts";
import { APP_VERSIONS } from "../version.ts";
import { PUSH_STATUS_TEXT, type PushStatus } from "../lib/pushData.ts";
import { Btn } from "./ui/Btn.tsx";
import { SettingsRow, SettingsSection } from "./ui/SettingsParts.tsx";
import { AccountsTab } from "./settings/AccountsTab.tsx";
import { DisplayTab } from "./settings/DisplayTab.tsx";
import { ManageTab } from "./settings/ManageTab.tsx";
import { useNow } from "./timeline/useNow.ts";
import { Segmented } from "./ui/Fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

type Tab = "sessions" | "accounts" | "display" | "devices";

/** The web's page order. */
const TABS: readonly { value: Tab; label: string }[] = [
  { value: "sessions", label: "Sessions" },
  { value: "accounts", label: "Accounts" },
  { value: "display", label: "Appearance" },
  { value: "devices", label: "Devices" },
];

export function SettingsSheet(props: {
  open: boolean;
  pairing: Pairing;
  push: PushStatus;
  /** The list's sessions as /ws keeps them. */
  sessions: ReadonlyMap<string, SessionSummary>;
  onClose: () => void;
  onUnpair: () => void;
  /** Opens a session of the table in the conversation (the sheet closes). */
  onOpenSession: (key: string) => void;
  /** A session moved to another account: its key changed. */
  onRekey: (from: string, to: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(TABS[0]!.value);
  const p = usePalette();
  const now = useNow(30_000);
  const [info, setInfo] = useState<MobileAppInfo | null>(null);
  const [update, setUpdate] = useState<AppUpdateState>(Updates.isEnabled ? { status: "idle" } : { status: "disabled" });
  const [unpairing, setUnpairing] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    fetchAppInfo(props.pairing).then(setInfo, () => setInfo(null));
  }, [props.open, props.pairing]);

  const runtime = Updates.runtimeVersion ?? "-";
  const install = installStatus(info, Updates.runtimeVersion ?? null);
  const download = useApkDownload(props.pairing);
  const github = useRelease();

  const check = async () => {
    if (!Updates.isEnabled) return setUpdate({ status: "disabled" });
    setUpdate({ status: "checking" });
    try {
      const r = await Updates.checkForUpdateAsync();
      if (!r.isAvailable) {
        // 204 "nothing new" is also what the server answers an app of another runtime version, so
        // "up to date" is only said after the runtimes were compared.
        const fresh = await fetchAppInfo(props.pairing);
        setInfo(fresh);
        const s = installStatus(fresh, Updates.runtimeVersion ?? null);
        return setUpdate({ status: s.kind === "install" || s.kind === "no-apk" ? "needs-install" : "up-to-date" });
      }
      setUpdate({ status: "downloading" });
      await Updates.fetchUpdateAsync();
      setUpdate({ status: "restarting" });
      await Updates.reloadAsync();
    } catch (e) {
      setUpdate({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const running = Updates.isEmbeddedLaunch ? "Bundled in APK" : `Update ${Updates.updateId?.slice(0, 8) ?? "-"}`;
  const push = props.push.state === "failed" ? `${PUSH_STATUS_TEXT.failed}: ${props.push.error}` : PUSH_STATUS_TEXT[props.push.state];

  return (
    <>
      <Sheet
        open={props.open}
        onClose={props.onClose}
        title="Settings"
        headerExtra={<Segmented label="Settings tabs" items={TABS} value={tab} onPick={(v) => setTab(v as Tab)} />}
      >
        {tab === "sessions" ? (
          <View style={{ gap: 32 }}>
            <ManageTab pairing={props.pairing} sessions={props.sessions} now={now} onOpenSession={props.onOpenSession} onRekey={props.onRekey} />
          </View>
        ) : null}
        {tab === "accounts" ? <AccountsTab pairing={props.pairing} /> : null}
        {tab === "display" ? <DisplayTab /> : null}
        {tab === "devices" ? (
        <View style={{ gap: 32 }}>
          <SettingsSection title="This device">
            <SettingsRow
              title={props.pairing.device.name}
              description={`Android, server ${props.pairing.server}`}
              control={<Btn size="xs" variant="destructive-outline" label="Disconnect" onPress={() => setUnpairing(true)} />}
            />
            <SettingsRow
              title="App"
              description={describeAppUpdate(update, APP_VERSIONS.running ?? "-")}
              status={`Running ${running}`}
              control={<Btn size="xs" variant="outline" label="Check for update" disabled={updateBusy(update)} onPress={() => void check()} />}
            />
            <SettingsRow title="Other devices" description="Manage devices in maru web in a browser" />
          </SettingsSection>
          <SettingsSection title="Android app">
            <SettingsRow
              title="APK"
              description={describeApk(APP_VERSIONS.apk, runtime)}
              status={
                RELEASES_REPO
                  ? github.release
                    ? releaseHeadline(github.release)
                    : undefined
                  : [install.kind === "install" || install.kind === "no-apk" ? INSTALL_HEADLINE : null, installDetail(install), describeApkDownload(download.state)].filter(Boolean).join(". ") || undefined
              }
              control={
                RELEASES_REPO ? (
                  github.release ? (
                    <Btn size="xs" variant="outline" label="Download" icon={<DownloadIcon size={14} color={p.muted} />} onPress={github.download} />
                  ) : null
                ) : info?.apk ? (
                  <Btn
                    size="xs"
                    variant="outline"
                    label="Download APK"
                    busy={download.state.phase === "opening"}
                    icon={<DownloadIcon size={14} color={p.muted} />}
                    onPress={download.start}
                  />
                ) : null
              }
            />
            <SettingsRow title="Update" description={describeServerUpdate(info?.update)} />
          </SettingsSection>
          <SettingsSection title="Push notifications">
            <SettingsRow title="This device" description={push} />
            <SettingsRow title="Server" description={info?.push === undefined ? "-" : info.push.server ? "Can send" : "Off, no service account"} />
          </SettingsSection>
        </View>
        ) : null}
      </Sheet>
      <Sheet
        open={unpairing}
        onClose={() => setUnpairing(false)}
        title="Disconnect this device?"
        description="The server deletes this device's token and the app returns to the pairing screen. To use it again, pair it anew from the web."
        closeButton={false}
        footer={
          <>
            <Btn variant="outline" label="Cancel" fill onPress={() => setUnpairing(false)} />
            <Btn
              variant="destructive"
              label="Disconnect"
              fill
              onPress={() => {
                setUnpairing(false);
                props.onUnpair();
              }}
            />
          </>
        }
      />
    </>
  );
}
