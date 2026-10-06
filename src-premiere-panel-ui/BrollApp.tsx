import { Broll } from "./Broll";
import type { Transport } from "./transport";
import { usePanel } from "./usePanel";

/** The docked "VibeCut Agent B-roll" panel (PLAN.md, "Phase 5b"), after VibeCut's BrollApp.tsx. */
export function BrollApp({ transport }: { transport: Transport }) {
  const view = usePanel(transport);
  const { file, agentRunning } = view;
  const live = !!file && agentRunning;
  const connected = !!file?.editor.connected;
  return (
    <div className="vc-panel">
      <div className="vc-header">
        <span className={live && connected ? "vc-dot vc-dot-on" : "vc-dot vc-dot-off"} />
        <span className="vc-grow vc-muted">
          {!agentRunning
            ? "VibeCut Agent isn't running. Open it (it lives in the menu bar); this panel connects to it by itself."
            : !file
              ? "Loading the B-roll…"
              : connected
                ? `B-roll for ${file.editor.timeline ?? "the sequence"}. Drag a shot into the Project panel or the timeline.`
                : "Browse and search B-roll here. VibeCut Agent isn't connected to Premiere yet, so Source, Import and Place wait for it."}
        </span>
      </div>
      {view.writeError && <p className="vc-error">Couldn't reach VibeCut Agent: {view.writeError}</p>}
      {file?.notice && (
        <p role={file.notice.failed ? "alert" : "status"} className={file.notice.failed ? "vc-notice vc-error" : "vc-notice vc-muted"}>
          {file.notice.text}
        </p>
      )}
      {live && <Broll file={file} view={view} transport={transport} />}
    </div>
  );
}
