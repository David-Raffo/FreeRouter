/**
 * Ejecución de una petición: recorre la cadena de candidatos hasta que uno responde.
 *
 * La regla que gobierna el failover en streaming: **solo se puede cambiar de modelo
 * mientras no se haya emitido ni un token al cliente**. Por eso, antes de empezar a
 * retransmitir, se consume el principio del stream y se comprueba que trae contenido
 * de verdad; si el proveedor devolvió 200 pero el stream arranca con un error, todavía
 * estamos a tiempo de irnos a otro candidato sin que el cliente se entere.
 */

import { callChat, iterateSSE, sseHasContent } from '../providers/chat.js';
import { getProvider } from '../providers/registry.js';
import type { ErrorKind, Provider, ProviderId } from '../providers/types.js';
import { shouldTryNextCandidate } from '../providers/types.js';
import {
  getProviderKeySecret,
  listModels,
  markProviderKeyInvalid,
  setModelEnabled,
  shrinkContextLength,
  type StoredModel,
} from '../store.js';
import { recordFailure, recordSuccess } from './health.js';
import { applySnapshot, penalize, reserve, settle } from './quota.js';
import type { ScoredCandidate } from './score.js';
import type { TokenEstimate } from './tokens.js';

export interface Attempt {
  providerId: ProviderId;
  modelId: string;
  errorKind: ErrorKind;
  message: string;
  /**
   * Cuánto se tardó en descubrir que este candidato no servía. Es la mitad invisible del
   * TTFT: si una petición tardó 4 s en dar el primer token, saber que 3,5 s se fueron en
   * un proveedor que acabó devolviendo 429 explica el número; el TTFT solo, no.
   */
  ms: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type ExecuteResult =
  | {
      ok: true;
      stream: false;
      model: StoredModel;
      payload: Record<string, unknown>;
      /**
       * `null` siempre en no-streaming: sin trocear la respuesta no hay forma de saber
       * cuándo llegó el primer token. Antes se ponía aquí el tiempo total, que es otra
       * cosa —una respuesta larga daba «TTFT» de segundos— y además envenenaba la media
       * de TTFT con la que el router decide.
       */
      ttftMs: number | null;
      totalMs: number;
      usage: Usage | null;
      attempts: Attempt[];
    }
  | {
      ok: true;
      stream: true;
      model: StoredModel;
      /** Eventos SSE ya listos para reenviar, incluidos los que se consumieron al comprobar. */
      events: AsyncGenerator<string>;
      ttftMs: number;
      attempts: Attempt[];
      /** Se resuelve al terminar el stream, con el uso real y el texto generado. */
      done: Promise<{ usage: Usage | null; totalMs: number; text: string }>;
    }
  | { ok: false; attempts: Attempt[] };

export interface ExecuteOptions {
  body: Record<string, unknown>;
  estimate: TokenEstimate;
  chain: ScoredCandidate[];
  signal?: AbortSignal;
}

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const { body, estimate, chain, signal } = options;
  const attempts: Attempt[] = [];
  const wantsStream = body.stream === true;

