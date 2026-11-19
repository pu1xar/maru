// The drawer's foot (SessionSidebar.tsx SidebarFooter, T3 SidebarChromeFooter order): the update
// pill, the account usage lines, then the settings row, under a parting line. The web's pill says the
// server runs another version and reloads the page; the phone's says an update came down and a press
// restarts into it.
import { StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { SettingsIcon } from "lucide-react-native";
import * as Updates from "expo-updates";
import { INSTALL_HEADLINE, installDetail } from "../../lib/apkUpdate.logic.ts";
import type { Pairing } from "../../lib/pairing.ts";
import { describeApkDownload, useApkDownload, useInstallStatus } from "../../lib/useInstall.ts";
import { releaseHeadline } from "../../lib/releaseCheck.logic.ts";
import { useRelease } from "../../lib/useRelease.ts";
import type { BarTone, UsageRow } from "../../lib/sidebarModel.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { Btn } from "../ui/Btn.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { useSidebarColors } from "./useSidebarColors.ts";

export function SidebarFooter(props: { usage: UsageRow[]; bottomInset: number; pairing: Pairing; onSettings: () => void }) {
  const p = usePalette();
  return (
    <View style={[styles.foot, { borderTopColor: p.border, paddingBottom: 8 + props.bottomInset }]}>
      <ReleasePill />
      <InstallPill pairing={props.pairing} />
      <UpdatePill />
      <UsageLines rows={props.usage} />
      <Press onPress={props.onSettings} accessibilityRole="button" accessibilityLabel="Settings" hitSlop={{ top: 6, bottom: 6 }} style={styles.settings}>
        <SettingsIcon size={16} color={p.muted} />
        <Text style={[type.sidebar, { color: p.muted, fontWeight: "500" }]}>Settings</Text>
      </Press>
    </View>
  );
}

/**
 * The notice of a build that takes its APK from GitHub Releases (lib/useRelease.ts): the latest release
 * is newer than the installed APK, and Download opens its APK in the browser. Nothing for a build
 * without MARU_RELEASES_REPO, and while no newer release is known.
 */
function ReleasePill() {
  const sc = useSidebarColors();
  const { release, download } = useRelease();
  if (!release) return null;
  return (
    <View style={[styles.pill, { backgroundColor: sc.pill.bg }]}>
      <View style={[styles.pillDot, { backgroundColor: sc.info }]} />
      <Text style={[type.tiny, { color: sc.pill.fg, fontWeight: "500", flex: 1 }]} numberOfLines={1}>
        {releaseHeadline(release)}
      </Text>
      <Btn size="xs" variant="outline" label="Download" onPress={download} />
    </View>
  );
}

/**
 * The notice for an app whose runtime version the server's update has left behind: the OTA update
 * cannot reach it, so the pill says a new APK is needed and one tap downloads it. Nothing while the
 * runtimes match or the server's answer is not in yet.
 */
function InstallPill({ pairing }: { pairing: Pairing }) {
  const sc = useSidebarColors();
  const { status } = useInstallStatus(pairing);
  const download = useApkDownload(pairing);
  if (status.kind !== "install") return null;
  const note = describeApkDownload(download.state) ?? installDetail(status);
  return (
    <Press
      onPress={download.start}
      accessibilityRole="button"
      accessibilityLabel={`${INSTALL_HEADLINE}, tap to download`}
      style={[styles.pill, styles.pillTall, { backgroundColor: sc.pill.bg }]}
    >
      <View style={[styles.pillDot, { backgroundColor: sc.info, marginTop: 4 }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.tiny, { color: sc.pill.fg, fontWeight: "500" }]}>{INSTALL_HEADLINE}, tap to download</Text>
        {note ? <Text style={[type.tiny, { color: sc.pill.fg, opacity: 0.8 }]}>{note}</Text> : null}
      </View>
    </Press>
  );
}

/** VersionNotice's pill: a dot and one line in the info color. Nothing while no update is waiting. */
function UpdatePill() {
  const sc = useSidebarColors();
  const { isUpdatePending } = Updates.useUpdates();
  if (!isUpdatePending) return null;
  return (
    <Press
      onPress={() => void Updates.reloadAsync()}
      accessibilityRole="button"
      accessibilityLabel="New version downloaded, tap to restart"
      style={[styles.pill, { backgroundColor: sc.pill.bg }]}
    >
      <View style={[styles.pillDot, { backgroundColor: sc.info }]} />
      <Text style={[type.tiny, { color: sc.pill.fg, fontWeight: "500", flex: 1 }]} numberOfLines={1}>
        New version downloaded, tap to restart
      </Text>
    </Press>
  );
}

/** UsageFooter: one line per account, a bar per window and no numbers; the summary is the line's label. */
function UsageLines(props: { rows: UsageRow[] }) {
  const p = usePalette();
  if (props.rows.length === 0) return null;
  return (
    <View accessibilityLabel="Account usage" style={{ gap: 2 }}>
      {props.rows.map((r) => (
        <View key={r.key} accessible accessibilityRole="image" accessibilityLabel={r.summary} style={styles.usageRow}>
          <ProviderIcon provider={r.provider} size={12} />
          <Text style={[type.tiny, styles.account, { color: r.active ? p.text : p.muted }]} numberOfLines={1}>
            {r.label}
          </Text>
          <View style={styles.bars}>
            {r.bars.map((b, i) => (
              <Bar key={i} bar={b} stale={r.stale} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function Bar(props: { bar: UsageRow["bars"][number]; stale: boolean }) {
  const p = usePalette();
  const sc = useSidebarColors();
  const { bar } = props;
  const fill: Record<BarTone, string> = { muted: p.muted, info: sc.info, warning: sc.warning, error: sc.error };
  if (bar.pct === null) return <View style={[styles.track, { backgroundColor: bar.attention ? sc.warningTrack : sc.track }]} />;
  return (
    <View style={[styles.track, { backgroundColor: sc.track, opacity: props.stale ? 0.5 : 1 }]}>
      <View style={{ width: `${bar.pct}%`, height: "100%", borderRadius: 2, backgroundColor: fill[bar.tone] }} />
    </View>
  );
}

const styles = StyleSheet.create({
  // px-2 and pt-2 above a parting line (the sidebar's footer), 8 between its blocks.
  foot: { gap: 8, paddingHorizontal: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 },
  pillTall: { alignItems: "flex-start" },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  usageRow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20, paddingHorizontal: 4 },
  account: { width: 56 },
  bars: { flex: 1, minWidth: 0, gap: 2 },
  track: { height: 3, borderRadius: 2, overflow: "hidden" },
  settings: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 10, borderRadius: 8 },
});
