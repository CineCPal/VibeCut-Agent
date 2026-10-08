import { describe, expect, it } from "vitest";
import { CHANGING_TOOLS, NOT_REVIEWED, describeChange, needsReview } from "./toolKinds";
import { executorsFor, toolDeclarations } from "./tools";
import { rememberTimelineView } from "./context";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";

describe("which tools are reviewed (Phase 11d)", () => {
  it("knows every tool the agent has, in exactly one list", () => {
    const names = new Set<string>();
    for (const host of ["premiere", "resolve"] as const) {
      Object.keys(executorsFor({ host, timeline: "Main", step: "s", stepText: "t" })).forEach((n) => names.add(n));
      toolDeclarations(host).forEach((d) => names.add(d.name));
    }
    const unknown = [...names].filter((n) => !CHANGING_TOOLS.has(n) && !NOT_REVIEWED.has(n));
    expect(unknown, "classify each new tool in toolKinds.ts").toEqual([]);
    expect([...CHANGING_TOOLS].filter((n) => NOT_REVIEWED.has(n))).toEqual([]);
    expect(needsReview("delete_clips")).toBe(true);
    expect(needsReview("send_to_resolve")).toBe(true);
    expect(needsReview("list_timeline_clips")).toBe(false);
    expect(needsReview("remove_time_ranges")).toBe(false);
  });

  it("describes a change in plain words, with clip names from the timeline last read", () => {
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve", { timeline: "Main" });
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    rememberTimelineView("resolve", "Main", {
      project: "Doc", timeline: "Main", fps: 25, startTimecode: "01:00:00:00", duration: 9, isCurrent: true, markers: [],
      tracks: [{ type: "video", index: 1, name: "", enabled: true, clips: ["A", "B", "C", "D"].map((n, i) => ({ id: `c${i}`, name: `${n}.mov`, start: i, end: i + 1, enabled: true })) }],
    }); // prettier-ignore
    expect(describeChange("delete_clips", { clipIds: ["c0", "c1", "c2", "c3", "zz"] })).toBe("Delete 5 clips: A.mov, B.mov, C.mov and 2 more");
    expect(describeChange("split_clip", { clipId: "c1", time: 1.5 })).toBe("Split B.mov");
    expect(describeChange("add_markers", { markers: [{}, {}] })).toBe("Add markers (2)");
    expect(describeChange("create_timeline", { name: "Selects" })).toBe("Create a timeline: Selects");
    expect(describeChange("discard_draft", {})).toBe("Discard the draft");
  });
});
