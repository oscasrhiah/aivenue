import { useEffect, useRef, useState } from 'react';
import type { ProviderInfo, ProviderUsage } from '../../../core/src/types';
import { useT } from '../i18n';
import { cx, providerName } from '../util';

/** An extra account's id is `<tool>~<slug>`: the tool it belongs to. */
const toolOf = (id: string) => id.split('~')[0];

/** A limit hit this recent still counts (same as auto assignment). */
const RECENT_LIMIT = 5 * 3600_000;

/** What is left of an account's plan quota: the tightest time window, or a recent limit hit. */
export function remaining(u: ProviderUsage | undefined): { pct?: number; full: boolean } {
  const windows = u?.official?.windows.filter((w) => w.minutes > 0) ?? [];
  const pct = windows.length ? Math.max(0, Math.round(100 - Math.max(...windows.map((w) => w.usedPercent)))) : undefined;
  const hit = !!u?.limitHit && Date.now() - u.limitHit.at < RECENT_LIMIT;
  return { pct, full: !!u?.official?.limitReached || pct === 0 || (pct === undefined && hit) };
}

/** "5 小時剩 80% · 每週剩 50%": every quota window of the account, by its length. */
function quotaText(t: ReturnType<typeof useT>, u: ProviderUsage | undefined): string {
  const windows = u?.official?.windows ?? [];
  const name = (w: (typeof windows)[number]) =>
    w.label ??
    (w.minutes === 300
      ? t('5 小時', '5-hour')
      : w.minutes === 10080
        ? t('每週', 'weekly')
        : w.minutes >= 40000 && w.minutes <= 46000
          ? t('每月', 'monthly')
          : w.minutes % 1440 === 0
            ? t(`${w.minutes / 1440} 天`, `${w.minutes / 1440}-day`)
            : t(`${Math.round(w.minutes / 60)} 小時`, `${Math.round(w.minutes / 60)}-hour`));
  const parts = windows.map((w) => t(`${name(w)}剩 ${Math.max(0, Math.round(100 - w.usedPercent))}%`, `${name(w)} ${Math.max(0, Math.round(100 - w.usedPercent))}% left`));
  if (parts.length) return parts.join(' · ');
  return u?.limitHit && Date.now() - u.limitHit.at < RECENT_LIMIT ? t('最近碰到額度上限', 'hit its limit recently') : t('額度無法取得', 'quota unknown');
}

export type SwitchOption = { id: string; label: string };

/**
 * The "use … instead" options of a decision, one button per tool with what is left of its 5-hour, weekly… quotas.
 * A tool with several signed-in accounts gets one button that opens the menu of its accounts, each with its quotas.
 */
export function SwitchChoices({ options, providers, usage, onChoose, first }: { options: SwitchOption[]; providers: ProviderInfo[]; usage: ProviderUsage[]; onChoose: (id: string) => void; first?: boolean }) {
  const groups = new Map<string, SwitchOption[]>();
  for (const o of options) {
    const tool = toolOf(o.id.slice(7));
    groups.set(tool, [...(groups.get(tool) ?? []), o]);
  }
  return (
    <>
      {[...groups.entries()].map(([tool, list], i) => (
        <SwitchGroup key={tool} tool={tool} list={list} providers={providers} usage={usage} onChoose={onChoose} primary={first && i === 0} />
      ))}
    </>
  );
}

function SwitchGroup({ tool, list, providers, usage, onChoose, primary }: { tool: string; list: SwitchOption[]; providers: ProviderInfo[]; usage: ProviderUsage[]; onChoose: (id: string) => void; primary?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const usageOf = (o: SwitchOption) => usage.find((u) => u.providerId === o.id.slice(7));
  const name = providerName(providers, tool);
  if (list.length === 1) {
    return (
      <button className={cx('btn', primary && 'primary')} onClick={() => onChoose(list[0].id)}>
        {t(`改用 ${name}`, `Use ${name} instead`)}
        <span className="switch-left"> — {quotaText(t, usageOf(list[0]))}</span>
      </button>
    );
  }
  // The account with the most left first, one at its limit last.
  const rank = (o: SwitchOption) => {
    const r = remaining(usageOf(o));
    return r.full ? -1 : (r.pct ?? 50);
  };
  const ranked = [...list].sort((a, b) => rank(b) - rank(a));
  const account = (o: SwitchOption) => providers.find((x) => x.spec.id === o.id.slice(7))?.spec.accountName ?? t('主帳號', 'Main account');
  return (
    <span className="switch-prov" ref={ref}>
      <button className={cx('btn', primary && 'primary')} aria-expanded={open} onClick={() => setOpen(!open)}>
        {t(`改用 ${name}`, `Use ${name} instead`)}
        <span className="switch-left"> {t(`（${list.length} 個帳號）`, ` (${list.length} accounts)`)} ▾</span>
      </button>
      {open && (
        <div className="menu switch-menu left">
          {ranked.map((o) => (
            <button key={o.id} onClick={() => (setOpen(false), onChoose(o.id))}>
              <span className="grow">
                {name}（{account(o)}）<span className="muted"> — {quotaText(t, usageOf(o))}</span>
              </span>
              {remaining(usageOf(o)).full && <span className="pill warn">{t('額度已滿', 'At its limit')}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
