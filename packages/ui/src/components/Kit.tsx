import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, Circle, CircleDot, X, type LucideIcon } from 'lucide-react';
import { Ico } from '../icons';
import { useT } from '../i18n';
import { cx } from '../util';
import { splitHint, tabStep, visibleItems } from '../settingsView';

/*
 * The parts Settings, the workflow settings window, the agent map and the detail windows are built from (round C): a
 * dialog with a title, a close button and a footer that never covers what scrolls; a fold button; a hint of one sentence
 * with the rest behind 說明; a long list shown in part; segmented choices and radio lists that say which one is chosen; a
 * named switch; a state as an icon and a word.
 */

const CANDIDATES = 'button, a[href], area[href], input, select, textarea, summary, [tabindex], [contenteditable]';

/**
 * The elements Tab stops at inside `root`, in document order: shown, not disabled, not inert, with a tab index of 0 or
 * more (a control with tabIndex -1, such as an option of a group the arrow keys move through, is reached otherwise);
 * of a group of radio inputs only the checked one, or the first when none is.
 */
export function tabStops(root: HTMLElement): HTMLElement[] {
  const radios = new Map<string, HTMLInputElement[]>();
  const stops: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(CANDIDATES)) {
    if (el.tabIndex < 0 || el.matches(':disabled') || el.closest('[inert]')) continue;
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = radios.get(el.name) ?? [];
      if (!group.length) radios.set(el.name, group);
      group.push(el);
    }
    stops.push(el);
  }
  // A radio group is one stop: drop every radio but the checked one (or the first).
  const skip = new Set<HTMLElement>();
  for (const group of radios.values()) {
    const keep = group.find((r) => r.checked) ?? group[0];
    for (const r of group) if (r !== keep) skip.add(r);
  }
  return skip.size ? stops.filter((el) => !skip.has(el)) : stops;
}

/**
 * A dialog's keyboard: the focus moves into it (onto the dialog itself, which a screen reader announces by its title,
 * or, with focus 'first', its first control after the close button; a field that focuses itself keeps it), Tab and
 * Shift+Tab stay inside, Esc closes only the dialog on top (not a menu or list open in it), and the focus goes back to
 * what opened it.
 */
export function useDialogKeys(box: React.RefObject<HTMLElement | null>, onEscape: () => void, focus: 'box' | 'first' = 'box', returnFocus?: () => HTMLElement | null | undefined) {
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  const esc = useRef(onEscape);
  esc.current = onEscape;
  // What had the focus when it opened, read while it first renders (before a field in it focuses itself).
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) openerRef.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const opener = openerRef.current;
    if (box.current && !box.current.contains(document.activeElement)) {
      const list = tabStops(box.current);
      (focus === 'first' ? list[1] ?? list[0] ?? box.current : box.current)?.focus();
    }
    // Only the dialog drawn last answers (a window opened from this one comes after it).
    const onTop = () => {
      const all = [...document.querySelectorAll('.modal')];
      return !!box.current && all[all.length - 1] === box.current;
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !onTop()) return;
      const a = document.activeElement as HTMLElement | null;
      // A menu or a list open inside it closes first (its own keys handle that).
      if (a?.closest('[role="menu"], [role="listbox"], .perm-menu, .adv-menu')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      esc.current();
    };
    // Tab is handled last (on the window, after the page's own handlers): a menu that closes on Tab has put the focus
    // back on its button by then, and a part that keeps Tab for itself (an enlarged screenshot) has prevented it. The
    // dialog then moves the focus itself, among the stops Tab really reaches, so it never leaves the dialog (a control
    // the browser skips is never taken for the last one).
    const onTab = (e: KeyboardEvent) => {
      const el = box.current;
      if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !el || !onTop()) return;
      e.preventDefault();
      const list = tabStops(el);
      const a = document.activeElement;
      const inside = !!a && el.contains(a);
      const at = a ? list.indexOf(a as HTMLElement) : -1;
      const before = inside && at < 0 ? list.filter((s) => s.compareDocumentPosition(a!) & Node.DOCUMENT_POSITION_FOLLOWING).length : 0;
      const next = tabStep(list.length, at, before, e.shiftKey, inside);
      (next >= 0 ? list[next] : el).focus();
    };
    document.addEventListener('keydown', onEsc, true);
    window.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('keydown', onTab);
      // What opened it may be gone (a popover that closed as the dialog opened): then the fallback the caller names.
      const back = opener?.isConnected ? opener : fallback.current?.();
      if (back?.isConnected) back.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A dialog: a title and a close button in its head, its content scrolling in between, and a footer under that (never
 * over it). A click on the dimmed page closes it unless `keepOpen`. `size` sets its width; below 520px every dialog
 * becomes a full-height sheet. `lead` goes before the title (a back button), `onEscape` replaces closing on Esc.
 * `returnFocus`: where the focus goes on closing when what opened it is no longer on the page.
 */
