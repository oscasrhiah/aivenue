import { useEffect, useState, type HTMLAttributes } from 'react';

export type DragProps = {
  dragging: boolean;
  over?: 'drop-before' | 'drop-after';
  row: HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  grip: HTMLAttributes<HTMLSpanElement>;
};

/**
 * Drag items into the order you want, by their grip (so text in them can still be selected). The new order shows at
 * once, then `save` stores it; `axis` 'x' is for cards side by side in a grid (drop to the left or right of one).
 */
export function useDragOrder<T>(items: T[], idOf: (x: T) => string, save: (ids: string[]) => Promise<unknown>, axis: 'x' | 'y' = 'y') {
  const [local, setLocal] = useState<string[]>();
  const [dragId, setDragId] = useState<string>();
  const [armed, setArmed] = useState<string>();
  const [over, setOver] = useState<{ id: string; after: boolean }>();
  // The saved order arrived (or an item was added or removed): drop the optimistic one.
  const key = items.map(idOf).join('|');
  useEffect(() => setLocal(undefined), [key]);
  const ids = local ?? items.map(idOf);
  const list = ids.map((id) => items.find((x) => idOf(x) === id)).filter((x): x is T => x !== undefined);
  const end = () => (setDragId(undefined), setOver(undefined), setArmed(undefined));
  const props = (id: string): DragProps => ({
    dragging: dragId === id,
    over: over?.id === id && dragId && dragId !== id ? (over.after ? 'drop-after' : 'drop-before') : undefined,
    row: {
      draggable: armed === id,
      onDragStart: (e) => {
        setDragId(id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
      },
      onDragOver: (e) => {
        if (!dragId) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
        if (over?.id !== id || over.after !== after) setOver({ id, after });
      },
      onDrop: (e) => {
        e.preventDefault();
        if (!dragId || dragId === id) return end();
        const next = ids.filter((x) => x !== dragId);
        const at = next.indexOf(id) + (over?.id === id && over.after ? 1 : 0);
        next.splice(at, 0, dragId);
        setLocal(next);
        end();
        save(next).catch(() => setLocal(undefined));
      },
      onDragEnd: end,
    },
    grip: { onMouseDown: () => setArmed(id), onMouseUp: () => setArmed(undefined) },
  });
  return { list, props };
}
