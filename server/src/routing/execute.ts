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
  markStreamingUnsupported,
  setModelEnabled,
  shrinkContextLength,
  type StoredModel,
} from '../store.js';
import { recordFailure, recordSuccess } from './health.js';
import { applySnapshot, penalize, reserve, settle } from './quota.js';
import type { ScoredCandidate } from './score.js';
import { estimateCompletionTokens, type TokenEstimate } from './tokens.js';

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
  /**
   * Pedir streaming al proveedor aunque el cliente no lo haya pedido.
   *
   * El cliente recibe exactamente la misma respuesta de siempre —se reconstruye entera
   * antes de contestarle—, pero por el camino se puede cronometrar el primer token. Sin
   * esto, todo el tráfico que no venga en streaming (n8n, por ejemplo) deja al router
   * sin una de sus dos métricas de velocidad.
   */
  measureTtft?: boolean;
}

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const { body, estimate, chain, signal } = options;
  const attempts: Attempt[] = [];
  const wantsStream = body.stream === true;
  const measureTtft = options.measureTtft === true;

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

    // Se pide troceado si el cliente lo quiere, o si hay que medir el TTFT y este modelo
    // no nos ha dicho ya que no sabe. La respuesta se rearma antes de contestar, así que
    // el cliente no nota nada.
    let streamUpstream = wantsStream || (measureTtft && !model.streamingUnsupported);

    let result = await callChat(provider, secret, { ...body, model: model.id, stream: streamUpstream }, { signal });
    applySnapshot(model.providerId, model.id, result.rateLimit);

    // El streaming lo hemos añadido nosotros, así que su rechazo no puede costarle nada
    // al modelo: se reintenta de una pieza y se apunta para no volver a pedírselo. Medir
    // el TTFT es un extra y nunca debe convertir una petición buena en un fallo.
    if (!result.ok && streamUpstream && !wantsStream && rejectedStreaming(result.kind)) {
      markStreamingUnsupported(model.providerId, model.id);
      streamUpstream = false;
      result = await callChat(provider, secret, { ...body, model: model.id, stream: false }, { signal });
      applySnapshot(model.providerId, model.id, result.rateLimit);
    }

    if (!result.ok) {
      handleFailure(model, result.kind, result.message, result.retryAfterMs, estimate);
      attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: result.kind, message: result.message, ms: since() });
      if (!shouldTryNextCandidate(result.kind)) return { ok: false, attempts };
      continue;
    }

    // Un proveedor puede ignorar `stream: true` y contestar de una pieza igualmente. Si
    // no lo pedía el cliente, no es un problema: se lee como JSON y lo único que se
    // pierde es el TTFT, que sin trocear no existe. Tratarlo como stream roto sería
    // descartar una respuesta perfectamente válida.
    const servedAsStream = (result.response.headers.get('content-type') ?? '').includes('event-stream');
    const readAsJson = !wantsStream && (!streamUpstream || !servedAsStream);

    if (readAsJson) {
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
      // Devolvió 200 y un stream que no sirve. Si el troceado era idea nuestra, se
      // reintenta de una pieza en vez de castigar al modelo por algo que no pedía.
      if (!wantsStream) {
        markStreamingUnsupported(model.providerId, model.id);
        const plain = await callChat(provider, secret, { ...body, model: model.id, stream: false }, { signal });
        applySnapshot(model.providerId, model.id, plain.rateLimit);
        if (plain.ok) {
          const finished = await readJson(plain.response);
          if (finished.ok) {
            const totalMs = performance.now() - plain.startedAt;
            const usage = readUsage(finished.payload);
            finalizeAccounting(model, estimate, usage, null, totalMs);
            return { ok: true, stream: false, model, payload: finished.payload, ttftMs: null, totalMs, usage, attempts };
          }
        }
      }
      handleFailure(model, opened.kind, opened.message, null, estimate);
      attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: opened.kind, message: opened.message, ms: since() });
      if (!shouldTryNextCandidate(opened.kind)) return { ok: false, attempts };
      continue;
    }

    // El cliente no quería streaming: se consume entero y se rearma la respuesta normal.
    // Lo que se gana es el TTFT, que en una respuesta de una pieza no existe.
    if (!wantsStream) {
      const collected = await collectCompletion(opened, model.id);
      if (!collected.ok) {
        handleFailure(model, 'server', collected.message, null, estimate);
        attempts.push({ providerId: model.providerId, modelId: model.id, errorKind: 'server', message: collected.message, ms: since() });
        continue;
      }
      const totalMs = performance.now() - result.startedAt;
      finalizeAccounting(model, estimate, collected.usage, opened.ttftMs, totalMs);
      return {
        ok: true,
        stream: false,
        model,
        payload: collected.payload,
        ttftMs: opened.ttftMs,
        totalMs,
        usage: collected.usage,
        attempts,
      };
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

/**
 * ¿Este error puede ser un «no sé servir esto troceado»?
 *
 * Solo un 400, que es como se rechaza un parámetro que no se admite. Un 5xx tienta,
 * pero no dice nada sobre el streaming: reintentarlo sin trocear duplicaría las llamadas
 * a un proveedor que ya está fallando, y gastaría cuota para nada. Un 429 o un 401,
 * igual. El otro caso legítimo —200 con un stream inservible— se trata aparte.
 */
function rejectedStreaming(kind: ErrorKind): boolean {
  return kind === 'bad_request';
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

/**
 * Consume un stream entero y rearma la respuesta de una pieza que espera el cliente.
 *
 * Se usa cuando el cliente NO pidió streaming pero queremos el TTFT: se pide troceado al
 * proveedor, se cronometra el primer token y aquí se vuelve a juntar todo. El cliente
 * recibe un `chat.completion` indistinguible del que habría recibido de todos modos.
 */
async function collectCompletion(
  opened: OpenedStream,
  modelId: string,
): Promise<{ ok: true; payload: Record<string, unknown>; usage: Usage | null } | { ok: false; message: string }> {
  const parts: string[] = [];
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Usage | null = null;
  let finishReason = 'stop';
  let id = `chatcmpl-${Date.now()}`;
  let servedModel = modelId;

  const absorb = (data: string): void => {
    if (data === '[DONE]') return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof chunk.id === 'string' && chunk.id.length > 0) id = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model.length > 0) servedModel = chunk.model;
    usage = readUsage(chunk) ?? usage;

    const choice = ((chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finishReason = choice.finish_reason;
    }

    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string') parts.push(delta.content);

    for (const raw of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      const index = Number(raw.index ?? 0);
      const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      const fn = (raw.function ?? {}) as Record<string, unknown>;
      if (typeof raw.id === 'string' && raw.id.length > 0) existing.id = raw.id;
      if (typeof fn.name === 'string' && fn.name.length > 0) existing.name = fn.name;
      if (typeof fn.arguments === 'string') existing.arguments += fn.arguments;
      toolCalls.set(index, existing);
    }
  };

  try {
    for (const data of opened.buffered) absorb(data);
    for await (const data of opened.iterator) absorb(data);
  } catch (err) {
    return { ok: false, message: `El stream se cortó a medias: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = parts.join('');
  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({
      id: call.id.length > 0 ? call.id : `call_${Math.random().toString(36).slice(2)}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));

  if (text.length === 0 && calls.length === 0) {
    return { ok: false, message: 'El stream terminó sin contenido utilizable' };
  }

  // Sin `usage` no habría tok/s ni descuento de cuota, así que se estima por longitud.
  // Es lo mismo que hace la calibración con los proveedores que no lo mandan.
  const resolved: Usage | null =
    usage ?? { promptTokens: 0, completionTokens: estimateCompletionTokens(text) };

  const message: Record<string, unknown> = { role: 'assistant', content: text };
  if (calls.length > 0) message.tool_calls = calls;

  return {
    ok: true,
    payload: {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: servedModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: resolved.promptTokens, completion_tokens: resolved.completionTokens },
    },
    usage: resolved,
  };
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
