import { useEffect, useState } from "react";
import { getOpenAtLogin, setOpenAtLogin } from "../../lib/ipc";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Open at login" (Settings → Window): the installed app starts in the menu bar when the user logs in
 * (login_item.rs, a LaunchAgent). A dev build can't, and says so; the box stays off and disabled.
 */
export function LoginItemRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getOpenAtLogin()
      .then((value) => live && setOn(value))
      .catch((problem: unknown) => live && setUnavailable(messageOf(problem)));
    return () => {
      live = false;
    };
  }, []);

  const toggle = (next: boolean) => {
    setError(null);
    setOn(next);
    setOpenAtLogin(next)
      .then(setOn)
      .catch((problem: unknown) => {
        setOn(!next);
        setError(messageOf(problem));
      });
  };

  return (
    <label className="mt-2 flex items-start gap-2 text-xs text-white">
      <input
        type="checkbox"
        className="mt-0.5 accent-athletic-blue-light"
        checked={on ?? false}
        disabled={on === null}
        onChange={(e) => toggle(e.target.checked)}
      />
      <span>
        Open at login
        <span className="block text-[11px] text-cool-grey">{unavailable ?? "Starts in the menu bar when you log in. No window opens."}</span>
        {error ? <span className="block text-[11px] text-loss">{error}</span> : null}
      </span>
    </label>
  );
}
