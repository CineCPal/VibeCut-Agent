import type { AriaAttributes, ReactNode } from "react";

/** VibeCut's panel controls (src-host-panel/src/Press.tsx), CEP's: a real <button> and checkbox. */
export type PressProps = AriaAttributes & {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
};

export function Press({ children, className, disabled, onClick, ...rest }: PressProps) {
  return (
    <button type="button" className={className} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

export function Check({ checked, disabled, onChange, className, title, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; className?: string; title?: string; children: ReactNode }) {
  return (
    <label className={className} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
