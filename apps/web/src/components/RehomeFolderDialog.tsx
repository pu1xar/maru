// The "Change working folder" dialog of the places that have no folder chip to open it from (the
// sidebar's session menu, the settings session table): the folder is typed as a path with the
// subfolders listed under it (FolderBrowseDialog.tsx, FolderPathField.tsx, DESIGN.md 6l and 6z), and
// taking one moves the session's transcript there (`POST /api/session-rehome`). The dialog is
// mounted while it is open or closing; `onClosed` says it can be dropped.
import type { RehomeSessionResult, SessionSummary } from "@maru/shared";
import { useMemo, useState } from "react";

import { plural } from "~/lib/plural";
import { recentCwds, shortPath } from "~/model";
import { describeError, rehomeSession } from "~/projectsApi";
import { FolderBrowseDialog } from "./FolderBrowseDialog";
import { toastManager } from "./ui/toast";

export function RehomeFolderDialog(props: {
  session: SessionSummary;
  /** The listed sessions, whose folders are offered while the field is empty. */
  sessions: readonly SessionSummary[];
  onClosed: () => void;
  /** The server moved the session (after the success toast). */
  onDone?: (result: RehomeSessionResult) => void;
}) {
  const { session } = props;
  const [open, setOpen] = useState(true);
  const recent = useMemo(() => recentCwds(props.sessions).filter((cwd) => cwd !== session.cwd), [props.sessions, session.cwd]);
  return (
    <FolderBrowseDialog
      open={open}
      current={session.cwd}
      recent={recent}
      closeFirst={false}
      onClose={() => setOpen(false)}
      onClosed={props.onClosed}
      onChoose={(cwd) => {
        setOpen(false);
        if (cwd === session.cwd) return;
        rehomeSession({ provider: "claude", account: session.account, id: session.id, cwd }).then(
          (r) => {
            toastManager.add({
              type: "success",
              title: "Working folder changed",
              description: `${shortPath(r.cwd)}, ${plural(r.cwdRewritten, "cwd line")} rewritten${r.subtreesLeft.length ? `, ${plural(r.subtreesLeft.length, "subfolder")} left` : ""}`,
            });
            props.onDone?.(r);
          },
          (err: unknown) => toastManager.add({ type: "error", title: "Could not change the working folder", description: describeError(err) }),
        );
      }}
    />
  );
}
