/**
 * API pública, compatible con OpenAI.
 *
 * El cliente no elige modelo: manda lo que quiera en `model` (o nada) y el router
 * decide. Se acepta cualquier valor a propósito, para que funcionen sin tocarlos los
 * clientes que exigen un nombre concreto ("gpt-4o", "claude-3", lo que sea).
 *
 * Se hablan las dos APIs de OpenAI —`/v1/chat/completions` y la más reciente
 * `/v1/responses`— porque los clientes están repartidos entre ambas. La segunda se
 * traduce a la primera antes de enrutar (ver `responses-api.ts`), así que el router, las
 * cuotas y el historial solo conocen un formato.
 */

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeTps, execute, type Attempt } from '../routing/execute.js';
import { explainNoCandidates, route } from '../routing/select.js';
import { estimateTokens, requestUsesTools } from '../routing/tokens.js';
import { getSetting } from '../db.js';
import { findApiKey, logRequest, touchApiKey, type ApiKeyRecord, type AttemptDetail } from '../store.js';
import {
  toChatRequest,
  toNamedSse,
  toResponsesEvents,
  toResponsesPayload,
  type ResponseEcho,
} from './responses-api.js';

/** Campos que no se reenvían al proveedor porque los decide el router. */
const STRIPPED_FIELDS = ['model', 'provider', 'route'];

/**
 * ¿Se guardan prompt y respuesta en el historial?
 *
 * Por defecto sí, porque poder abrir una petición y ver qué se pidió y qué contestó es
 * justamente lo que hace útil el historial. Se puede apagar desde el panel: son datos
 * sensibles y quedan en la base de datos local.
 */
function contentLoggingEnabled(): boolean {
  return getSetting('log_content') !== 'false';
}

/** Renderiza los mensajes de la petición como texto plano legible. */
function renderPrompt(body: Record<string, unknown>): string | null {
  if (!contentLoggingEnabled()) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lines: string[] = [];

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    const role = message.role ?? 'user';
    let text: string;
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => {
          const typed = part as { type?: string; text?: string };
          if (typed.type === 'text') return typed.text ?? '';
          return `[${typed.type ?? 'adjunto'}]`;
        })
        .join('');
    } else {
      text = '';
    }
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n\n');
}

function responseText(payload: Record<string, unknown>): string | null {
  if (!contentLoggingEnabled()) return null;
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? '';
}

/**
 * Cronología de la petición: los candidatos que fallaron, en orden, y al final el que
 * respondió. Es lo que convierte un TTFT alto en una explicación —dos proveedores
 * agotados antes del bueno— en vez de un número suelto.
 */
function timelineOf(
  attempts: Attempt[],
  winner?: { providerId: string; modelId: string; ms: number; ttftMs: number | null },
): AttemptDetail[] {
  const rows: AttemptDetail[] = attempts.map((attempt) => ({
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    ok: false,
    ms: attempt.ms,
    ttftMs: null,
    errorKind: attempt.errorKind,
    message: attempt.message,
  }));
  if (winner) rows.push({ ...winner, ok: true, errorKind: null, message: null });
  return rows;
}

/**
 * Cómo se le devuelve al cliente lo que produjo el proveedor. Es lo único que distingue
 * a las dos APIs una vez el router ha hecho su trabajo.
 */
interface Dialect {
  nonStream(payload: Record<string, unknown>, model: string): unknown;
  stream(events: AsyncGenerator<string>, model: string): { contentType: string; body: Readable };
}

const CHAT_COMPLETIONS: Dialect = {
  nonStream: (payload) => payload,
  stream: (events) => ({
    contentType: 'text/event-stream; charset=utf-8',
    body: Readable.from(toSse(events)),
  }),
};

function responsesDialect(echo: ResponseEcho): Dialect {
  return {
    nonStream: (payload, model) => toResponsesPayload(payload, model, echo),
    stream: (events, model) => ({
      contentType: 'text/event-stream; charset=utf-8',
      body: Readable.from(toNamedSse(toResponsesEvents(events, model, echo))),
    }),
  };
}

