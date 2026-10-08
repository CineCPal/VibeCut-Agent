import { toggleKeepOnTop } from "../../hooks/useKeepOnTop";
import { useUiStore } from "../../store/useUiStore";
import { Section } from "../common/Section";
import { LoginItemRow } from "./LoginItemRow";

/** Settings → General → Window: Keep on Top of Editors and Open at login. */
export function WindowSection() {
  const keepOnTop = useUiStore((s) => s.keepOnTop);

  return (
    <Section title="Window">
      <label className="flex items-start gap-2 text-xs text-white">
        <input
          type="checkbox"
          className="mt-0.5 accent-athletic-blue-light"
          checked={keepOnTop ?? true}
          disabled={keepOnTop === null}
          onChange={(e) => void toggleKeepOnTop(e.target.checked)}
        />
        <span>
          Keep on top of editors
          <span className="block text-[11px] text-cool-grey">
            Stays in front of other apps and shows over a full-screen Premiere Pro or DaVinci Resolve (it follows you to every Space). Also in the menu-bar menu
            and the pin in the header.
          </span>
        </span>
      </label>
      <LoginItemRow />
    </Section>
  );
}
