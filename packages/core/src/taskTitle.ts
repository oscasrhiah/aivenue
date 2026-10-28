/** A period ends a sentence only before a space or the end, not inside "src/parser.ts". */
const SENTENCE_END = /(?<=[。！？])|(?<=[.!?])(?=\s|$)|\n+/;

/**
 * A short name for a delegated task, for cards and the agent map. Tasks often open with context ("You work in the
 * Node.js project C:\…"), so the name comes from what is actually asked: a "task:" line, else its first bold
 * phrase, else the first sentence that is not about where or how to work.
 */
export function taskTitle(task: string, max = 48): string {
  const clean = (s: string) =>
    s
      .replace(/[*`_#>]+/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s:：\-–—,，.。]+|[\s:：\-–—,，]+$/g, '')
      .trim();
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const asked = /(?:你的任務|任務|工作|your task|task)\s*[:：]\s*(.+)/i.exec(task)?.[1];
  if (asked) {
    const bold = /\*\*(.+?)\*\*/.exec(asked)?.[1];
    const first = clean(bold ?? asked.split(SENTENCE_END)[0]);
    if (first.length >= 4) return clip(first);
  }
  const bold = /\*\*(.+?)\*\*/.exec(task)?.[1];
  if (bold && clean(bold).length >= 4) return clip(clean(bold));
  const sentences = task.split(SENTENCE_END).map(clean).filter((s) => s.length >= 4);
  // Skip set-up sentences: where to work, which runtime, who else is working.
  const setup = /^(你在|你是|you are|you work|working in|in the|context|背景|另一位|another)|[A-Za-z]:\\|\/(users|home)\//i;
  return clip(sentences.find((s) => !setup.test(s)) ?? sentences[0] ?? clean(task));
}