export function registerV1Routes(app: FastifyInstance): void {
  app.post('/v1/chat/completions', async (request, reply) => {
    const auth = authenticate(request, reply);
    if (!auth) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send(openAiError('El campo `messages` es obligatorio y no puede estar vacío.', 'invalid_request_error'));
    }

    return serve(reply, auth, body, CHAT_COMPLETIONS);
  });

  /**
   * La API nueva de OpenAI. Varios clientes la usan por defecto —n8n trae el interruptor
   * "Use Responses API" activado—, así que sin esto se estrellan nada más conectarse.
   */
  app.post('/v1/responses', async (request, reply) => {
    const auth = authenticate(request, reply);
    if (!auth) return;

    const translated = toChatRequest((request.body ?? {}) as Record<string, unknown>);
    if (!translated.ok) {
      return reply.code(400).send(openAiError(translated.message, 'invalid_request_error'));
    }

    return serve(reply, auth, translated.chat, responsesDialect(translated.echo));
  });

  /**
   * Un único pseudo-modelo. El cliente no tiene que elegir, pero muchas herramientas
   * llaman a este endpoint para poblar un desplegable y se rompen si viene vacío.
   */
  app.get('/v1/models', async (request, reply) => {
    const auth = authenticate(request, reply);
    if (!auth) return;
    return reply.send({
      object: 'list',
      data: [
        {
          id: 'auto',
          object: 'model',
          created: Math.floor(Date.parse(auth.createdAt) / 1000),
          owned_by: 'freerouter',
          description: `Enrutado automático · perfil ${auth.profile}${auth.capabilities.length > 0 ? ` · ${auth.capabilities.join(', ')}` : ''}`,
        },
      ],
    });
  });

  /**
   * Cualquier otra ruta bajo `/v1`. Un 404 a secas deja al cliente adivinando —o peor,
   * interpretándolo como "modelo no encontrado", que es lo que hace LangChain— así que
   * aquí se dice qué endpoint se pidió y qué hay disponible en su lugar.
   */
  app.all('/v1/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    return reply.code(404).send(openAiError(unsupportedEndpointMessage(path), 'unknown_endpoint'));
  });
}

/** Endpoints de OpenAI que existen pero que un router de chat no puede servir. */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  '/v1/completions': 'la API de texto antigua está retirada; usa /v1/chat/completions',
  '/v1/embeddings': 'FreeRouter enruta chat, no embeddings',
  '/v1/images/generations': 'ningún modelo gratuito de los proveedores soportados genera imágenes',
  '/v1/audio/speech': 'FreeRouter enruta chat, no síntesis de voz',
  '/v1/audio/transcriptions': 'FreeRouter enruta chat, no transcripción',
  '/v1/assistants': 'la API de Assistants necesita estado en el servidor, que FreeRouter no guarda',
};

function unsupportedEndpointMessage(path: string): string {
  const known = Object.entries(KNOWN_UNSUPPORTED).find(([prefix]) => path.startsWith(prefix));
  const reason = known ? ` (${known[1]})` : '';
  return (
    `FreeRouter no implementa ${path}${reason}. ` +
    'Los endpoints disponibles son POST /v1/chat/completions, POST /v1/responses y GET /v1/models.'
  );
}

/**
 * El camino común: elegir candidatos, ejecutar la cadena y registrar el resultado.
 * El `dialect` decide solo cómo se envuelve lo que sale.
 */
