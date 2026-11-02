/**
 * The VLM's 3-frame contact strip (visualizer-spec.md §4.2 C, VCTB 0x02): the JPEG streamed for the task,
 * split into START, MID and END, with the shot tags the worker reported. The URL is an object URL the
 * store owns (and revokes when a newer strip replaces it).
 */
export interface ContactStripViewerProps {
  src: string | null;
  mediaPath: string;
  shotCount: number;
  scales: string[];
  tags?: { camera_movement?: string; lighting?: string };
}

const THIRDS = ["START", "MID", "END"] as const;

export function ContactStripViewer({ src, mediaPath, shotCount, scales, tags }: ContactStripViewerProps) {
  const name = mediaPath.split("/").pop() ?? mediaPath;
  return (
    <figure className="rounded border border-border bg-canvas p-2" aria-label={`Contact strip of ${name}`}>
      <div className="relative grid grid-cols-3 overflow-hidden rounded-sm border border-border" style={{ aspectRatio: "720 / 135" }}>
        {src ? (
          <img src={src} alt={`Start, middle and end frames of ${name}`} className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
        {THIRDS.map((third) => (
          <div key={third} className={`relative border-r border-border last:border-r-0 ${src ? "" : "bg-surface"}`}>
            <span className="absolute left-1 top-1 rounded bg-canvas/80 px-1 font-mono text-[9px] text-warm-grey">{third}</span>
          </div>
        ))}
        {!src && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-cool-grey">No strip was streamed for this task</span>
        )}
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-1 font-mono text-[10px]">
        <span className="text-[#e6edf3]">{name}</span>
        <span className="text-cool-grey">{shotCount} shots</span>
        {scales.map((s) => (
          <span key={s} className="rounded border border-[#a855f7] px-1 text-[#a855f7]">
            {s}
          </span>
        ))}
        {tags?.camera_movement && <span className="rounded border border-border px-1 text-warm-grey">{tags.camera_movement}</span>}
        {tags?.lighting && <span className="rounded border border-border px-1 text-warm-grey">{tags.lighting}</span>}
      </figcaption>
    </figure>
  );
}
