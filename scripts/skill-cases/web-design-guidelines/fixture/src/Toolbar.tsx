import { useState } from 'react';

export function Toolbar({ onDelete, go }: { onDelete: () => void; go: (to: string) => void }) {
  const [q, setQ] = useState('');
  return (
    <div className="toolbar" style={{ transition: 'all 200ms' }}>
      <div className="nav" onClick={() => go('/settings')}>Settings</div>
      <button className="icon" onClick={onDelete}>
        <svg width="16" height="16" />
      </button>
      <input value={q} placeholder="Search..." onChange={(e) => setQ(e.target.value)} onPaste={(e) => e.preventDefault()} />
      <img src="/logo.png" />
      <span className="status">Loading...</span>
      <style>{`.toolbar button:focus { outline: none; }`}</style>
    </div>
  );
}
