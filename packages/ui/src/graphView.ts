import type { GraphPayload } from '../../core/src/types';

/**
 * The ids of the graph's largest connected part (links taken both ways): what the view fits on first draw, so a few
 * small groups linked to nothing else do not shrink the main part to a speck.
 */
export function mainPart(g: Pick<GraphPayload, 'nodes' | 'links'>): string[] {
  const parent = new Map<string, string>(g.nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const l of g.links) if (parent.has(l.source) && parent.has(l.target)) parent.set(find(l.source), find(l.target));
  const size = new Map<string, number>();
  for (const id of parent.keys()) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  let best = '';
  for (const [root, n] of size) if (!best || n > size.get(best)!) best = root;
  return g.nodes.map((n) => n.id).filter((id) => find(id) === best);
}
