// The drawer's search over every session's conversation (DESIGN.md 6u): under the sessions whose
// names match the drawer's search field, the places in conversations that hold the same text,
// newest first. A row opens its session and the find at that place. The server pages the hits
// (`GET /api/search`, lib/api.ts fetchSearch); "Show more" brings the next page.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { sessionDisplayName, type SearchHit, type SessionSummary } from "@maru/shared";
import { DEFAULT_TIMESTAMP_FORMAT, formatDayAwareTimestamp } from "../../../web/src/timestampFormat.ts";
import { fetchSearch, type Pairing } from "../lib/api.ts";
import {
  afterPage,
  hitKey,
  hitRoleLabel,
  remainingHits,
  searchQueryOf,
  SEARCH_DELAY_MS,
  SEARCH_PAGE,
  type SearchListState,
} from "../lib/conversationSearch.ts";
import { scaleAlpha } from "../lib/chromeColors.ts";
import { usePalette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { ui } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

let warmed = false;

/** Asks the server to catch its index up before the first search (the first pass reads every transcript). */
export function warmConversationSearch(pairing: Pairing): void {
  if (warmed) return;
  warmed = true;
  fetchSearch(pairing, "", 0, 1).catch(() => {
    warmed = false;
  });
}

export function ConversationSearch(props: {
  pairing: Pairing;
  query: string;
  onOpen: (hit: SearchHit, session: SessionSummary, query: string) => void;
}) {
  const { pairing, query, onOpen } = props;
  const p = usePalette();
  const c = useChrome();
  const [state, setState] = useState<SearchListState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = (q: string, offset: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    fetchSearch(pairing, q, offset, SEARCH_PAGE, ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        setState((prev) => afterPage(prev, res, offset));
        setLoading(false);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
  };

  const sent = searchQueryOf(query);
  useEffect(() => {
    if (sent === null) {
      abortRef.current?.abort();
      setState(null);
      setLoading(false);
      setError(null);
      return;
    }
    const timer = setTimeout(() => load(sent, 0), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (sent === null) return null;
  const current = state && state.query === sent ? state : null;
  const more = current ? remainingHits(current) : 0;
  return (
    <View accessibilityLabel="Found in conversations" style={styles.section}>
      <View style={styles.head}>
        <Text style={[ui.xs, { color: p.muted, fontWeight: "500" }]}>Found in conversations</Text>
        {current ? <Text style={[ui.xs, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{current.total}</Text> : null}
        {loading ? <ActivityIndicator size="small" color={p.muted} style={{ transform: [{ scale: 0.6 }], margin: -4 }} /> : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={[ui.xs, styles.note, { color: c.errorForeground }]}>{error}</Text>
      ) : null}
      {current && current.total === 0 && !loading ? (
        <Text accessibilityRole="summary" style={[ui.xs, styles.note, { color: p.muted }]}>No matches</Text>
      ) : null}
      {current?.hits.map((hit, i) => {
        const session = current.sessions.get(hit.key);
        if (!session) return null;
        return <HitRow key={hitKey(hit, i)} hit={hit} session={session} onPress={() => onOpen(hit, session, current.query)} />;
      })}
      {current && more > 0 ? (
        <Press
          disabled={loading}
          onPress={() => load(current.query, current.hits.length)}
          style={styles.more}
          accessibilityRole="button"
        >
          <Text style={[ui.xs, { color: p.muted }]}>{loading ? "Loading" : `Show more (${more})`}</Text>
        </Press>
      ) : null}
    </View>
  );
}

function HitRow({ hit, session, onPress }: { hit: SearchHit; session: SessionSummary; onPress: () => void }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <Press onPress={onPress} style={styles.row} accessibilityRole="button">
      <View style={styles.titleLine}>
        <Text style={[ui.xs, { color: p.text, fontWeight: "500", flex: 1 }]} numberOfLines={1}>{sessionDisplayName(session)}</Text>
        {hit.at ? (
          <Text style={[ui.xs, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{formatDayAwareTimestamp(hit.at, DEFAULT_TIMESTAMP_FORMAT)}</Text>
        ) : null}
      </View>
      <Text style={[ui.xs, { color: p.muted }]} numberOfLines={2}>
        <Text style={{ color: scaleAlpha(p.text, 0.7) }}>{hitRoleLabel(hit.role)} </Text>
        {hit.snippet.before}
        <Text style={{ backgroundColor: c.hitMark.bg, color: c.hitMark.fg }}>{hit.snippet.match}</Text>
        {hit.snippet.after}
        {hit.count > 1 ? ` (${hit.count})` : ""}
      </Text>
    </Press>
  );
}

// The web's section: gap-px, its head px-2 pt-3 pb-1, its rows rounded-md px-2 py-1.5 gap-0.5, in the
// sidebar's 8 of padding.
const styles = StyleSheet.create({
  section: { paddingHorizontal: 8, gap: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingTop: 12, paddingBottom: 4 },
  note: { paddingHorizontal: 8, paddingVertical: 8 },
  row: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, gap: 2, overflow: "hidden" },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  more: { marginHorizontal: 0, marginVertical: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, overflow: "hidden" },
});
