/* Supabase-client-free helpers — safe to import from surfaces that must not pull the DB key into the bundle (§4.11). */

export const INITIAL_DEMO =
  (import.meta.env.VITE_DEMO_MODE ?? 'true') !== 'false';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
export const FUNCTIONS_URL = (import.meta.env.VITE_CC_FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`).replace(/\/$/, '');
export const READ_TOKEN = import.meta.env.VITE_CC_READ_TOKEN ?? '';
export const ACCESS_REQUIRED = (import.meta.env.VITE_CC_ACCESS_REQUIRED ?? 'false') === 'true';

export function sum(o: unknown): number {
  if (!o || typeof o !== 'object') return 0;
  return Object.values(o as Record<string, unknown>)
    .reduce<number>((a, b) => a + (Number(b) || 0), 0);
}

export function ago(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

export const hoursOld = (s: string | null | undefined): number | null =>
  s ? (Date.now() - new Date(s).getTime()) / 3_600_000 : null;

export const SEV_RANK: Record<'critical' | 'needs' | 'watch', number> = { critical: 0, needs: 1, watch: 2 };
export const SEV_LABEL: Record<'critical' | 'needs' | 'watch', string> = { critical: 'CRITICAL', needs: 'NEEDS YOU', watch: 'WATCH' };

export const APP_COLOR: Record<string, string> = {
  QEP: '#7C6FF0', SCC: '#4F9CF0', COL: '#3DD68C', FND: '#F5A623',
};

export function colorFor(code: string): string {
  return APP_COLOR[code] ?? '#5A6275';
}

export const HEALTH: Record<'green' | 'yellow' | 'red' | 'unknown', { c: string; t: string }> = {
  green: { c: 'var(--green)', t: 'Healthy' },
  yellow: { c: 'var(--amber)', t: 'Attention' },
  red: { c: 'var(--red)', t: 'Failing' },
  unknown: { c: 'var(--grey)', t: 'Unknown' },
};
