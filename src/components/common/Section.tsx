import type { ReactNode } from "react";

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cool-grey">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
