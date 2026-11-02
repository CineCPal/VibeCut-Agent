import { useAgentStore } from "../../store/useAgentStore";
import { useSystemStore } from "../../store/useSystemStore";
import {
  AI_CHOICES,
  EFFORT_LEVELS,
  GEMINI_EFFORTS,
  claudeCodeUsable,
  type ChoiceAccess,
  type ClaudeCodeStatus,
  type ClaudeFamily,
  type CriticModel,
  type EffortLevel,
  type GeminiEffort,
} from "../../types/agent";
import type { KeyStatus } from "../../types/system";
import { Section } from "../common/Section";

export function providerReady(keys: KeyStatus | null, provider: ChoiceAccess, claudeCode: ClaudeCodeStatus | null = null): boolean {
  if (provider === "claude-code") return claudeCodeUsable(claudeCode);
  return keys?.[provider] ?? false;
}

const MISSING: Record<ChoiceAccess, string> = { gemini: " — key missing", "claude-code": " — Claude Code not ready" };

export const fieldClass = "w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-sm text-white";

const EFFORT_LABELS: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const FAMILY_LABELS: Record<ClaudeFamily, string> = { opus: "Opus effort", sonnet: "Sonnet effort" };
const GEMINI_EFFORT_LABELS: Record<GeminiEffort, string> = { low: "Low", medium: "Medium (default)", high: "High" };
const CRITIC_MODELS: readonly CriticModel[] = ["gemini", "same", "local"];

/** Settings → Agent → Agent model: the chat's model, Claude's effort per model, and the Story Editor's first read. */
export function AgentModelSection() {
  const aiChoice = useAgentStore((s) => s.aiChoice);
  const setAiChoice = useAgentStore((s) => s.setAiChoice);
  const storyFirstPass = useAgentStore((s) => s.storyFirstPass);
  const criticModel = useAgentStore((s) => s.criticModel);
  const setCriticModel = useAgentStore((s) => s.setCriticModel);
  const setStoryFirstPass = useAgentStore((s) => s.setStoryFirstPass);
  const effort = useAgentStore((s) => s.effort);
  const setEffort = useAgentStore((s) => s.setEffort);
  const geminiEffort = useAgentStore((s) => s.geminiEffort);
  const setGeminiEffort = useAgentStore((s) => s.setGeminiEffort);
  const keys = useSystemStore((s) => s.keys);
  const claudeCode = useSystemStore((s) => s.claudeCode);

  return (
    <Section title="Agent model">
      <label htmlFor="settings-model" className="sr-only">
        Agent model
      </label>
      <select
        id="settings-model"
        className={fieldClass}
        value={aiChoice}
        onChange={(event) => setAiChoice(event.target.value as typeof aiChoice)}
      >
        {AI_CHOICES.map((choice) => {
          const ready = providerReady(keys, choice.provider, claudeCode);
          return (
            <option key={choice.id} value={choice.id} disabled={!ready && choice.id !== aiChoice}>
              {choice.label}
              {ready ? "" : MISSING[choice.provider]}
            </option>
          );
        })}
      </select>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["opus", "sonnet"] as const).map((family) => (
          <div key={family}>
            <label htmlFor={`settings-effort-${family}`} className="block text-[11px] text-cool-grey">
              {FAMILY_LABELS[family]}
            </label>
            <select
              id={`settings-effort-${family}`}
              className={`${fieldClass} mt-0.5`}
              value={effort[family]}
              onChange={(event) => setEffort(family, event.target.value as EffortLevel)}
            >
              {EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABELS[level]}
                  {level === "medium" ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-cool-grey">
        How long Claude thinks in the chat, on your Claude subscription. Higher thinks longer and uses more of your plan&rsquo;s limits. The next message uses
        it.
      </p>
      <label htmlFor="settings-effort-gemini" className="mt-2 block text-[11px] text-cool-grey">
        Gemini thinking
      </label>
      <select
        id="settings-effort-gemini"
        className={`${fieldClass} mt-0.5`}
        value={geminiEffort}
        onChange={(event) => setGeminiEffort(event.target.value as GeminiEffort)}
      >
        {GEMINI_EFFORTS.map((level) => (
          <option key={level} value={level}>
            {GEMINI_EFFORT_LABELS[level]}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-cool-grey">
        How long Gemini Flash and Pro think before they answer. Higher is slower and bills more thinking tokens. Gemini Pro takes only low and high, so
        medium thinks high there.
      </p>
      <label htmlFor="settings-first-pass" className="mt-2 block text-[11px] text-cool-grey">
        Story Editor on long footage (over 2,000 transcript lines): first read
      </label>
      <select
        id="settings-first-pass"
        className={`${fieldClass} mt-0.5`}
        value={storyFirstPass}
        onChange={(event) => setStoryFirstPass(event.target.value === "gemini" ? "gemini" : "same")}
      >
        <option value="same">Same provider as the agent (Claude Sonnet, or Gemini Flash)</option>
        <option value="gemini" disabled={!keys?.gemini && storyFirstPass !== "gemini"}>
          Gemini Flash{keys?.gemini ? "" : " — key missing"}
        </option>
      </select>
      <p className="mt-1 text-[11px] text-cool-grey">
        It reads every line and shortlists the strongest moments, then the agent&rsquo;s model cuts the story from them. Text only. Gemini Flash is faster and
        spares your Claude plan&rsquo;s limits, but sends the transcripts to Google.
      </p>
      <label htmlFor="settings-critic" className="mt-2 block text-[11px] text-cool-grey">
        Edit review critic
      </label>
      <select
        id="settings-critic"
        className={`${fieldClass} mt-0.5`}
        value={criticModel}
        onChange={(event) => {
          const value = CRITIC_MODELS.find((m) => m === event.target.value);
          setCriticModel(value ?? "gemini");
        }}
      >
        <option value="gemini">Gemini Flash (default){keys?.gemini ? "" : " — key missing, uses the agent's model"}</option>
        <option value="same">Same model as the agent</option>
        <option value="local">Local (Qwen3-VL), on this Mac</option>
      </select>
      <p className="mt-1 text-[11px] text-cool-grey">
        Looks at stills either side of every cut when the agent reviews an edit. Gemini Flash is the cheapest and keeps reviews off your Claude plan limits,
        but sends the stills and what is said to Google. Local keeps them on this Mac: it needs the local model server with Qwen3-VL (ollama pull
        qwen3-vl:8b-instruct), and reviews less sharply; when it isn&rsquo;t there, or the GPU is busy with an ingest, Gemini Flash or the agent&rsquo;s model reviews
        instead and the review says so.
      </p>
    </Section>
  );
}
