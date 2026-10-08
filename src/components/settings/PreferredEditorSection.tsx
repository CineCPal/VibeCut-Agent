import { useNleStateStore } from "../../store/useNleStateStore";
import { NLE_HOSTS, NLE_LABELS, type PreferredHost } from "../../types/nle";
import { Section } from "../common/Section";
import { fieldClass } from "./AgentModelSection";

/** Settings → Editors → Preferred editor: which editor the agent works in when both are connected. */
export function PreferredEditorSection() {
  const preferredHost = useNleStateStore((s) => s.preferredHost);
  const setPreferredHost = useNleStateStore((s) => s.setPreferredHost);

  return (
    <Section title="Preferred editor">
      <label htmlFor="settings-host" className="sr-only">
        Preferred editor
      </label>
      <select id="settings-host" className={fieldClass} value={preferredHost} onChange={(event) => setPreferredHost(event.target.value as PreferredHost)}>
        <option value="auto">Automatic (first connected)</option>
        {NLE_HOSTS.map((host) => (
          <option key={host} value={host}>
            {NLE_LABELS[host]}
          </option>
        ))}
      </select>
    </Section>
  );
}