export function Dialog({
  title,
  onClose,
  children,
  foot,
  className,
  size = 'md',
  lead,
  onEscape,
  closeLabel,
  role = 'dialog',
  keepOpen,
  back,
  focus,
  returnFocus,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  lead?: ReactNode;
  onEscape?: () => void;
  closeLabel?: string;
  role?: 'dialog' | 'alertdialog';
  keepOpen?: boolean;
  /** A class for the dimmed page behind (e.g. a window over another window). */
  back?: string;
  /** Where the focus goes when it opens: the dialog itself (default) or its first control. */
  focus?: 'box' | 'first';
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogKeys(box, onEscape ?? onClose, focus, returnFocus);
  return (
    <div
      className={cx('modal-back', back)}
      onClick={(e) => {
        e.stopPropagation();
        if (!keepOpen && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={box} className={cx('modal dialog', `dialog-${size}`, className)} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          {lead}
          <h3 id={titleId} className="dialog-title">
            {title}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel ?? t('關閉', 'Close')} title={closeLabel ?? t('關閉', 'Close')}>
            <Ico i={X} size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {foot && <div className="dialog-foot wf-modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** What opens more in place: a quiet text button with a chevron that turns, and its state (Tab, Enter, Space). */
export function Fold({ open, onToggle, children, className, controls }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string; controls?: string }) {
  return (
    <button type="button" className={cx('fold-btn', className)} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <Ico i={ChevronRight} size={14} className={cx('fold-chev', open && 'open')} /> {children}
    </button>
  );
}

/**
 * A hint: its first sentence, and the rest behind a 說明 button (nothing is dropped). `full` shows all of it at once.
 */
export function Hint({ text, className, full }: { text: string; className?: string; full?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const [first, rest] = full ? [text, ''] : splitHint(text);
  return (
    <div className={cx('hint', className)}>
      <span>{first}</span>
      {rest && (
        <>
          {' '}
          <button type="button" className="hint-more" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
            {open ? t('收起', 'Less') : t('說明', 'More')}
          </button>
          {open && (
            <span id={id} className="hint-rest">
              {' '}
              {rest}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** A long list: its first `limit` rows, then 「顯示全部 N 個」 (a button with its state) for the rest. */
export function ShowAll<T>({ list, limit = 5, children }: { list: T[]; limit?: number; children: (shown: T[]) => ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { shown, hidden } = visibleItems(list, limit, open);
  return (
    <>
      {children(shown)}
      {(hidden > 0 || (open && list.length > limit + 1)) && (
        <button type="button" className="fold-btn show-all" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Ico i={ChevronRight} size={14} className={cx('fold-chev', open && 'open')} /> {open ? t('只顯示前幾個', 'Show fewer') : t(`顯示全部 ${list.length} 個`, `Show all ${list.length}`)}
        </button>
      )}
    </>
  );
}

/**
 * Arrow keys, Home and End in a group of radios (a disabled choice is skipped). With `pick`, the choice follows the
 * focus, as the WAI-ARIA radio group does; without it (a radio list, segments marked `manual`: choices that ask for a
 * confirmation or write a setting at once) the arrows move only the focus, and Space or Enter chooses.
 */
function radioKeys(e: ReactKeyboardEvent<HTMLElement>, values: string[], value: string | undefined, pick?: (v: string) => void) {
  const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key as 'ArrowRight'];
  if (!next && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const usable = radios.map((_, i) => i).filter((i) => !radios[i].disabled);
  if (!usable.length) return;
  const focused = radios.indexOf(document.activeElement as HTMLButtonElement);
  const at = usable.indexOf(focused >= 0 ? focused : Math.max(0, values.indexOf(value ?? '')));
  const k = e.key === 'Home' ? 0 : e.key === 'End' ? usable.length - 1 : at < 0 ? 0 : (at + next + usable.length) % usable.length;
  const to = usable[k];
  if (pick) {
    pick(values[to]);
    requestAnimationFrame(() => radios[to]?.focus());
  } else radios[to]?.focus();
}
export interface Choice<V extends string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  hint?: ReactNode;
  /** A risk colour for its name (the whole-computer and auto-without-isolation permissions). */
  tone?: '' | 'warn' | 'err';
  title?: string;
  /** This one choice cannot be taken now (it stays shown, so you see it exists); `title` says why. */
  disabled?: boolean;
}

/**
 * Two or three short choices side by side; the chosen one is a radio that says so (aria-checked), not only a tint.
 * `manual`: the arrows only move the focus and Space or Enter chooses (for a choice that is saved at once).
 */
export function Seg<V extends string>({ value, choices, onChange, label, disabled, className, manual }: { value: V | undefined; choices: Choice<V>[]; onChange: (v: V) => void; label: string; disabled?: boolean; className?: string; manual?: boolean }) {
  const first = choices.find((c) => !c.disabled);
  return (
    <div className={cx('seg', className)} role="radiogroup" aria-label={label} onKeyDown={(e) => !disabled && radioKeys(e, choices.map((c) => c.value), value, manual ? undefined : (v) => onChange(v as V))}>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={c.value === value}
          tabIndex={c.value === value || (!choices.some((x) => x.value === value) && c === first) ? 0 : -1}
          className={cx(c.value === value && 'on', c.tone === 'err' && 'danger')}
          disabled={disabled || c.disabled}
          title={c.title}
          onClick={() => c.value !== value && onChange(c.value)}
        >
          {c.icon && <Ico i={c.icon} size={14} />}
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Choices one under the other, each with its icon, name and a line on what it does: for a choice too long for a row of
 * segments (the permission levels, the flow mode). The chosen one: a filled radio and a quiet background. The radio is
 * its name; the line sits beside it (aria-describedby), so a 說明 button in that line is a control of its own, never
 * one inside the radio. A click anywhere on the row chooses it. `hints`: 'all' under every choice, 'chosen' under the
 * chosen one only.
 */
export function RadioList<V extends string>({ value, choices, onChange, label, labelledBy, disabled, className, hints = 'all' }: { value: V | undefined; choices: Choice<V>[]; onChange: (v: V) => void; label?: string; labelledBy?: string; disabled?: boolean; className?: string; hints?: 'all' | 'chosen' }) {
  const id = useId();
  const first = choices.find((c) => !c.disabled);
  return (
    <div className={cx('radio-list', className)} role="radiogroup" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} onKeyDown={(e) => !disabled && radioKeys(e, choices.map((c) => c.value), value)}>
      {choices.map((c, i) => {
        const on = c.value === value;
        const off = disabled || c.disabled;
        const hint = !!c.hint && (hints === 'all' || on);
        return (
          <div
            key={c.value}
            className={cx('radio-item', on && 'on', off && 'disabled')}
            title={c.title}
            onClick={(e) => {
              // The row chooses, except through a control of its own in the line (說明).
              if (off || on || (e.target as HTMLElement).closest('.radio-hint :is(button, a)')) return;
              onChange(c.value);
            }}
          >
            <button type="button" role="radio" aria-checked={on} aria-describedby={hint ? `${id}-${i}` : undefined} tabIndex={on || (!choices.some((x) => x.value === value) && c === first) ? 0 : -1} className="radio-btn" disabled={off}>
              <Ico i={on ? CircleDot : Circle} size={16} className="radio-mark" />
              {c.icon && <Ico i={c.icon} size={16} className={cx('radio-icon', c.tone)} />}
              <span className={cx('radio-name', c.tone)}>{c.label}</span>
            </button>
            {hint && (
              <div id={`${id}-${i}`} className="radio-hint">
                {c.hint}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
/** A switch with a name (its row's label), so a screen reader says what it turns on; the focus ring shows on its track. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" />
    </label>
  );
}

/** A state said with an icon and a coloured word, no box. */
export function StateWord({ icon, tone, children, spin, className, title, id }: { icon: LucideIcon; tone?: string; children: ReactNode; spin?: boolean; className?: string; title?: string; id?: string }) {
  return (
    <span id={id} className={cx('state-word', tone, className)} title={title}>
      <Ico i={icon} size={16} className={spin ? 'spin' : undefined} />
      {children}
    </span>
  );
}
