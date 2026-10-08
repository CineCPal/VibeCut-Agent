import { useAgentStore } from "../../store/useAgentStore";
import { Section } from "../common/Section";

/** Settings → Agent → Chat: how the chat behaves. */
export function ChatSection() {
  const autoTitles = useAgentStore((s) => s.autoTitles);
  const setAutoTitles = useAgentStore((s) => s.setAutoTitles);
  const reviewEdits = useAgentStore((s) => s.reviewEdits);
  const setReviewEdits = useAgentStore((s) => s.setReviewEdits);

  return (
    <Section title="Chat">
      <label className="mb-2 flex items-start gap-2 text-xs text-white">
        <input type="checkbox" className="mt-0.5 accent-athletic-blue-light" checked={reviewEdits} onChange={(e) => setReviewEdits(e.target.checked)} />
        <span>
          Review edits before they&rsquo;re made
          <span className="block text-[11px] text-cool-grey">
            Each change to the timeline or project waits on its card for Apply or Skip; Apply all lets the rest of that request through. Reading, searching
            and the draft&rsquo;s own cuts don&rsquo;t ask. Also the shield in the Agent tab.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs text-white">
        <input type="checkbox" className="mt-0.5 accent-athletic-blue-light" checked={autoTitles} onChange={(e) => setAutoTitles(e.target.checked)} />
        <span>
          Name chats with the model
          <span className="block text-[11px] text-cool-grey">
            After a chat&rsquo;s first answer, the agent&rsquo;s model gives it a short name for History. It&rsquo;s one small extra call per new chat, on your
            Claude plan too. Off: chats are named after their first message. A name you give a chat always stays.
          </span>
        </span>
      </label>
    </Section>
  );
}
