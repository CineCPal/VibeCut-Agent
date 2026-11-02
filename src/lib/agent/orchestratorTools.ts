/**
 * The app's side of the orchestrated chat (ORCHESTRATOR_SPEC.md §1.1; PLAN.md, "Phase 21"). With
 * EXECUTION_MODE=orchestrated, Claude's tools run in the chat sidecar (orchestrator/tool_bus.py); the one
 * that reaches the app is `commit_otio_delta`, once the sidecar has checked the delta, its token and the
 * timeline. It carries the validated bridge calls, which run in the editor as one transaction
 * (`execute_otio_batch`, nle/bridge_runner.py): after this request's backup, undone together if one fails.
 * Like any direct edit it is refused while a draft is open, waits for Apply when edits are reviewed
 * (toolKinds.ts), and is logged as one edit, so Revert takes the whole delta back.
 */
import { nleCall } from "../ipc";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { EditResult } from "../../types/edits";
import { NLE_LABELS, type NleHost } from "../../types/nle";
import type { ExecutedCall, NleBatchCommand, OtioCommitArgs } from "../../types/orchestrator";
import type { Args, Executor } from "./args";
import { count, ensureBackup, HOST_SHORT, readTimeline, refuseLocked, TIMELINE_NOUN, type EditContext } from "./edits";

/** What `execute_otio_batch` answers. */
interface BatchResult extends EditResult {
  backup: string;
  executed: ExecutedCall[];
}

const HOSTS: NleHost[] = ["premiere", "resolve"];

/** The commit's arguments, checked; throws on anything the sidecar wouldn't have sent. */
export function commitArgs(args: Args): OtioCommitArgs {
  const text = (key: keyof OtioCommitArgs): string => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be non-empty text`);
    return value;
  };
  const host = text("host");
  if (!HOSTS.includes(host as NleHost)) throw new Error(`host must be one of ${HOSTS.join(", ")}`);
  const batch = args.batch;
  if (!Array.isArray(batch) || batch.length === 0) throw new Error("batch must be the validated calls");
  for (const [i, call] of batch.entries()) {
    const c = call as Partial<NleBatchCommand> | null;
    if (typeof c !== "object" || c === null || typeof c.command !== "string" || typeof c.args !== "object" || c.args === null) {
      throw new Error(`batch[${i}] must be a call with a command and args`);
    }
  }
  return {
    validationToken: text("validationToken"),
    deltaId: text("deltaId"),
    commitSummary: text("commitSummary"),
    host: host as NleHost,
    timeline: text("timeline"),
    batch: batch as NleBatchCommand[],
    ...(typeof args.expectedTimelineHash === "string" && args.expectedTimelineHash ? { expectedTimelineHash: args.expectedTimelineHash } : {}),
    ...(typeof args.otioPath === "string" && args.otioPath ? { otioPath: args.otioPath } : {}),
  };
}

export function orchestratorExecutors(ctx: EditContext): Record<string, Executor> {
  const noun = TIMELINE_NOUN[ctx.host];
  return {
    commit_otio_delta: async (args) => {
      const commit = commitArgs(args);
      if (commit.host !== ctx.host) {
        throw new Error(`The edit was planned for ${NLE_LABELS[commit.host]}, but ${NLE_LABELS[ctx.host]} is the connected editor; plan it again`);
      }
      if (commit.timeline !== ctx.timeline) {
        throw new Error(`The edit was planned on the ${noun} "${commit.timeline}", but "${ctx.timeline}" is open; plan it again`);
      }
      const view = await readTimeline(ctx);
      for (const call of commit.batch) refuseLocked(ctx, view, call.args);
      const backup = await ensureBackup(ctx);
      // The editor checks the timeline is still as it was validated (it may have changed while this waited for Apply).
      const result = await nleCall<BatchResult>(ctx.host, "execute_otio_batch", {
        timeline: ctx.timeline,
        backup,
        batch: commit.batch,
        ...(commit.expectedTimelineHash ? { expectedTimelineHash: commit.expectedTimelineHash } : {}),
      });
      if (result.renamed && Object.keys(result.renamed).length) useEditLogStore.getState().addRestoredIds(ctx.host, result.renamed);
      const summary = result.changes.length
        ? `${commit.commitSummary} (${count(result.changes.length, "change")} in ${HOST_SHORT[ctx.host]}, ${count(result.executed.length, "call")})`
        : `${commit.commitSummary}: nothing needed changing`;
      let editId: string | undefined;
      if (result.changes.length) {
        editId = useEditLogStore.getState().log({
          step: ctx.step,
          stepText: ctx.stepText,
          host: ctx.host,
          timeline: ctx.timeline,
          tool: "commit_otio_delta",
          summary,
          backup,
          changes: result.changes,
        }).id;
      }
      return {
        summary: `${summary} (backup: "${backup}")`,
        result: {
          committed: true,
          ...(editId ? { editId } : {}),
          deltaId: commit.deltaId,
          backup,
          changes: result.changes,
          executed: result.executed,
          ...(commit.otioPath ? { otioPath: commit.otioPath } : {}),
        },
      };
    },
  };
}
