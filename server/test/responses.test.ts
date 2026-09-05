/**
 * La Responses API de OpenAI, servida traduciendo a Chat Completions.
 *
 * Se prueban las dos mitades por separado —la traducción, que es pura, y el endpoint
 * completo con `fetch` simulado— porque los fallos de formato son silenciosos: el
 * cliente recibe un JSON válido que no sabe leer y el error aparece a kilómetros de aquí.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closeDb, useInMemoryDb } from '../src/db.js';
import { resetQuotaState } from '../src/routing/quota.js';
import { createApiKey, recentRequests, replaceModels, saveProviderKey } from '../src/store.js';
import type { ModelInfo, ProviderId } from '../src/providers/types.js';
import { buildServer } from '../src/index.js';
import { toChatRequest, toResponsesEvents, toResponsesPayload, type ResponseEcho } from '../src/routes/responses-api.js';

// ── La traducción, sin servidor de por medio ────────────────────────────────────────

/** Traduce y falla la prueba si la traducción fue rechazada. */
function translate(body: Record<string, unknown>) {
  const result = toChatRequest(body);
  assert.ok(result.ok, `traducción rechazada: ${result.ok ? '' : result.message}`);
  return result;
}

describe('petición: Responses → Chat Completions', () => {
  it('acepta `input` como cadena suelta', () => {
    const { chat } = translate({ input: 'hola' });
    assert.deepEqual(chat.messages, [{ role: 'user', content: 'hola' }]);
  });

  it('`instructions` se convierte en el mensaje de sistema, y va primero', () => {
    const { chat } = translate({ input: 'hola', instructions: 'sé breve' });
    assert.deepEqual(chat.messages, [
      { role: 'system', content: 'sé breve' },
      { role: 'user', content: 'hola' },
    ]);
  });

  it('aplana el contenido cuando todo son textos', () => {
    // Varios proveedores gratuitos no digieren el contenido en forma de lista, y aquí
    // la lista no aporta nada.
    const { chat } = translate({
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'uno ' }, { type: 'input_text', text: 'dos' }] }],
    });
    assert.deepEqual(chat.messages, [{ role: 'user', content: 'uno dos' }]);
  });

  it('las imágenes cambian de forma: URL suelta a objeto', () => {
    const { chat } = translate({
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '¿qué es esto?' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'low' },
          ],
        },
      ],
    });
    const [message] = chat.messages as Array<{ content: unknown[] }>;
    assert.deepEqual(message?.content, [
      { type: 'text', text: '¿qué es esto?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'low' } },
    ]);
  });

  it('las herramientas pasan de planas a anidadas', () => {
    const { chat } = translate({
      input: 'hola',
      tools: [{ type: 'function', name: 'clima', description: 'el tiempo', parameters: { type: 'object' } }],
    });
    assert.deepEqual(chat.tools, [
      { type: 'function', function: { name: 'clima', parameters: { type: 'object' }, description: 'el tiempo' } },
    ]);
  });

  it('descarta las herramientas integradas, que las ejecuta OpenAI en su servidor', () => {
    const { chat } = translate({ input: 'hola', tools: [{ type: 'web_search_preview' }] });
    assert.equal(chat.tools, undefined, 'no debe reenviarse algo que ningún proveedor puede ejecutar');
  });

  it('reconstruye una conversación con llamada a herramienta y su resultado', () => {
    const { chat } = translate({
      input: [
        { role: 'user', content: 'qué tiempo hace' },
        { type: 'function_call', call_id: 'call_1', name: 'clima', arguments: '{"ciudad":"Madrid"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sol' },
      ],
    });
    assert.deepEqual(chat.messages, [
      { role: 'user', content: 'qué tiempo hace' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clima', arguments: '{"ciudad":"Madrid"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sol' },
    ]);
  });

  it('renombra los campos que cambian de nombre', () => {
    const { chat } = translate({ input: 'hola', max_output_tokens: 64, temperature: 0.2, stream: true });
    assert.equal(chat.max_tokens, 64);
    assert.equal(chat.temperature, 0.2);
    assert.equal(chat.stream, true);
  });

  it('traduce el formato de salida estructurada', () => {
    const { chat } = translate({
      input: 'hola',
      text: { format: { type: 'json_schema', name: 'x', schema: { type: 'object' }, strict: true } },
    });
    assert.deepEqual(chat.response_format, {
      type: 'json_schema',
      json_schema: { name: 'x', schema: { type: 'object' }, strict: true },
    });
  });

  it('rechaza `previous_response_id` en vez de ignorarlo', () => {
    // Ignorarlo daría una respuesta plausible sin el contexto que el cliente cree haber
    // mandado, que es peor que un error claro.
    const result = toChatRequest({ input: 'hola', previous_response_id: 'resp_123' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /previous_response_id/);
  });

  it('rechaza una petición sin `input`', () => {
    assert.equal(toChatRequest({}).ok, false);
  });
});

const echo: ResponseEcho = {
  instructions: null,
  maxOutputTokens: null,
  temperature: null,
  topP: null,
  tools: [],
  toolChoice: 'auto',
  textFormat: { type: 'text' },
  metadata: {},
};

describe('respuesta: Chat Completions → Responses', () => {
  it('envuelve el texto en un item de mensaje', () => {
    const payload = toResponsesPayload(
      {
        choices: [{ message: { role: 'assistant', content: 'hola' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      'groq/x',
      echo,
    );

    assert.equal(payload.object, 'response');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.model, 'groq/x');
    assert.deepEqual(payload.usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });

    const [item] = payload.output as Array<Record<string, unknown>>;
    assert.equal(item?.type, 'message');
    assert.equal(item?.role, 'assistant');
    assert.deepEqual(item?.content, [{ type: 'output_text', text: 'hola', annotations: [] }]);
  });

  it('un corte por longitud se marca como incompleto', () => {
    const payload = toResponsesPayload(
      { choices: [{ message: { content: 'a medi' }, finish_reason: 'length' }] },
      'groq/x',
      echo,
    );
    assert.equal(payload.status, 'incomplete');
    assert.deepEqual(payload.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('las llamadas a herramientas salen como items propios, no como mensaje', () => {
    const payload = toResponsesPayload(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clima', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'groq/x',
      echo,
    );
    const output = payload.output as Array<Record<string, unknown>>;
    assert.equal(output.length, 1, 'sin texto no debe aparecer un mensaje vacío');
    assert.equal(output[0]?.type, 'function_call');
    assert.equal(output[0]?.call_id, 'call_1');
    assert.equal(output[0]?.name, 'clima');
  });
});

/** Ejecuta el traductor de streaming sobre unos trozos de Chat Completions. */
async function streamEvents(chunks: unknown[]): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  async function* source(): AsyncGenerator<string> {
    for (const chunk of chunks) yield JSON.stringify(chunk);
    yield '[DONE]';
  }
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for await (const event of toResponsesEvents(source(), 'groq/x', echo)) out.push(event);
  return out;
}

describe('streaming: eventos con nombre', () => {
  it('abre, entrega y cierra el item de mensaje en orden', async () => {
    const events = await streamEvents([
      { choices: [{ delta: { content: 'ho' } }] },
      { choices: [{ delta: { content: 'la' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]);

    assert.deepEqual(
      events.map((e) => e.event),
      [
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ],
    );

    const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta);
    assert.deepEqual(deltas, ['ho', 'la']);
  });

  it('numera los eventos de forma correlativa y repite el tipo en el cuerpo', async () => {
    // Los clientes se apoyan en las dos cosas: `type` dentro del JSON y `sequence_number`
    // para detectar huecos.
    const events = await streamEvents([{ choices: [{ delta: { content: 'x' } }] }]);
    events.forEach((event, index) => {
      assert.equal(event.data.type, event.event);
      assert.equal(event.data.sequence_number, index + 1);
    });
  });

  it('la respuesta final trae el texto completo y el uso', async () => {
    const events = await streamEvents([
      { choices: [{ delta: { content: 'ho' } }] },
      { choices: [{ delta: { content: 'la' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]);

    const final = events[events.length - 1];
    assert.equal(final?.event, 'response.completed');
    const response = final?.data.response as Record<string, unknown>;
    assert.equal(response.status, 'completed');
    assert.equal(response.output_text, 'hola');
    assert.equal((response.usage as Record<string, unknown>).output_tokens, 2);
  });

  it('sin texto no se abre ningún item de mensaje', async () => {
    const events = await streamEvents([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'clima', arguments: '{"a":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const names = events.map((e) => e.event);
    assert.ok(!names.includes('response.content_part.added'), 'no debe abrirse un mensaje vacío');
    assert.ok(names.includes('response.function_call_arguments.done'));

    const final = events[events.length - 1]?.data.response as Record<string, unknown>;
    const output = final.output as Array<Record<string, unknown>>;
    assert.equal(output[0]?.type, 'function_call');
    assert.equal(output[0]?.arguments, '{"a":1}');
  });

  it('junta los argumentos que llegan troceados', async () => {
    const events = await streamEvents([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
    ]);
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    assert.equal(done?.data.arguments, '{"a":1}');
  });
});

// ── El endpoint completo ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

function installFetchStub(streaming: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!url.includes('/chat/completions')) throw new Error(`Llamada inesperada a ${url}`);
    lastUpstreamBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (!streaming) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hola' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const piece of ['ho', 'la']) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

let lastUpstreamBody: Record<string, unknown> = {};

function seed(): string {
  const providerId: ProviderId = 'groq';
  saveProviderKey(providerId, 'groq-fake-key', { rpm: 100, tpm: null, rpd: null, tpd: null });
  const info: ModelInfo = {
    providerId,
    id: 'modelo-de-prueba',
    displayName: 'modelo-de-prueba',
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    qualityScore: 50,
    qualitySource: 'measured',
    requiresIdentifiedAccount: false,
  };
  replaceModels(providerId, [info]);
  const plaintext = 'fr_test_responses';
  createApiKey('test', 'balanceado', [], plaintext);
  return plaintext;
}

let app: FastifyInstance;
let key: string;

beforeEach(async () => {
  useInMemoryDb();
  resetQuotaState();
  lastUpstreamBody = {};
  app = await buildServer();
  key = seed();
});

afterEach(async () => {
  await app.close();
  closeDb();
});

after(() => {
  globalThis.fetch = realFetch;
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, payload });

describe('POST /v1/responses', () => {
  it('responde en el formato de la Responses API', async () => {
    installFetchStub(false);
    const response = await post('/v1/responses', { model: 'auto', input: 'hola' });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.object, 'response');
    assert.equal(body.output_text, 'hola');
    assert.match(String(body.model), /^groq\//);
    assert.match(String(response.headers['x-freerouter-model']), /^groq\//);
  });

  it('el proveedor recibe Chat Completions, no Responses', async () => {
    installFetchStub(false);
    await post('/v1/responses', { input: 'hola', instructions: 'sé breve', max_output_tokens: 32 });

    assert.ok(Array.isArray(lastUpstreamBody.messages), 'el proveedor debe recibir `messages`');
    assert.equal(lastUpstreamBody.input, undefined);
    assert.equal(lastUpstreamBody.max_tokens, 32);
  });

  it('la petición queda en el historial igual que una de chat', async () => {
    // Era el síntoma que delató el fallo: n8n daba error y en el panel no aparecía nada,
    // porque la petición moría en el 404 antes de llegar al router.
    installFetchStub(false);
    await post('/v1/responses', { input: 'hola' });

    const [entry] = recentRequests(5);
    assert.equal(entry?.ok, 1);
    assert.equal(entry?.model_id, 'modelo-de-prueba');
  });

  it('emite eventos con nombre al hacer streaming', async () => {
    installFetchStub(true);
    const response = await post('/v1/responses', { input: 'hola', stream: true });

    assert.match(String(response.headers['content-type']), /text\/event-stream/);
    assert.match(response.body, /^event: response\.created\n/);
    assert.ok(response.body.includes('event: response.output_text.delta'));
    assert.ok(response.body.includes('event: response.completed'));
    assert.ok(!response.body.includes('[DONE]'), 'la Responses API no termina con [DONE]');
  });

  it('exige API key igual que el resto', async () => {
    installFetchStub(false);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      payload: { input: 'hola' },
    });
    assert.equal(response.statusCode, 401);
  });
});

describe('endpoints que no existen', () => {
  it('un 404 bajo /v1 dice qué se pidió y qué hay disponible', async () => {
    // Antes devolvía «No encontrado» a secas, y LangChain lo traducía a MODEL_NOT_FOUND:
    // el usuario acababa buscando el fallo en el modelo, que no tenía nada que ver.
    installFetchStub(false);
    const response = await post('/v1/embeddings', { input: 'hola' });

    assert.equal(response.statusCode, 404);
    const message = String(((response.json() as { error: { message: string } }).error ?? {}).message);
    assert.match(message, /\/v1\/embeddings/);
    assert.match(message, /\/v1\/chat\/completions/);
    assert.match(message, /\/v1\/responses/);
  });
});
