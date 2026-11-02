/**
 * A small avatar with its state halo, for DAG nodes and the inspector's header (visualizer-spec.md §3.4 A):
 * a CSS sprite over the role's atlas (`background-size: 800% 800%`, the frame in `--sprite-col`), or the
 * SVG avatar where no atlas could be drawn.
 */
import type { SubagentType } from "@vibecut/contracts";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { useTicker } from "../../hooks/useTicker";
import { AVATAR_ANIMATION } from "../../lib/studio/avatarFsm";
import type { AvatarState } from "../../types/studio";
import { atlasDataUrl, FRAMES, ProceduralPixelAvatar } from "./ProceduralPixelAvatar";

export interface AvatarBadgeProps {
  subagent: SubagentType;
  state: AvatarState;
  size?: number;
  animate?: boolean;
  label?: string;
}

export function AvatarBadge({ subagent, state, size = 32, animate = true, label }: AvatarBadgeProps) {
  const { row, fps, halo } = AVATAR_ANIMATION[state];
  const frame = useTicker(fps, animate) % FRAMES;
  const url = useMemo(() => atlasDataUrl(subagent), [subagent]);
  const ring: CSSProperties = {
    width: size,
    height: size,
    boxShadow: `0 0 0 2px ${halo}${state === "PROCESSING_THINKING" ? "" : "cc"}`,
  };
  const name = label ?? `${subagent.replaceAll("_", " ").toLowerCase()}, ${state.replaceAll("_", " ").toLowerCase()}`;
  if (url) {
    const style = {
      ...ring,
      "--sprite-col": frame,
      "--sprite-row": row,
      backgroundImage: `url(${url})`,
      backgroundSize: "800% 800%",
      backgroundPosition: `calc(var(--sprite-col) * 100% / 7) calc(var(--sprite-row) * 100% / 7)`,
    } as CSSProperties;
    return <span role="img" aria-label={name} className="pixelated inline-block shrink-0 rounded-sm bg-surface" style={style} data-avatar-state={state} />;
  }
  return (
    <span className="inline-block shrink-0 rounded-sm bg-surface" style={ring} data-avatar-state={state}>
      <ProceduralPixelAvatar subagent={subagent} state={state} frame={frame} size={size} title={name} />
    </span>
  );
}
