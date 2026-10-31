/**
 * Thin Channex REST client. Every call goes through lib/http (hard timeout, size cap,
 * no redirects). Auth is the `user-api-key` header; bodies are JSON.
 * Docs: https://docs.channex.io (API reference, ARI, bookings, webhooks, rate limits).
 */
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { HttpCallError, requestJson } from '../../lib/http.js';

export const channexConfigured = () => Boolean(config.CHANNEX_API_KEY);

function requireKey(): string {
  if (!config.CHANNEX_API_KEY) throw new AppError('VALIDATION_ERROR', 'Channex is not set up on this server (CHANNEX_API_KEY is missing)');
  return config.CHANNEX_API_KEY;
}

export interface ChannexResponse<T = unknown> {
  data?: T;
  meta?: { message?: string; warnings?: unknown[]; page?: number; limit?: number; total?: number };
  errors?: { code?: string; title?: string; details?: unknown };
}

export async function channex<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<ChannexResponse<T>> {
  const url = new URL(path.replace(/^\//, ''), config.CHANNEX_BASE_URL.replace(/\/?$/, '/'));
  const res = await requestJson(url.toString(), {
    method,
    headers: { 'user-api-key': requireKey() },
    body,
    timeoutMs: opts.timeoutMs ?? 20_000,
    maxBytes: 5_000_000,
  });
  return (res.json ?? {}) as ChannexResponse<T>;
}

/** Human-readable reason for a failed Channex call (for the extranet health panel). */
export function describeChannexError(err: unknown): string {
  if (err instanceof HttpCallError) {
    if (err.status === 401) return 'Channex rejected the API key (401)';
    if (err.status === 429) return 'Channex rate limit hit (429); pausing this property';
    let detail = '';
    try {
      const j = JSON.parse(err.bodySnippet ?? '') as ChannexResponse;
      detail = j.errors?.title ? `: ${j.errors.title}` : '';
    } catch {
      /* body was not JSON */
    }
    return `${err.message}${detail}`.slice(0, 500);
  }
  return ((err as Error)?.message ?? 'unknown error').slice(0, 500);
}

/** Pagination helper for list endpoints (max limit 100). */
export async function channexListAll<T>(path: string, filter: Record<string, string>): Promise<Array<{ id: string; attributes: T }>> {
  const out: Array<{ id: string; attributes: T }> = [];
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams({ ...filter, 'pagination[page]': String(page), 'pagination[limit]': '100' });
    const res = await channex<Array<{ id: string; attributes: T }>>('GET', `${path}?${q}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
