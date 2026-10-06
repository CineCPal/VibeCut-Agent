import { useState } from "react";
import { FileStack, Send, X } from "lucide-react";
import { discardDraft, sendDraft } from "../../lib/agent/draft";
import { useAgentStore } from "../../store/useAgentStore";
import { useConnectionStore } from "../../store/useConnectionStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { clock } from "../../lib/agent/args";

/**
 * The open draft (PLAN.md, "Phase 6b"): cuts by what is said wait here until they're sent as a new
 * timeline, so the user can see one is open and send or drop it themselves, as on VibeCut's Connect page.
 */
export function DraftBar({ disabled }: { disabled: boolean }) {
  const host = useNleStateStore((s) => selectActiveHost(s));
  const draft = useConnectionStore((s) => (host ? s.connections[host].draft : null));
  const [busy, setBusy] = useState(false);
  if (!host || !draft) return null;
  const noun = host === "premiere" ? "sequence" : "timeline";

  const run = async (work: () => Promise<{ summary: string }>) => {
    setBusy(true);
    try {
      useAgentStore.getState().addMessage({ role: "tool", text: (await work()).summary });
    } catch (error) {
      useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="region" aria-label="Draft" className="mx-3 mb-1 flex items-center gap-2 rounded-md border border-athletic-blue-light/40 bg-athletic-blue/30 px-2.5 py-1.5 text-[11px] text-white">
      <FileStack size={13} aria-hidden="true" className="shrink-0 text-athletic-blue-light" />
      <span className="min-w-0 flex-1 truncate" title={draft.changes.join("\n")}>
        Draft of “{draft.base}”: {draft.changes.length} change(s), {clock(draft.duration)}
      </span>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => void run(() => sendDraft({ host, timeline: draft.base, step: "draft-bar", stepText: "" }))}
        title={`Make a new ${noun} from the draft; "${draft.base}" stays as it is`}
        className="flex items-center gap-1 rounded bg-athletic-blue px-1.5 py-0.5 hover:brightness-125 disabled:opacity-40"
      >
        <Send size={11} aria-hidden="true" />
        Send
      </button>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => void run(async () => discardDraft(host))}
        aria-label="Discard the draft"
        title="Discard the draft"
        className="rounded p-0.5 text-cool-grey hover:text-loss disabled:opacity-40"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