async function serve(
  reply: FastifyReply,
  auth: ApiKeyRecord,
  body: Record<string, unknown>,
  dialect: Dialect,
): Promise<unknown> {
  // Lo que tarda FreeRouter en decidir, frente a lo que se va esperando a los
  // proveedores. Es la única forma de responder a «¿por qué ha tardado tanto?» sin
  // suponer: si esto son décimas de milisegundo, el tiempo es de ellos.
  const routerStartedAt = performance.now();

  const estimate = estimateTokens(body);
  const routed = route({
    profile: auth.profile,
    capabilities: auth.capabilities,
    estimate,
    usesTools: requestUsesTools(body),
  });
  const decisionMs = performance.now() - routerStartedAt;

  if (routed.chain.length === 0) {
    logRequest({
      apiKeyId: auth.id,
      providerId: null,
      modelId: null,
      profile: auth.profile,
      ok: false,
      ttftMs: null,
      totalMs: null,
      tokensIn: null,
      tokensOut: null,
      errorKind: 'no_candidates',
      attempts: 0,
      tps: null,
      prompt: renderPrompt(body),
      response: null,
      timeline: [],
      routerMs: decisionMs,
    });
    return reply.code(503).send(openAiError(explainNoCandidates(routed), 'no_available_model'));
  }

  const upstreamBody = stripFields(body);
  const beforeUpstream = performance.now();
  const result = await execute({
    body: upstreamBody,
    estimate,
    chain: routed.chain,
    signal: clientAbortSignal(reply),
  });

  /**
   * Coste propio: lo que se tardó en decidir más lo que se gastó fuera de las llamadas
   * a proveedores. Restar los intentos deja solo lo nuestro, que es lo que se quiere
   * mantener a ras de suelo.
   */
  const routerOverhead = (): number => {
    const spentInProviders = result.ok
      ? result.attempts.reduce((total, attempt) => total + attempt.ms, 0) +
        (result.stream ? result.ttftMs ?? 0 : result.totalMs)
      : result.attempts.reduce((total, attempt) => total + attempt.ms, 0);
    return Math.max(0, decisionMs + (performance.now() - beforeUpstream - spentInProviders));
  };

  if (!result.ok) {
    const last = result.attempts[result.attempts.length - 1];
    logRequest({
      apiKeyId: auth.id,
      providerId: last?.providerId ?? null,
      modelId: last?.modelId ?? null,
      profile: auth.profile,
      ok: false,
      ttftMs: null,
      totalMs: null,
      tokensIn: null,
      tokensOut: null,
      errorKind: last?.errorKind ?? 'unknown',
      attempts: result.attempts.length,
      tps: null,
      prompt: renderPrompt(body),
      response: null,
      timeline: timelineOf(result.attempts),
      routerMs: routerOverhead(),
    });
    const detail = result.attempts.map((a) => `${a.providerId}/${a.modelId}: ${a.message}`).join(' | ');

    // Si TODOS los candidatos la rechazaron por malformada, lo más probable es que de
    // verdad lo esté: se devuelve 400 con su mensaje, que es lo que deja depurarla. Un
    // solo 400 entre varios errores distintos no basta para culpar a la petición —hay
    // proveedores que responden 400 a problemas suyos— y ahí manda el 502.
    const everyoneRejected =
      result.attempts.length > 0 && result.attempts.every((attempt) => attempt.errorKind === 'bad_request');
    if (everyoneRejected) {
      return reply
        .code(400)
        .header('x-freerouter-attempts', String(result.attempts.length))
        .send(
          openAiError(
            `Los ${result.attempts.length} proveedores probados rechazaron la petición. ${detail}`,
            'invalid_request_error',
          ),
        );
    }

    return reply
      .code(502)
      .header('x-freerouter-attempts', String(result.attempts.length))
      .send(openAiError(`Ningún proveedor pudo atender la petición. ${detail}`, 'upstream_error'));
  }

  const label = `${result.model.providerId}/${result.model.id}`;
  reply
    .header('x-freerouter-model', label)
    .header('x-freerouter-attempts', String(result.attempts.length + 1))
    .header('x-freerouter-router-ms', routerOverhead().toFixed(1));

  if (!result.stream) {
    logRequest({
      apiKeyId: auth.id,
      providerId: result.model.providerId,
      modelId: result.model.id,
      profile: auth.profile,
      ok: true,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      tokensIn: result.usage?.promptTokens ?? null,
      tokensOut: result.usage?.completionTokens ?? null,
      errorKind: null,
      attempts: result.attempts.length + 1,
      tps: computeTps(result.usage, result.ttftMs, result.totalMs),
      prompt: renderPrompt(body),
      response: responseText(result.payload),
      timeline: timelineOf(result.attempts, {
        providerId: result.model.providerId,
        modelId: result.model.id,
        ms: result.totalMs,
        ttftMs: result.ttftMs,
      }),
      routerMs: routerOverhead(),
    });
    return reply.send(dialect.nonStream(result.payload, label));
  }

  // El log del streaming se escribe al cerrarse, cuando ya se conoce el uso real.
  void result.done.then(({ usage, totalMs, text }) => {
    logRequest({
      apiKeyId: auth.id,
      providerId: result.model.providerId,
      modelId: result.model.id,
      profile: auth.profile,
      ok: true,
      ttftMs: result.ttftMs,
      totalMs,
      tokensIn: usage?.promptTokens ?? null,
      tokensOut: usage?.completionTokens ?? null,
      errorKind: null,
      attempts: result.attempts.length + 1,
      tps: computeTps(usage, result.ttftMs, totalMs),
      prompt: renderPrompt(body),
      response: contentLoggingEnabled() ? text : null,
      timeline: timelineOf(result.attempts, {
        providerId: result.model.providerId,
        modelId: result.model.id,
        ms: totalMs,
        ttftMs: result.ttftMs,
      }),
      routerMs: routerOverhead(),
    });
  });

  const rendered = dialect.stream(result.events, label);
  return reply
    .header('content-type', rendered.contentType)
    .header('cache-control', 'no-cache')
    .header('connection', 'keep-alive')
    .header('x-accel-buffering', 'no')
    .send(rendered.body);
}

function authenticate(request: FastifyRequest, reply: FastifyReply): ApiKeyRecord | null {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    void reply.code(401).send(openAiError('Falta la cabecera Authorization: Bearer <api key>.', 'invalid_api_key'));
    return null;
  }
  const record = findApiKey(token);
  if (!record) {
    void reply.code(401).send(openAiError('API key no válida o revocada.', 'invalid_api_key'));
    return null;
  }
  touchApiKey(record.id);
  return record;
}

/**
 * Señal que se dispara si el cliente corta la conexión antes de que terminemos.
 * Sin esto, un cliente que cancela dejaría la petición viva contra el proveedor
 * consumiendo cuota para nada.
 *
 * Hay que escuchar en la RESPUESTA, no en la petición: `request.raw` emite `close` en
 * cuanto se termina de leer el cuerpo, que en una petición normal ocurre antes de que
 * empecemos a trabajar. `reply.raw` solo se cierra al terminar la respuesta o al irse
 * el cliente, y `writableEnded` distingue entre las dos cosas.
 */
function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

function stripFields(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  for (const field of STRIPPED_FIELDS) delete copy[field];
  return copy;
}

async function* toSse(events: AsyncGenerator<string>): AsyncGenerator<string> {
  for await (const data of events) {
    yield `data: ${data}\n\n`;
  }
}

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: 'freerouter_error', code } };
}
