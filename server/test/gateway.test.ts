/**
 * Pruebas de extremo a extremo del gateway, con `fetch` simulado.
 *
 * No tocan la red: cada proveedor se sustituye por un doble que registra las llamadas
 * recibidas. Eso permite comprobar lo que de verdad importa —que el router reparte sin
 * provocar 429 y que hace failover sin que el cliente se entere— sin gastar cuota real.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closeDb, setSetting, useInMemoryDb } from '../src/db.js';
import { resetQuotaState } from '../src/routing/quota.js';
import {
  createApiKey,
  listModels,
  recentRequests,
  requestDetail,
  listProviderKeys,
  replaceModels,
  saveProviderKey,
  type Capability,
  type Profile,
} from '../src/store.js';
import type { ModelInfo, ProviderId } from '../src/providers/types.js';
import { buildServer } from '../src/index.js';
import { measureModel, warmupAll } from '../src/routing/probe.js';
import { allHealth } from '../src/routing/health.js';
import { getProvider } from '../src/providers/registry.js';
import { refreshProviderModels } from '../src/providers/connect.js';

const realFetch = globalThis.fetch;

interface Call {
  providerId: ProviderId;
  model: string;
  at: number;
}

/** Respuesta que devolverá el doble para un proveedor concreto. */
type Responder = (body: Record<string, unknown>, signal?: AbortSignal | null) => Response;

const calls: Call[] = [];
let responders: Partial<Record<ProviderId, Responder>> = {};

function providerFromUrl(url: string): ProviderId | null {
  if (url.includes('api.groq.com')) return 'groq';
  if (url.includes('api.cerebras.ai')) return 'cerebras';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('api.llm7.io')) return 'llm7';
  return null;
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const providerId = providerFromUrl(url);
    if (!providerId) throw new Error(`Llamada inesperada a ${url}`);

    // `verifyAccountFailure` revalida la clave, así que el doble tiene que saber
    // responder también a los endpoints de catálogo y de cuenta. La revalidación usa el
    // responder del proveedor, de modo que una cuenta rota (Cerebras sin saldo) también
    // falla aquí y otra sana (LLM7 con modelos abiertos) sigue validando.
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'x', object: 'model', pricing: { prompt: '0', completion: '0' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/key')) {
      return new Response(JSON.stringify({ data: { is_free_tier: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!url.includes('/chat/completions')) throw new Error(`Llamada inesperada a ${url}`);
    // El doble tiene que respetar el AbortSignal igual que `fetch`. Si no, un aborto
    // indebido pasa desapercibido en los tests y solo aparece con tráfico real.
    if (init?.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ providerId, model: String(body.model), at: Date.now() });
    const responder = responders[providerId] ?? jsonOk;
    // La señal se le pasa al doble igual que `fetch` se la aplica al cuerpo de la
    // respuesta: un stream que ignora el aborto no se parece a la realidad y deja pasar
    // fallos que solo aparecen con tráfico de verdad.
    return responder(body, init?.signal ?? null);
  }) as typeof fetch;
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hola' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function status(code: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}

function rateLimited(): Response {
  return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '30' },
  });
}

function sse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunk(content: string, model: string): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { content } }],
  });
}

function model(
  providerId: ProviderId,
  id: string,
  quality: number,
  requiresIdentifiedAccount = false,
): ModelInfo {
  return {
    providerId,
    id,
    displayName: id,
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    qualityScore: quality,
    qualitySource: 'measured',
    requiresIdentifiedAccount,
  };
}

function seedProvider(providerId: ProviderId, modelId: string, quality: number, rpm: number): void {
  saveProviderKey(providerId, `${providerId}-fake-key`, { rpm, tpm: null, rpd: null, tpd: null });
  replaceModels(providerId, [model(providerId, modelId, quality)]);
}

function seedKey(profile: Profile, capabilities: Capability[] = []): string {
  const plaintext = `fr_test_${Math.random().toString(36).slice(2)}`;
  createApiKey('test', profile, capabilities, plaintext);
  return plaintext;
}

