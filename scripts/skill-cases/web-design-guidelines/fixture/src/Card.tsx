import { useId } from 'react';

export function Card({ title, onOpen }: { title: string; onOpen: () => void }) {
  const titleId = useId();
  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <button type="button" onClick={onOpen}>
        Open {title}
      </button>
    </section>
  );
}
