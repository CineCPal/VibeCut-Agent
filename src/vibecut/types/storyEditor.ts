/** One entry in the text-only B-roll catalog sent to the Story Editor's model call — see
 * vibecut_agent/story/prompt.py. Never carries raw video. (VibeCut's src/types/storyEditor.ts.) */
export interface StoryBrollCatalogEntry {
  brollId: string;
  path: string;
  durationSeconds: number;
  caption: string | null;
  tags: string[];
  technicalScore: number | null;
}
