/**
 * Keeps React off Node's `queueMicrotask` in Premiere's CEP panels (PLAN.md, "CEP renderer crash (panel
 * 0.20.2)"). With `--enable-nodejs --mixed-context` the page's global `queueMicrotask` is Node's, and once
 * Node's environment is gone (a page reload) its binding (`node::task_queue::EnqueueMicrotask`) dereferences
 * null and the whole CEP renderer crashes, which Premiere reports as "Sorry, an error occurred". React 19
 * schedules with `queueMicrotask`, so this swaps in V8's own queue before React loads. Import it first.
 *
 * The Telemetry Studio panel's copy of src-premiere-panel-ui/nodeSafeMicrotasks.ts (the visualizer is another
 * workspace package, so it is copied, not imported); keep the two the same.
 */

/** Replaces Node's `queueMicrotask` with a page-side one when Node is in the page; true when it did. */
export function installNodeSafeMicrotasks(scope: typeof globalThis = globalThis): boolean {
  const node = (scope as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  if (!node) return false;
  scope.queueMicrotask = (callback: VoidFunction) => {
    // As queueMicrotask does, an error thrown in the callback is reported, not swallowed.
    Promise.resolve()
      .then(callback)
      .catch((error: unknown) =>
        setTimeout(() => {
          throw error;
        }),
      );
  };
  return true;
}

installNodeSafeMicrotasks();
