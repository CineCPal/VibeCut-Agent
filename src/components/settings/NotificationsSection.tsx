import { useState } from "react";
import { enableNotifications } from "../../lib/notify";
import { useNotifyStore } from "../../store/useNotifyStore";
import { Section } from "../common/Section";

/** Settings → General → Notifications (Phase 11e). */
export function NotificationsSection() {
  const enabled = useNotifyStore((s) => s.enabled);
  const sound = useNotifyStore((s) => s.sound);
  const [denied, setDenied] = useState(false);

  const toggle = async (on: boolean) => {
    setDenied(false);
    if (!on) {
      useNotifyStore.getState().setEnabled(false);
      return;
    }
    if (!(await enableNotifications())) setDenied(true);
  };

  return (
    <Section title="Notifications">
      <label className="flex items-start gap-2 text-xs text-white">
        <input type="checkbox" className="mt-0.5 accent-athletic-blue-light" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Notify when the agent finishes or needs you
          <span className="block text-[11px] text-cool-grey">
            Only while the window is hidden or behind another app: when an answer is done, something fails, or a change waits for your review. Shown by
            macOS; nothing is sent anywhere.
          </span>
        </span>
      </label>
      <label className="mt-1.5 flex items-start gap-2 pl-5 text-xs text-white">
        <input
          type="checkbox"
          className="mt-0.5 accent-athletic-blue-light"
          checked={sound}
          disabled={!enabled}
          onChange={(e) => useNotifyStore.getState().setSound(e.target.checked)}
        />
        <span>Play a sound</span>
      </label>
      {denied ? (
        <p role="alert" className="mt-1 text-[11px] text-warning">
          macOS isn&rsquo;t letting VibeCut Agent show notifications. Allow them in System Settings → Notifications → VibeCut Agent.
        </p>
      ) : null}
    </Section>
  );
}
