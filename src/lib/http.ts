/**
 * Outbound HTTP with hard limits. Every external call in this service goes through
 * here so that no slow or hostile remote server can hang or crash us.
 */

export type HttpFailureKind = 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'BAD_RESPONSE';

export class HttpCallError extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
    readonly status?: number,
    readonly bodySnippet?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpCallError';
  }

  /** Timeouts, network errors, 5xx, 408 and 429 are worth retrying. Other 4xx are not. */
  get retryable(): boolean {
    if (this.kind === 'TIMEOUT' || this.kind === 'NETWORK') return true;
    if (this.kind === 'HTTP' && this.status !== undefined) {
      return this.status >= 500 || this.status === 408 || this.status === 429;
    }
    return false;
  }
}

export interface RequestJsonOptions {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Refuse responses bigger than this, so a broken upstream can't exhaust memory. */
  maxBytes?: number;
  /** Optional caller signal (e.g. the client disconnected). */
  signal?: AbortSignal;
}

export interface JsonResponse {
  status: number;
  json: unknown;
}

export async function requestJson(url: string, opts: RequestJsonOptions): Promise<JsonResponse> {
  const { method = 'POST', headers = {}, body, timeoutMs, maxBytes = 1_000_000, signal } = opts;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
      redirect: 'error', // a supplier redirecting us elsewhere is never expected
    });
  } catch (err) {
    if (timeoutSignal.aborted) throw new HttpCallError('TIMEOUT', `timed out after ${timeoutMs}ms`, undefined, undefined, { cause: err });
    throw new HttpCallError('NETWORK', `network error: ${(err as Error).message}`, undefined, undefined, { cause: err });
  }

  // Read the body with a size cap (and still under the same timeout).
  let text: string;
  try {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new HttpCallError('BAD_RESPONSE', `response too large (${declared} bytes)`, res.status);
    const buf = await readCapped(res, maxBytes);
    text = buf.toString('utf8');
  } catch (err) {
    if (err instanceof HttpCallError) throw err;
    if (timeoutSignal.aborted) throw new HttpCallError('TIMEOUT', `timed out reading body after ${timeoutMs}ms`, res.status, undefined, { cause: err });
    throw new HttpCallError('NETWORK', `failed reading body: ${(err as Error).message}`, res.status, undefined, { cause: err });
  }

  if (!res.ok) throw new HttpCallError('HTTP', `HTTP ${res.status}`, res.status, text.slice(0, 300));

  try {
    return { status: res.status, json: text.length ? JSON.parse(text) : null };
  } catch (err) {
    throw new HttpCallError('BAD_RESPONSE', 'response is not valid JSON', res.status, text.slice(0, 300), { cause: err });
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new HttpCallError('BAD_RESPONSE', `response exceeded ${maxBytes} bytes`, res.status);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Sleep that respects an abort signal. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
