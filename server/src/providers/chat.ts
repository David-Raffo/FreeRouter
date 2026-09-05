/**
 * Llamada HTTP compartida por todos los proveedores compatibles con OpenAI.
 *
 * Devuelve en cuanto llegan las cabeceras de respuesta, sin consumir el cuerpo. Eso es
 * deliberado: permite que el router decida el failover antes de emitir el primer token
 * al cliente, que es el único momento en el que todavía se puede cambiar de modelo.
 */

import type { ErrorKind, Provider, RateLimitSnapshot } from './types.js';

export type ChatCallResult =
  | {
      ok: true;
      response: Response;
      rateLimit: RateLimitSnapshot | null;
      /** `performance.now()` justo antes de emitir la petición. */
      startedAt: number;
      /** Milisegundos hasta recibir las cabeceras de respuesta. */
      headersMs: number;
    }
  | {
      ok: false;
      kind: ErrorKind;
      status: number | null;
      message: string;
      retryAfterMs: number | null;
      rateLimit: RateLimitSnapshot | null;
    };

export interface ChatCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function callChat(
  provider: Provider,
  apiKey: string,
  body: Record<string, unknown>,
  opts: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const prepared = provider.prepareBody ? provider.prepareBody(body) : body;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  const startedAt = performance.now();
  let response: Response;
  try {
    const baseUrl = provider.resolveBaseUrl ? provider.resolveBaseUrl(apiKey) : provider.baseUrl;
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...provider.authHeaders(apiKey),
        ...(provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(prepared),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // El aborto del cliente no es un fallo del proveedor: no debe penalizar su salud.
    if (opts.signal?.aborted) {
      return { ok: false, kind: 'network', status: null, message: 'Petición cancelada por el cliente', retryAfterMs: null, rateLimit: null };
    }
    const timedOut = timeoutController.signal.aborted;
    return {
      ok: false,
      kind: timedOut ? 'timeout' : 'network',
      status: null,
      message: timedOut ? `Timeout tras ${timeoutMs} ms` : errorMessage(err),
      retryAfterMs: null,
      rateLimit: null,
    };
  }

  const headersMs = performance.now() - startedAt;
  const rateLimit = provider.parseRateLimit(response.headers);

  if (response.ok) {
    // El timer sigue vivo a propósito: aborta también si el cuerpo se queda colgado.
    // El consumidor del stream debe llamar a `result.response.body` y terminar; el
    // temporizador se limpia solo al dispararse o al completarse el proceso.
    timer.unref?.();
    return { ok: true, response, rateLimit, startedAt, headersMs };
  }

  clearTimeout(timer);
  const raw = await response.text().catch(() => '');
  return {
    ok: false,
    kind: classify(response.status, raw),
    status: response.status,
    message: extractMessage(raw) ?? `HTTP ${response.status}`,
    retryAfterMs: parseRetryAfter(response.headers, rateLimit),
    rateLimit,
  };
}

function classify(status: number, raw: string): ErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'payment_required';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status >= 500) return 'server';
  if (status === 400 || status === 413 || status === 422) {
    const lower = raw.toLowerCase();
    if (
      lower.includes('context_length') ||
      lower.includes('context length') ||
      lower.includes('too many tokens') ||
      lower.includes('maximum context') ||
      lower.includes('reduce the length')
    ) {
      return 'context_length';
    }
    // Algunos proveedores devuelven 400 cuando el modelo se ha retirado del catálogo.
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('decommissioned') || lower.includes('does not exist'))) {
      return 'model_not_found';
    }
    return 'bad_request';
  }
  return 'server';
}

function extractMessage(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // cuerpo no-JSON
  }
  return raw.slice(0, 300);
}

function parseRetryAfter(headers: Headers, rateLimit: RateLimitSnapshot | null): number | null {
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Groq no siempre manda retry-after, pero sí el reset del cubo agotado.
  const resets = [rateLimit?.resetRequestsMs, rateLimit?.resetTokensMs].filter(
    (v): v is number => typeof v === 'number' && v > 0,
  );
  return resets.length > 0 ? Math.min(...resets) : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/**
 * Recorre un cuerpo SSE devolviendo los eventos `data:` en crudo, ya separados.
 * Se usa tanto para retransmitir al cliente como para medir el TTFT real.
 */
export async function* iterateSSE(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    // Los eventos SSE se separan por línea en blanco; aceptamos \n\n y \r\n\r\n.
    while ((sep = findEventEnd(buffer)) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trimStart();
}

function findEventEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** ¿Este evento SSE contiene ya texto generado (no solo el rol o metadatos)? */
export function sseHasContent(data: string): boolean {
  if (data === '[DONE]') return false;
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string; tool_calls?: unknown[]; reasoning?: string } }>;
    };
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return false;
    return Boolean(
      (delta.content && delta.content.length > 0) ||
        (delta.tool_calls && delta.tool_calls.length > 0) ||
        (delta.reasoning && delta.reasoning.length > 0),
    );
  } catch {
    return false;
  }
}
