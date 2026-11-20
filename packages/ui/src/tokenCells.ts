import type { T } from './i18n';

/**
 * The tooltips of an agent's token cells (Agent map detail). When the agent's CLI does not say whether its input
 * already includes the cache reads (observed.splitUnknown, parsers.ts), the total does not claim to leave them out,
 * and the input and cache-read cells say the numbers are shown as reported.
 */
export function tokenTips(t: T, splitUnknown: boolean): { total: string; input?: string; cached?: string } {
  if (!splitUnknown) return { total: t('輸入加輸出，不含快取讀取', 'Input plus output, without cache reads') };
  const asReported = t('這家 CLI 沒有說明輸入是否已包含快取讀取，數字照它回報的顯示', 'This CLI does not say whether its input already includes the cache reads; the numbers are shown as it reports them');
  return { total: t('輸入加輸出', 'Input plus output'), input: asReported, cached: asReported };
}