  for (const candidate of chain) {
    const model = candidate.model;
    const provider = getProvider(model.providerId);
    if (!provider) continue;

    // El reloj arranca por candidato, no por petición: lo que se quiere medir es el
    // coste de cada intento por separado.
    const attemptStartedAt = performance.now();
    const since = () => performance.now() - attemptStartedAt;

    const secret = getProviderKeySecret(model.providerId);
    if (secret === null) {
      attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: 'auth', message: 'Sin clave activa', ms: since() });
      continue;
    }

    // La cuota se consume antes de llamar: si la petición falla, el proveedor la ha
    // contado igual (en OpenRouter literalmente), y así dos peticiones simultáneas no
    // se cuelan por el mismo hueco.
    reserve(model.providerId, model.id, estimate.total);

    const result = await callChat(provider, secret, { ...body, model: model.id }, { signal });
    applySnapshot(model.providerId, model.id, result.rateLimit);

    if (!result.ok) {
      handleFailure(model, result.kind, result.message, result.retryAfterMs, estimate);
      attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: result.kind, message: result.message, ms: since() });
      if (!shouldTryNextCandidate(result.kind)) return { ok: false, attempts };
      continue;
    }

    if (!wantsStream) {
      const finished = await readJson(result.response);
      if (!finished.ok) {
        handleFailure(model, 'server', finished.message, null, estimate);
        attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: 'server', message: finished.message, ms: since() });
        continue;
      }
      const totalMs = performance.now() - result.startedAt;
      const usage = readUsage(finished.payload);
      finalizeAccounting(model, estimate, usage, null, totalMs);
      return { ok: true, stream: false, model, payload: finished.payload, ttftMs: null, totalMs, usage, attempts };
    }

    const opened = await openStream(result.response, result.startedAt);
    if (!opened.ok) {
      handleFailure(model, opened.kind, opened.message, null, estimate);
      attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: opened.kind, message: opened.message, ms: since() });
      if (!shouldTryNextCandidate(opened.kind)) return { ok: false, attempts };
      continue;
    }

    // A partir de aquí ya no hay vuelta atrás: el cliente va a recibir tokens.
    let resolveDone: (value: { usage: Usage | null; totalMs: number; text: string }) => void;
    const done = new Promise<{ usage: Usage | null; totalMs: number; text: string }>((resolve) => {
      resolveDone = resolve;
    });

    const events = relay(opened, model, estimate, result.startedAt, opened.ttftMs, (value) => resolveDone(value));
    return { ok: true, stream: true, model, events, ttftMs: opened.ttftMs, attempts, done };
  }

  return { ok: false, attempts };
}

function handleFailure(
  model: StoredModel,
  kind: ErrorKind,
  message: string,
  retryAfterMs: number | null,
  estimate: TokenEstimate,
): void {
  recordFailure(model.providerId, model.id, kind, message);

  if (kind === 'rate_limit') {
    penalize(model.providerId, model.id, retryAfterMs);
  }
  // Un 401 o un 402 pueden ser del modelo o de la cuenta, así que se comprueba antes
  // de condenar la clave. Ver `verifyAccountFailure`.
  if (kind === 'auth' || kind === 'payment_required') {
    void verifyAccountFailure(model, message);
  }
  if (kind === 'model_not_found') {
    // El proveedor lo lista pero no lo sirve. NVIDIA anuncia 69 modelos y 48 responden
    // «Function … Not Found»: reintentarlos cada cuarto de hora no los va a resucitar,
    // solo gasta cuota y ensucia el panel. Vuelven si el proveedor los despliega y el
    // usuario los reactiva a mano.
    setModelEnabled(model.providerId, model.id, false);
  }
  if (kind === 'context_length') {
    // El proveedor acaba de decirnos que su ventana es más pequeña de lo que creíamos.
    // Cerebras no publica este dato, así que esta es la única forma de aprenderlo.
    shrinkContextLength(model.providerId, model.id, Math.max(2048, Math.floor(estimate.total * 0.9)));
  }
}

/**
 * Un 401/403 o un 402 pueden significar dos cosas muy distintas: que la cuenta entera
 * no sirve, o que ESE modelo concreto no está disponible para ella. Los dos casos
 * existen de verdad:
 *
 *  - OpenRouter tiene modelos reservados a «agentic harnesses» que devuelven 401 con
 *    una clave perfectamente válida.
 *  - LLM7 mezcla modelos abiertos con otros que exigen saldo y devuelven
 *    «Insufficient balance», mientras los gratuitos siguen funcionando.
 *  - Cerebras, en cambio, devuelve 402 en TODOS al agotarse el trial.
 *
 * Dar por muerta la clave en los dos primeros casos desactivaría de golpe modelos que
 * funcionan, así que primero se revalida y solo después se decide a quién culpar.
 */
