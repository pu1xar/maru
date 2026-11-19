// The web's Accounts page (settings/AccountsPanel.tsx) as a read only list: each account's provider
// mark, id, status badge and folder. Adding, removing and signing in belong to a computer (the web
// page opens the CLI's own sign-in in a terminal; a phone token has no route for these edits).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { RotateCwIcon } from "lucide-react-native";
import type { AccountsStatus } from "@maru/shared";
import { call, auth, type Pairing } from "../../lib/api.ts";
import { ACCOUNTS_ON_COMPUTER, accountViews, restartNote } from "../../lib/accountsView.logic.ts";
import { usePalette } from "../../theme.ts";
import { ProviderIcon } from "../sidebar/ProviderIcon.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Btn } from "../ui/Btn.tsx";
import { SettingsRow, SettingsSection } from "../ui/SettingsParts.tsx";
import { Text } from "../ui/Text.tsx";
import { ui } from "../ui/metrics.ts";

type Loaded = { state: "loading" } | { state: "ok"; value: AccountsStatus } | { state: "error"; error: string };

export function AccountsTab({ pairing }: { pairing: Pairing }) {
  const p = usePalette();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const reload = useCallback(() => {
    setLoaded((l) => (l.state === "ok" ? l : { state: "loading" }));
    call<AccountsStatus>(`${pairing.server}/api/accounts/status`, { headers: auth(pairing.token) }).then(
      (value) => setLoaded({ state: "ok", value }),
      (e: unknown) => setLoaded({ state: "error", error: e instanceof Error ? e.message : String(e) }),
    );
  }, [pairing]);
  useEffect(() => reload(), [reload]);

  const status = loaded.state === "ok" ? loaded.value : null;
  const restart = status ? restartNote(status) : null;
  return (
    <View style={{ gap: 32 }}>
      <SettingsSection
        title="Accounts"
        headerAction={<Btn size="xs" variant="outline" label="Refresh" disabled={loaded.state === "loading"} icon={<RotateCwIcon size={14} color={p.muted} />} onPress={reload} />}
      >
        {loaded.state === "loading" ? <SettingsRow title="Loading" /> : null}
        {loaded.state === "error" ? <SettingsRow title="Could not load" description={loaded.error} control={<Btn size="xs" variant="outline" label="Reload" onPress={reload} />} /> : null}
        {status && status.accounts.length === 0 ? <SettingsRow title="No accounts" /> : null}
        {status
          ? accountViews(status).map((a) => (
              <SettingsRow
                key={a.key}
                title={
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, flexShrink: 1 }}>
                    <ProviderIcon provider={a.provider} size={16} />
                    <Text style={[ui.sm, { color: p.text, fontWeight: "500", flexShrink: 1 }]}>{a.id}</Text>
                    <Badge variant={a.statusVariant} label={a.statusLabel} />
                    {a.detected ? <Badge variant="info" label="Detected" /> : null}
                  </View>
                }
                description={a.dir}
                status={a.note}
              />
            ))
          : null}
        {restart ? <SettingsRow title={restart} /> : null}
        <SettingsRow title={ACCOUNTS_ON_COMPUTER} />
      </SettingsSection>
    </View>
  );
}
