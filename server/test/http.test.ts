/**
 * Pruebas sobre un servidor HTTP real.
 *
 * Existen porque `app.inject()` no reproduce el ciclo de vida de una conexión de
 * verdad. Un bug que abortaba TODAS las peticiones —escuchar el evento `close` de la
 * petición, que Node emite al acabar de leer el cuerpo y no cuando el cliente se va—
 * pasó limpiamente por los tests de `inject` y solo apareció con curl.
 *
 * Regla que queda fijada aquí: al menos un camino completo, incluido el streaming, se
 * prueba sobre un socket real.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { closeDb, useInMemoryDb } from '../src/db.js';
import { resetQuotaState } from '../src/routing/quota.js';
import { createApiKey, replaceModels, saveProviderKey, type Profile } from '../src/store.js';
import type { ModelInfo, ProviderId } from '../src/providers/types.js';
import { buildServer } from '../src/index.js';

const realFetch = globalThis.fetch;

function stubProviderFetch(handler: (body: Record<string, unknown>) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Solo se interceptan las llamadas salientes al proveedor; las del test al propio
    // servidor tienen que salir por la red de verdad.
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return realFetch(input as RequestInfo, init);
    }
    // El doble tiene que respetar el AbortSignal igual que `fetch`. Si no, un aborto
    // indebido pasa desapercibido en los tests y solo aparece con tráfico real.
    if (init?.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'modelo-test', context_window: 128000 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return handler(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
  }) as typeof fetch;
}

function completion(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-real',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hola' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function sseCompletion(body: Record<string, unknown>): Response {
  const events = [
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'hola' } }] }),
    JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: ' mundo' } }] }),
    '[DONE]',
  ];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function model(providerId: ProviderId, id: string): ModelInfo {
  return {
    providerId,
    id,
    displayName: id,
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    qualityScore: 40,
    qualitySource: 'measured',
  };
}

let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

beforeEach(async () => {
  useInMemoryDb();
  resetQuotaState();
  saveProviderKey('groq', 'fake', { rpm: 100, tpm: null, rpd: null, tpd: null });
  replaceModels('groq', [model('groq', 'modelo-test')]);

  apiKey = `fr_http_${Math.random().toString(36).slice(2)}`;
  createApiKey('http', 'balanceado' as Profile, [], apiKey);

  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

after(() => closeDb());

describe('acciones del panel sin cuerpo', () => {
  /**
   * Los botones del panel llaman a acciones que no llevan parámetros. Si el cliente
   * declara `content-type: application/json` sin mandar cuerpo, Fastify responde 400 por
   * defecto y el botón falla sin motivo aparente. Pasó de verdad con «Quitar»,
   * «Refrescar», «Calibrar» y «Purgar», y no se detectó porque curl no manda esa
   * cabecera si no se le pide.
   */
  const acciones: Array<[string, string]> = [
    ['DELETE', '/api/providers/groq'],
    ['POST', '/api/providers/groq/refresh'],
    ['POST', '/api/warmup'],
    ['DELETE', '/api/activity'],
  ];

  for (const [method, path] of acciones) {
    it(`${method} ${path} funciona con content-type json y sin cuerpo`, async () => {
      // El proveedor se sustituye para que el refresco no salga a la red de verdad.
      stubProviderFetch(() => new Response('{}', { status: 200 }));

      const response = await realFetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
      });
      const body = await response.text();

      // Lo que se comprueba es que el cuerpo vacío no se tome por un error de formato.
      // Un 400 por otra causa (una clave que el proveedor rechaza, por ejemplo) es
      // legítimo y no debe hacer fallar este test.
      assert.doesNotMatch(body, /FST_ERR_CTP_EMPTY_JSON_BODY/, `${method} ${path} rechazó el cuerpo vacío`);
      assert.doesNotMatch(body, /Body cannot be empty/, `${method} ${path} rechazó el cuerpo vacío`);
    });
  }
});

describe('servidor HTTP real', () => {
  it('completa una petición no-streaming sin abortarla a mitad', async () => {
    stubProviderFetch(completion);

    const response = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hola' }] }),
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-freerouter-model'), 'groq/modelo-test');
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(payload.choices[0]?.message.content, 'hola');
  });

  it('entrega el streaming completo sobre un socket real', async () => {
    stubProviderFetch(sseCompletion);

    const response = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hola' }], stream: true }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /hola/);
    assert.match(text, /mundo/);
    assert.match(text, /\[DONE\]/);
  });
});