async function chat(app: FastifyInstance, key: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'hola' }], ...payload },
  });
}

/** Espera a que algo se cumpla, hasta un tope. Devuelve si llegó a cumplirse. */
async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

let app: FastifyInstance;

beforeEach(async () => {
  useInMemoryDb();
  resetQuotaState();
  calls.length = 0;
  responders = {};
  installFetchStub();
  app = await buildServer();
});

afterEach(async () => {
  await app.close();
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

describe('gateway', () => {
  it('rechaza una petición sin API key', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    assert.equal(response.statusCode, 401);
  });

  it('enruta y dice qué modelo eligió sin que el cliente lo pidiera', async () => {
    seedProvider('groq', 'llama-rapido', 50, 30);
    const key = seedKey('balanceado');

    const response = await chat(app, key, { model: 'gpt-4o' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'groq/llama-rapido');
    // El `model` que mandó el cliente se ignora: se sustituye por el elegido.
    assert.equal(calls[0]?.model, 'llama-rapido');
    assert.equal(JSON.parse(response.body).choices[0].message.content, 'hola');
  });

  it('devuelve 503 explicando el motivo cuando ninguna capacidad encaja', async () => {
    seedProvider('groq', 'solo-texto', 50, 30);
    const key = seedKey('balanceado', ['image_output']);

    const response = await chat(app, key);

    assert.equal(response.statusCode, 503);
    const message = JSON.parse(response.body).error.message as string;
    assert.match(message, /image_output/);
    assert.equal(calls.length, 0, 'no debe llamar a ningún proveedor si nada encaja');
  });

  it('hace failover a otro proveedor cuando el primero devuelve 429', async () => {
    seedProvider('groq', 'groq-modelo', 90, 30);
    seedProvider('cerebras', 'cerebras-modelo', 50, 30);
    responders.groq = rateLimited;

    const key = seedKey('calidad');
    const response = await chat(app, key);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'cerebras/cerebras-modelo');
    assert.deepEqual(
      calls.map((call) => call.providerId),
      ['groq', 'cerebras'],
    );
  });

  it('el historial guarda a quién se intentó y cuánto tardó cada intento', async () => {
    // El TTFT por sí solo no explica una petición lenta: si antes del modelo que
    // respondió hubo otro que tardó en devolver un 429, ese tiempo no aparece en
    // ninguna otra métrica y la petición parece lenta sin motivo.
    seedProvider('groq', 'groq-modelo', 90, 30);
    seedProvider('cerebras', 'cerebras-modelo', 50, 30);
    responders.groq = rateLimited;

    const response = await chat(app, seedKey('calidad'));
    assert.equal(response.statusCode, 200);

    const [row] = recentRequests(1);
    const detail = requestDetail(Number(row?.id));
    assert.ok(detail, 'la petición debe estar en el historial');

    assert.deepEqual(
      detail.timeline.map((attempt) => `${attempt.providerId}/${attempt.modelId}`),
      ['groq/groq-modelo', 'cerebras/cerebras-modelo'],
      'en el orden en que se intentaron',
    );

    const [fallido, bueno] = detail.timeline;
    assert.equal(fallido?.ok, false);
    assert.equal(fallido?.errorKind, 'rate_limit');
    assert.ok((fallido?.ms ?? -1) >= 0, 'un intento fallido también se cronometra');
    assert.equal(fallido?.ttftMs, null, 'el que no respondió no tiene TTFT');

    assert.equal(bueno?.ok, true);
    assert.equal(bueno?.errorKind, null);
    // Sin streaming no hay primer token que cronometrar, así que tampoco hay TTFT. Antes
    // se guardaba aquí el tiempo total, y una respuesta larga aparecía como un TTFT de
    // varios segundos que además contaminaba la media con la que decide el router.
    assert.equal(bueno?.ttftMs, null, 'una respuesta no troceada no tiene TTFT');
    assert.ok((bueno?.ms ?? -1) >= 0, 'el tiempo total sí se guarda');
  });

  it('mide el TTFT pidiendo streaming aunque el cliente no lo pida', async () => {
    // El cliente manda una petición normal y recibe una respuesta normal; por dentro se
    // pide troceada para poder cronometrar el primer token. Sin esto, un cliente que no
    // use streaming (n8n) no aporta ni un dato de TTFT.
    seedProvider('groq', 'groq-modelo', 90, 30);
    responders.groq = (body) => {
      assert.equal(body.stream, true, 'al proveedor se le pide troceado');
      return sse([chunk('ho', String(body.model)), chunk('la', String(body.model)), '[DONE]']);
    };

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.object, 'chat.completion', 'al cliente le llega una respuesta de una pieza');
    assert.equal(payload.choices[0].message.content, 'hola', 'rearmada entera');
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.ok(!response.headers['content-type']?.includes('event-stream'));

    const detail = requestDetail(Number(recentRequests(1)[0]?.id));
    const bueno = detail?.timeline.find((attempt) => attempt.ok);
    assert.ok((bueno?.ttftMs ?? -1) >= 0, 'y ahora sí hay TTFT');
  });

  it('con la medición apagada, la petición va de una pieza como antes', async () => {
    seedProvider('groq', 'groq-modelo', 90, 30);
    setSetting('measure_ttft', 'false');
    responders.groq = (body) => {
      assert.notEqual(body.stream, true, 'no se pide troceado si no hace falta');
      return jsonOk(body);
    };

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 200);
    const detail = requestDetail(Number(recentRequests(1)[0]?.id));
    assert.equal(detail?.timeline.find((a) => a.ok)?.ttftMs, null, 'sin medir, no hay TTFT que inventar');
  });

  it('un proveedor que rechaza el streaming no se lleva un fallo: se reintenta de una pieza', async () => {
    // Medir el TTFT es un extra nuestro. Si el proveedor no sabe servir troceado, eso no
    // puede convertir una petición que iba a salir bien en un error ni ensuciar la salud
    // del modelo.
    seedProvider('groq', 'groq-modelo', 90, 30);
    let vistas = 0;
    responders.groq = (body) => {
      vistas += 1;
      if (body.stream === true) return status(400, 'stream is not supported for this model');
      return jsonOk(body);
    };

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 200, 'la petición sale adelante igualmente');
    assert.equal(response.headers['x-freerouter-model'], 'groq/groq-modelo', 'y con el mismo modelo');
    assert.equal(vistas, 2, 'un rechazo y el reintento sin trocear');

    const detail = requestDetail(Number(recentRequests(1)[0]?.id));
    assert.equal(detail?.timeline.length, 1, 'el rechazo no cuenta como intento fallido');
    assert.equal(detail?.timeline[0]?.ok, true);
    assert.equal(allHealth().find((h) => h.modelId === 'groq-modelo')?.consecutiveFailures ?? 0, 0);
  });

  it('y no se le vuelve a pedir troceado nunca más', async () => {
    seedProvider('groq', 'groq-modelo', 90, 30);
    const pedidas: unknown[] = [];
    responders.groq = (body) => {
      pedidas.push(body.stream);
      if (body.stream === true) return status(400, 'stream is not supported');
      return jsonOk(body);
    };

    const key = seedKey('calidad');
    await chat(app, key);
    await chat(app, key);

    assert.deepEqual(pedidas, [true, false, false], 'se aprende del primer rechazo');
  });

  it('rearmando la respuesta no se pierden las llamadas a herramientas', async () => {
    // Los argumentos llegan troceados por índice: si el rearmado no los junta, el
    // cliente recibe una llamada con el JSON partido por la mitad.
    seedProvider('groq', 'groq-modelo', 90, 30);
    responders.groq = () =>
      sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'clima', arguments: '{"ciudad"' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Madrid"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 200);
    const call = response.json().choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'clima');
    assert.equal(call.function.arguments, '{"ciudad":"Madrid"}');
    assert.equal(response.json().choices[0].finish_reason, 'tool_calls');
  });

  it('si el proveedor calla su consumo, los tokens se estiman en vez de perderse', async () => {
    // Sin `usage` no habría tok/s ni descuento de cuota diaria.
    seedProvider('groq', 'groq-modelo', 90, 30);
    responders.groq = (body) => sse([chunk('palabra '.repeat(40), String(body.model)), '[DONE]']);

    await chat(app, seedKey('calidad'));

    const [row] = recentRequests(1);
    assert.ok(Number(row?.tokens_out) > 0, 'se estima por longitud');
    assert.ok(Number(row?.tps) > 0, 'y así sigue habiendo tok/s');
  });

  it('en streaming sí se guarda el TTFT, que ahí sí existe', async () => {
    seedProvider('groq', 'groq-modelo', 90, 30);
    responders.groq = (body) => sse([chunk('ho', String(body.model)), chunk('la', String(body.model)), '[DONE]']);

    const response = await chat(app, seedKey('calidad'), { stream: true });
    assert.equal(response.statusCode, 200);

    const detail = requestDetail(Number(recentRequests(1)[0]?.id));
    const bueno = detail?.timeline.find((attempt) => attempt.ok);
    assert.ok((bueno?.ttftMs ?? -1) >= 0, 'el primer token sí se puede cronometrar');
  });

  it('un 400 de un proveedor no se le devuelve al cliente: se prueba con otro', async () => {
    // OpenCode responde 400 con «Upstream request failed: Model is unavailable», que es
    // un problema suyo disfrazado de error de la petición. Cortar la cadena ahí dejaba
    // al cliente con un fallo que otro proveedor atendía sin problema.
    seedProvider('groq', 'groq-modelo', 90, 30);
    seedProvider('cerebras', 'cerebras-modelo', 50, 30);
    responders.groq = () => status(400, 'Upstream request failed: Model is unavailable.');

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 200, 'la petición se salva por el otro proveedor');
    assert.equal(response.headers['x-freerouter-model'], 'cerebras/cerebras-modelo');
  });

  it('si TODOS rechazan la petición por malformada, se devuelve 400 y no 502', async () => {
    // Cuando el 400 sí es de la petición, insistir no la arregla: lo honesto es
    // devolverlo como error del cliente, con el motivo, para poder depurarlo.
    seedProvider('groq', 'groq-modelo', 90, 30);
    seedProvider('cerebras', 'cerebras-modelo', 50, 30);
    responders.groq = () => status(400, 'temperature must be <= 2');
    responders.cerebras = () => status(400, 'temperature must be <= 2');

    const response = await chat(app, seedKey('calidad'));

    assert.equal(response.statusCode, 400);
    assert.match(String(response.json().error.message), /temperature/);
  });

  it('cuando fallan todos, la cronología los recoge igual', async () => {
    seedProvider('groq', 'groq-modelo', 90, 30);
    responders.groq = () => status(500, 'reventado');

    const response = await chat(app, seedKey('calidad'));
    assert.equal(response.statusCode, 502);

    const detail = requestDetail(Number(recentRequests(1)[0]?.id));
    assert.equal(detail?.timeline.length, 1);
    assert.equal(detail?.timeline[0]?.ok, false);
    assert.match(String(detail?.timeline[0]?.message), /reventado/);
  });

  it('reparte entre proveedores sin provocar un solo 429', async () => {
    // Tres proveedores a 4 peticiones/minuto: 12 huecos para 10 peticiones.
    // Si el router no respetara los cubos, alguno recibiría más de 4 y se comería un 429.
    const limit = 4;
    seedProvider('groq', 'g', 50, limit);
    seedProvider('cerebras', 'c', 50, limit);
    seedProvider('openrouter', 'o', 50, limit);

    // Cualquier llamada por encima del límite del proveedor se considera un fallo del test.
    for (const providerId of ['groq', 'cerebras', 'openrouter'] as ProviderId[]) {
      responders[providerId] = (body) => {
        const used = calls.filter((call) => call.providerId === providerId).length;
        return used > limit ? rateLimited() : jsonOk(body);
      };
    }

    const key = seedKey('balanceado');
    const responses = await Promise.all(Array.from({ length: 10 }, () => chat(app, key)));

    assert.ok(
      responses.every((response) => response.statusCode === 200),
      'todas las peticiones deben resolverse',
    );
    for (const providerId of ['groq', 'cerebras', 'openrouter'] as ProviderId[]) {
      const used = calls.filter((call) => call.providerId === providerId).length;
      assert.ok(used <= limit, `${providerId} recibió ${used} llamadas, por encima de su límite de ${limit}`);
    }
    assert.equal(calls.length, 10, 'no debería hacer falta ningún reintento');
  });

  it('retransmite el streaming entero, incluidos los primeros eventos que consume para comprobar', async () => {
    seedProvider('groq', 'g', 50, 30);
    responders.groq = (body) =>
      sse([
        JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
        chunk('Hola', String(body.model)),
        chunk(' mundo', String(body.model)),
        '[DONE]',
      ]);

    const key = seedKey('rapido');
    const response = await chat(app, key, { stream: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/event-stream/);
    // El evento del rol se consumió al comprobar el stream, pero debe llegar igualmente.
    assert.match(response.body, /"role":"assistant"/);
    assert.match(response.body, /Hola/);
    assert.match(response.body, /mundo/);
    assert.match(response.body, /\[DONE\]/);
  });

  it('cambia de modelo si el stream arranca con un error, sin que el cliente lo note', async () => {
    seedProvider('groq', 'g', 90, 30);
    seedProvider('cerebras', 'c', 50, 30);
    // Groq responde 200 pero mete el error dentro del stream: todavía no se ha emitido
    // nada al cliente, así que el failover sigue siendo posible.
    responders.groq = () => sse([JSON.stringify({ error: { message: 'upstream caído', code: 500 } })]);
    responders.cerebras = (body) => sse([chunk('desde cerebras', String(body.model)), '[DONE]']);

    const key = seedKey('calidad');
    const response = await chat(app, key, { stream: true });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'cerebras/c');
    assert.match(response.body, /desde cerebras/);
    assert.doesNotMatch(response.body, /upstream caído/);
  });

  it('un 402 de un solo modelo no tumba a los demás del proveedor', async () => {
    // LLM7 mezcla modelos abiertos con otros que exigen saldo: estos responden
    // «Insufficient balance» mientras los gratuitos siguen funcionando. Dar la cuenta
    // por muerta dejaría fuera modelos que van perfectamente.
    saveProviderKey('llm7', 'token-valido', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('llm7', [model('llm7', 'con-saldo', 90, true), model('llm7', 'abierto', 50)]);
    responders.llm7 = (body) =>
      body.model === 'con-saldo' ? status(402, 'Insufficient balance.') : jsonOk(body);

    const key = seedKey('calidad');
    const response = await chat(app, key);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'llm7/abierto');

    // La revalidación de la clave es asíncrona.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const providerKey = listProviderKeys().find((entry) => entry.providerId === 'llm7');
    assert.equal(providerKey?.status, 'active', 'la cuenta sigue siendo utilizable');
    const models = listModels(false);
    assert.equal(models.find((m) => m.id === 'con-saldo')?.enabled, false, 'solo se aparta el que exige saldo');
    assert.equal(models.find((m) => m.id === 'abierto')?.enabled, true);
  });

  it('con varios modelos de pago sin saldo, los gratuitos siguen en pie', async () => {
    // El caso que rompió de verdad: LLM7 con una cuenta sin saldo. Al fallar un modelo
    // de pago se contrastaba con OTRO de pago, que fallaba igual, y se daba la cuenta
    // por muerta llevándose por delante los modelos abiertos que funcionaban.
    saveProviderKey('llm7', 'token-sin-saldo', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('llm7', [
      model('llm7', 'pago-a', 95, true),
      model('llm7', 'pago-b', 90, true),
      model('llm7', 'abierto', 40),
    ]);
    responders.llm7 = (body) =>
      String(body.model).startsWith('pago') ? status(402, 'Insufficient balance.') : jsonOk(body);

    const key = seedKey('calidad');
    const response = await chat(app, key);

    assert.equal(response.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const providerKey = listProviderKeys().find((entry) => entry.providerId === 'llm7');
    assert.equal(providerKey?.status, 'active', 'la cuenta no debe darse por muerta');
    assert.equal(listModels(false).find((m) => m.id === 'abierto')?.enabled, true, 'el gratuito sigue vivo');
  });

  it('un 402 en TODOS los modelos sí marca la cuenta como no utilizable', async () => {
    // Cerebras devuelve 402 cuando se agota el trial. Reintentar no lo arregla:
    // el problema es de la cuenta, no del modelo ni del momento.
    // Cerebras al agotarse el trial responde 402 en todo, incluida la revalidación.
    seedProvider('cerebras', 'c', 50, 30);
    seedProvider('groq', 'g', 40, 30);
    responders.cerebras = () => status(402, 'Payment required to access this resource.');

    const key = seedKey('calidad');
    const response = await chat(app, key);

    assert.equal(response.statusCode, 200, 'debe seguir por el proveedor sano');
    assert.equal(response.headers['x-freerouter-model'], 'groq/g');

    // La revalidación va en segundo plano: se espera a que ocurra, no a que pase un
    // tiempo. Un plazo fijo de 50 ms bastaba casi siempre y fallaba con la máquina
    // cargada, que es la peor clase de prueba: la que falla sin que nada esté roto.
    const invalidada = await waitUntil(
      () => listProviderKeys().find((entry) => entry.providerId === 'cerebras')?.status === 'invalid',
    );
    assert.ok(invalidada, 'la cuenta debe acabar marcada como no utilizable');
  });

  it('un modelo vetado con 401 no tumba al resto del proveedor', async () => {
    // OpenRouter sirve modelos restringidos a ciertos clientes: responden 401 aunque
    // la clave sea perfectamente válida. Dar la clave por muerta dejaría fuera a todos
    // los demás modelos del proveedor.
    saveProviderKey('openrouter', 'sk-or-ok', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('openrouter', [model('openrouter', 'vetado', 90), model('openrouter', 'bueno', 50)]);
    responders.openrouter = (body) =>
      body.model === 'vetado' ? status(401, 'only available on agentic harnesses') : jsonOk(body);

    const key = seedKey('calidad');
    const response = await chat(app, key);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'openrouter/bueno');

    // La comprobación de la clave es asíncrona; se espera a que termine.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const providerKey = listProviderKeys().find((entry) => entry.providerId === 'openrouter');
    assert.equal(providerKey?.status, 'active', 'la clave sigue siendo válida');
    const models = listModels(false);
    assert.equal(models.find((m) => m.id === 'vetado')?.enabled, false, 'solo se desactiva el modelo vetado');
    assert.equal(models.find((m) => m.id === 'bueno')?.enabled, true);
  });

  it('se rinde con un modelo que no arranca, sin esperar el tope entero', async () => {
    // Cuatro modelos muertos de NVIDIA se comían 480 s de los 786 s del proveedor
    // esperando dos minutos cada uno. Y para nada: la puntuación de velocidad ya da cero
    // a partir de 10 s de TTFT, así que ninguno de ellos se iba a elegir jamás.
    seedProvider('groq', 'no-arranca', 50, 30);
    responders.groq = (_body, signal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Nunca emite nada: el proveedor acepta y se queda callado. Al abortar, el
            // cuerpo revienta, que es lo que hace `fetch` de verdad.
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    const target = listModels().find((m) => m.id === 'no-arranca')!;
    const empezado = Date.now();
    const measurement = await measureModel(target, { firstTokenMs: 120 });
    const tardado = Date.now() - empezado;

    assert.ok('error' in measurement, 'debe fallar, no colgarse');
    assert.equal(measurement.kind, 'timeout');
    assert.ok(tardado < 2000, `debe cortar al plazo del primer token, tardó ${tardado} ms`);
  });

  it('el plazo del primer token no corta a un modelo lento pero sano', async () => {
    // En cuanto el modelo arranca, el reloj corto se cancela: escribir despacio es
    // legítimo y retirarlo por eso sería perder un modelo que en producción funciona.
    seedProvider('groq', 'lento-pero-vivo', 50, 30);
    responders.groq = (_body, signal) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            controller.enqueue(encoder.encode(`data: ${chunk('arranco ', 'lento-pero-vivo')}\n\n`));
            // Más tiempo del que dura el plazo del primer token, ya consumido.
            await new Promise((resolve) => setTimeout(resolve, 250));
            controller.enqueue(encoder.encode(`data: ${chunk('palabra '.repeat(40), 'lento-pero-vivo')}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const target = listModels().find((m) => m.id === 'lento-pero-vivo')!;
    const measurement = await measureModel(target, { firstTokenMs: 120 });

    assert.ok(!('error' in measurement), `no debía cortarse: ${JSON.stringify(measurement)}`);
    assert.ok(measurement.ttftMs > 0);
  });

  it('mide tok/s aunque el proveedor mande toda la respuesta en un solo chunk', async () => {
    // Algunos proveedores no trocean el stream. Con el último evento de contenido como
    // referencia el intervalo de generación sería cero y el ritmo quedaría sin medir.
    seedProvider('groq', 'de-golpe', 50, 30);
    const texto = 'palabra '.repeat(80);
    responders.groq = () => sse([JSON.stringify({ choices: [{ delta: { content: texto } }] }), '[DONE]']);

    const target = listModels().find((m) => m.id === 'de-golpe')!;
    const measurement = await measureModel(target);

    assert.ok(!('error' in measurement), `medición fallida: ${JSON.stringify(measurement)}`);
    assert.ok(measurement.ttftMs > 0);
    assert.notEqual(measurement.tps, null, 'debe salir un ritmo, no null');
    assert.ok(measurement.detail.burstRatio >= 0 && measurement.detail.burstRatio <= 1);
    assert.ok((measurement.tps ?? 0) > 0);
    // Sin `usage`, los tokens se estiman por longitud del texto.
    assert.ok(measurement.completionTokens > 50, `tokens estimados: ${measurement.completionTokens}`);
  });

  it('calibra proveedores distintos a la vez, no uno detrás de otro', async () => {
    // Cada proveedor es una API con su propia cuota: esperar a uno mientras se mide otro
    // no aporta nada y multiplica el tiempo de calibración por el número de proveedores.
    for (const id of ['groq', 'cerebras', 'openrouter'] as ProviderId[]) {
      saveProviderKey(id, `${id}-fake`, { rpm: 100, tpm: null, rpd: null, tpd: null });
      replaceModels(id, [model(id, `${id}-m`, 50)]);
    }

    let enVuelo = 0;
    let picoSimultaneo = 0;
    responders.groq = responders.cerebras = responders.openrouter = () => {
      enVuelo += 1;
      picoSimultaneo = Math.max(picoSimultaneo, enVuelo);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 20; i += 1) {
              controller.enqueue(encoder.encode(`data: ${chunk('x', 'm')}

`));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            enVuelo -= 1;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const resultado = await warmupAll({ force: true });

    assert.equal(resultado.measured, 3, `no se midieron los tres: ${JSON.stringify(resultado)}`);
    assert.ok(picoSimultaneo > 1, `las mediciones fueron en serie (pico ${picoSimultaneo})`);
    assert.ok(picoSimultaneo <= 6, `se superó el tope global de mediciones a la vez (${picoSimultaneo})`);
  });

  it('el refresco respeta a qué modelos da acceso la clave', async () => {
    // El refresco usaba `listModels`, que devuelve el catálogo entero. Así volvía a
    // meter los modelos que la cuenta no cubre y deshacía lo que la conexión había
    // averiguado: en LLM7 reaparecían los 33 que exigen saldo.
    saveProviderKey('groq', 'clave', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('groq', [model('groq', 'viejo', 50)]);

    const provider = getProvider('groq')!;
    let pedidos = 0;
    const conAcceso = { ...provider, validateKey: async () => {
      pedidos += 1;
      return { ok: true as const, models: [model('groq', 'permitido', 60)] };
    } };

    const resultado = await refreshProviderModels(conAcceso);

    assert.equal(resultado.ok, true);
    assert.equal(pedidos, 1, 'el refresco debe pasar por la comprobación de acceso');
    assert.deepEqual(listModels(false).map((m) => m.id), ['permitido']);
  });

  it('un refresco fallido no vacía el catálogo que ya funcionaba', async () => {
    saveProviderKey('groq', 'clave', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('groq', [model('groq', 'bueno', 50)]);

    const provider = getProvider('groq')!;
    const caido = { ...provider, validateKey: async () => ({ ok: false as const, error: 'proveedor caído' }) };

    const resultado = await refreshProviderModels(caido);

    assert.equal(resultado.ok, false);
    assert.deepEqual(listModels(false).map((m) => m.id), ['bueno'], 'se conserva lo anterior');
  });

  it('un modelo que el proveedor no sirve se aparta, no se reintenta en bucle', async () => {
    // NVIDIA lista 69 modelos y 48 responden «Function … Not Found». Meterlos en el
    // ciclo de cuarentena los reintenta cada cuarto de hora para siempre: gastan cuota,
    // ensucian el panel y nunca van a funcionar.
    seedProvider('groq', 'fantasma', 90, 30);
    replaceModels('groq', [model('groq', 'fantasma', 90), model('groq', 'real', 50)]);
    responders.groq = (body) =>
      body.model === 'fantasma' ? status(404, 'Function not found') : jsonOk(body);

    // El router explora entre los modelos sin medir, así que no siempre prueba el
    // fantasma a la primera. Se insiste hasta que lo intente: lo que se comprueba es
    // qué hace CUANDO lo intenta, no en qué orden lo elige.
    const key = seedKey('calidad');
    for (let intento = 0; intento < 6; intento += 1) {
      const response = await chat(app, key);
      assert.equal(response.statusCode, 200, 'siempre debe responder con el modelo sano');
      if (calls.some((call) => call.model === 'fantasma')) break;
    }
    assert.ok(calls.some((call) => call.model === 'fantasma'), 'el fantasma debería haberse intentado');

    const fantasma = listModels(false).find((m) => m.id === 'fantasma');
    assert.equal(fantasma?.enabled, false, 'debe quedar apartado');
    const salud = allHealth().find((h) => h.modelId === 'fantasma');
    assert.equal(salud?.quarantinedUntil, null, 'y no en cuarentena con reintentos');
  });

  it('un proveedor caído entra en cuarentena y el tráfico sigue por el otro', async () => {
    seedProvider('groq', 'g', 90, 30);
    seedProvider('cerebras', 'c', 50, 30);
    responders.groq = () => new Response('boom', { status: 500 });

    const key = seedKey('calidad');
    for (let i = 0; i < 3; i += 1) {
      const response = await chat(app, key);
      assert.equal(response.statusCode, 200);
    }

    const before = calls.filter((call) => call.providerId === 'groq').length;
    assert.equal(before, 3, 'los tres primeros intentos aún prueban Groq');

    // Al tercer fallo consecutivo queda en cuarentena: deja de intentarse.
    const response = await chat(app, key);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-freerouter-model'], 'cerebras/c');
    assert.equal(calls.filter((call) => call.providerId === 'groq').length, 3);
  });
});
