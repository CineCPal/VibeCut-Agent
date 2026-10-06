import { useState, type FormEvent } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { removeApiKey, setApiKey } from "../../lib/ipc";
import { useSystemStore } from "../../store/useSystemStore";
import type { KeyProvider, KeySource, KeyStatus } from "../../types/system";
import { Section } from "../common/Section";
import { StatusDot } from "../common/StatusDot";

const LABEL: Record<KeyProvider, string> = { gemini: "Gemini", anthropic: "Anthropic (Claude)", huggingface: "Hugging Face (speaker labels)" };
const KEY_ENV: Record<KeyProvider, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", huggingface: "HF_TOKEN" };
const SOURCE: Record<KeyProvider, (k: KeyStatus) => KeySource | null> = {
  gemini: (k) => k.geminiSource,
  anthropic: (k) => k.anthropicSource,
  huggingface: (k) => k.huggingfaceSource ?? null,
};
const SOURCE_TEXT: Record<KeySource, string> = { environment: "From the environment", keychain: "In the Keychain" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One provider's key: whether it's set and where, a write-only field to save one in the Keychain, and Remove. */
function KeyRow({ provider }: { provider: KeyProvider }) {
  const keys = useSystemStore((s) => s.keys);
  const setKeys = useSystemStore((s) => s.setKeys);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const source = keys ? SOURCE[provider](keys) : null;
  const fieldId = `key-${provider}`;
  // Only speaker labels need the Hugging Face token; transcripts work without it.
  const optional = provider === "huggingface";

  const run = async (action: () => Promise<KeyStatus>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      setKeys(await action());
      setNotice({ text: done, failed: false });
    } catch (error) {
      setNotice({ text: message(error), failed: true });
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const key = value;
    // Cleared at once: the key isn't kept in the page any longer than the call.
    setValue("");
    void run(() => setApiKey(provider, key), "Saved in the Keychain");
  };

  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-white">{LABEL[provider]}</span>
        <span className="flex items-center gap-1.5 text-xs">
          <StatusDot tone={keys === null ? "off" : source ? "ok" : optional ? "off" : "warn"} />
          {keys === null ? "Unknown" : source ? SOURCE_TEXT[source] : optional ? "Not set (optional)" : "Missing"}
        </span>
      </div>
      <form onSubmit={save} className="mt-1 flex gap-1.5">
        <label htmlFor={fieldId} className="sr-only">
          {LABEL[provider]} {provider === "huggingface" ? "token" : "API key"}
        </label>
        <input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={source === "keychain" ? "Paste a new key to replace it" : `Paste your ${KEY_ENV[provider]}`}
          className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1 font-mono text-[11px] text-white placeholder:text-cool-grey"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="flex items-center gap-1 rounded-md bg-athletic-blue px-2 py-1 text-[11px] text-white disabled:opacity-40"
        >
          <KeyRound size={12} aria-hidden="true" />
          Save
        </button>
        {source === "keychain" ? (
          <button
            type="button"
            onClick={() => void run(() => removeApiKey(provider), "Removed from the Keychain")}
            disabled={busy}
            aria-label={`Remove the ${LABEL[provider]} key from the Keychain`}
            className="rounded-md px-1.5 text-cool-grey hover:text-loss disabled:opacity-40"
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        ) : null}
      </form>
      {source === "environment" ? (
        <p className="mt-1 text-[11px] text-cool-grey">
          {KEY_ENV[provider]} is set where the app started (or in .env), and that takes precedence over the Keychain.
        </p>
      ) : null}
      {notice ? (
        <p role={notice.failed ? "alert" : "status"} className={`mt-1 text-[11px] ${notice.failed ? "text-loss" : "text-profit"}`}>
          {notice.text}
        </p>
      ) : null}
    </li>
  );
}

export function ApiKeysSection() {
  return (
    <Section title="API keys">
      <ul className="divide-y divide-border">
        <KeyRow provider="gemini" />
        <KeyRow provider="anthropic" />
        <KeyRow provider="huggingface" />
      </ul>
      <p className="mt-1 text-[11px] text-cool-grey">
        Saved in your macOS login Keychain, never shown again or stored by the app elsewhere. A key is only sent to its
        provider while you chat with that model. The Hugging Face token is optional: transcripts use it only to tell
        speakers apart (accept the pyannote speaker-diarization licences on huggingface.co first).
      </p>
    </Section>
  );
}