export async function verifyAccountFailure(model: StoredModel, message: string): Promise<void> {
  const provider = getProvider(model.providerId);
  const secret = provider ? getProviderKeySecret(model.providerId) : null;
  if (!provider || secret === null) return;

  // Se comprueba GENERANDO con otro modelo del mismo proveedor, no listando su catálogo:
  // una cuenta sin saldo sigue devolviendo el listado tan ricamente, así que validarla
  // por ahí daría siempre por buena una cuenta muerta.
  const hermanos = listModels().filter(
    (candidate) => candidate.providerId === model.providerId && candidate.id !== model.id,
  );
  // Un modelo ABIERTO es el único juez fiable de la cuenta: contrastar con otro que
  // también exija saldo repite el mismo error y la condena sin motivo. Es justo lo que
  // pasaba con LLM7, donde dos modelos de pago sin saldo tumbaban los cuatro gratuitos.
  const abierto = hermanos.find((candidate) => !candidate.requiresIdentifiedAccount);

  if (!abierto && hermanos.length > 0) {
    // El proveedor no ofrece nada abierto con lo que contrastar. Se prueba igualmente con
    // otro modelo: si también falla, el problema es de la cuenta.
    const otro = hermanos[0]!;
    const segundo = await probeModel(provider, secret, otro.id);
    if (segundo === 'account') {
      markProviderKeyInvalid(model.providerId, message);
      return;
    }
    setModelEnabled(model.providerId, model.id, false);
    return;
  }

  if (!abierto) {
    // Un único modelo y ha fallado: no hay nada que refute el diagnóstico.
    markProviderKeyInvalid(model.providerId, message);
    return;
  }
  const alternativa = abierto;

  const veredicto = await probeModel(provider, secret, alternativa.id);
  if (veredicto === 'account') {
    // Falla igual con un modelo abierto: es la cuenta.
    markProviderKeyInvalid(model.providerId, message);
    return;
  }
  // La cuenta sirve (o el fallo fue puntual): se aparta solo el modelo problemático.
  setModelEnabled(model.providerId, model.id, false);
}

