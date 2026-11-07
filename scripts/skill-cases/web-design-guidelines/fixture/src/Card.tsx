export function Card({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <section className="card" aria-labelledby="card-title">
      <h2 id="card-title">{title}</h2>
      <button type="button" onClick={onOpen}>
        Open
      </button>
    </section>
  );
}
