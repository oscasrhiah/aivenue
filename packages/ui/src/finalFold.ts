/**
 * The final result / plan card's fold (pages/Chat.tsx FinalResult): open by default, remembered per run while the app
 * runs (not saved), and the one-line preview it shows when folded.
 */
const folded = new Set<string>();

export const isFolded = (runId: string) => folded.has(runId);

export function setFolded(runId: string, on: boolean) {
  if (on) folded.add(runId);
  else folded.delete(runId);
}

/** The text's first words without Markdown marks, for one ellipsized line (the CSS cuts it to the width). */
export function previewLine(text: string, max = 240): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max) : plain;
}

/** A click on the head toggles the fold unless it landed on one of the head's own controls (copy, progress…). */
export function headClickToggles(target: { closest?: (selector: string) => unknown } | null): boolean {
  return !target?.closest?.('button, a, input, select, textarea, label, summary, [role="button"], [role="switch"]');
}