/** Genera un token con un modelo para ver si el problema es de la cuenta o solo suyo. */
async function probeModel(
  provider: Provider,
  secret: string,
  modelId: string,
): Promise<'ok' | 'account' | 'otro'> {
  const result = await callChat(
    provider,
    secret,
    { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
    { timeoutMs: 20_000 },
  ).catch(() => null);

  if (result?.ok) {
    await result.response.body?.cancel().catch(() => undefined);
    return 'ok';
  }
  if (result && (result.kind === 'auth' || result.kind === 'payment_required')) return 'account';
  // Un 429 o un fallo puntual no prueban nada sobre la cuenta.
  return 'otro';
}

/**
 * Rendimiento extremo a extremo: tokens generados entre el tiempo TOTAL de la petición.
 *
 * Dividir entre el intervalo de streaming (total − TTFT) parece más preciso pero no lo
 * es: los proveedores que van detrás de un proxy generan del lado servidor y sueltan la
 * respuesta en ráfaga, con lo que ese intervalo mide la descarga y no la generación —
 * medido en la práctica, inflaba las cifras de OpenRouter entre 3 y 4 veces. Sobre el
 * tiempo total da igual dónde bufferice cada uno, y además es lo que determina cuánto
 * espera de verdad quien hizo la petición.
 *
 * El umbral de tokens sigue existiendo porque una respuesta de tres tokens no da una
 * tasa estable, la mida como la mida.
 */
export function computeTps(usage: Usage | null, _ttftMs: number | null, totalMs: number): number | null {
  if (!usage || usage.completionTokens < MIN_TOKENS_FOR_RATE) return null;
  if (totalMs <= 0) return null;
  return (usage.completionTokens / totalMs) * 1000;
}

/**
 * Por debajo de esto la medida es puro ruido: unos pocos tokens no dan una tasa
 * estable, y basta un hipo de red para falsear el ritmo del modelo.
 */
const MIN_TOKENS_FOR_RATE = 16;

function finalizeAccounting(
  model: StoredModel,
  estimate: TokenEstimate,
  usage: Usage | null,
  ttftMs: number | null,
  totalMs: number,
): void {
  const actualTokens = usage ? usage.promptTokens + usage.completionTokens : estimate.total;
  settle(model.providerId, model.id, estimate.total, actualTokens);
  recordSuccess(model.providerId, model.id, ttftMs, computeTps(usage, ttftMs, totalMs));
}

async function readJson(response: Response): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; message: string }> {
  try {
    return { ok: true, payload: (await response.json()) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: `Respuesta no interpretable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface OpenedStream {
  ok: true;
  buffered: string[];
  iterator: AsyncGenerator<string>;
  ttftMs: number;
  exhausted: boolean;
}

/**
 * Consume el principio del stream hasta el primer evento con contenido real.
 * Devuelve los eventos consumidos para que se reenvíen intactos.
 */
async function openStream(
  response: Response,
  startedAt: number,
): Promise<OpenedStream | { ok: false; kind: ErrorKind; message: string }> {
  const iterator = iterateSSE(response);
  const buffered: string[] = [];

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        // Stream vacío: el proveedor aceptó y no generó nada. Reintentable.
        return { ok: false, kind: 'server', message: 'El proveedor cerró el stream sin generar contenido' };
      }
      const data = next.value;
      buffered.push(data);

      const embedded = embeddedError(data);
      if (embedded) return { ok: false, kind: embedded.kind, message: embedded.message };

      if (data === '[DONE]') {
        return { ok: false, kind: 'server', message: 'El stream terminó sin contenido' };
      }
      if (sseHasContent(data)) {
        return { ok: true, buffered, iterator, ttftMs: performance.now() - startedAt, exhausted: false };
      }
    }
  } catch (err) {
    return { ok: false, kind: 'network', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Algunos proveedores devuelven 200 y meten el error dentro del stream. */
function embeddedError(data: string): { kind: ErrorKind; message: string } | null {
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as { error?: { message?: string; code?: number | string } };
    if (!parsed.error) return null;
    const message = parsed.error.message ?? 'Error del proveedor dentro del stream';
    const code = Number(parsed.error.code);
    const kind: ErrorKind = code === 429 ? 'rate_limit' : code === 401 || code === 403 ? 'auth' : 'server';
    return { kind, message };
  } catch {
    return null;
  }
}

/** Reenvía los eventos ya consumidos y luego el resto, contabilizando el uso real. */
async function* relay(
  opened: OpenedStream,
  model: StoredModel,
  estimate: TokenEstimate,
  startedAt: number,
  ttftMs: number,
  onDone: (value: { usage: Usage | null; totalMs: number; text: string }) => void,
): AsyncGenerator<string> {
  let usage: Usage | null = null;
  // El texto se acumula al vuelo: una vez retransmitido el evento ya no se puede
  // recuperar, y el historial del panel lo necesita.
  const parts: string[] = [];

  try {
    for (const data of opened.buffered) {
      usage = readUsageFromEvent(data) ?? usage;
      parts.push(deltaText(data));
      yield data;
    }
    for await (const data of opened.iterator) {
      usage = readUsageFromEvent(data) ?? usage;
      parts.push(deltaText(data));
      yield data;
    }
  } finally {
    const totalMs = performance.now() - startedAt;
    finalizeAccounting(model, estimate, usage, ttftMs, totalMs);
    onDone({ usage, totalMs, text: parts.join('') });
  }
}

/** Texto de un evento SSE, para reconstruir la respuesta completa. */
function deltaText(data: string): string {
  if (data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    return parsed.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

function readUsageFromEvent(data: string): Usage | null {
  if (data === '[DONE]') return null;
  try {
    return readUsage(JSON.parse(data) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function readUsage(payload: Record<string, unknown>): Usage | null {
  const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined | null;
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens };
}
