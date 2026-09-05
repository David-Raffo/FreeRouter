/**
 * Traducción entre la Responses API de OpenAI y Chat Completions.
 *
 * OpenAI publicó `/v1/responses` como sucesora de `/v1/chat/completions`, y varios
 * clientes ya la usan por defecto —n8n trae el interruptor activado—, así que un router
 * que solo hable el formato viejo se estrella nada más conectarlo.
 *
 * No es un alias: cambia la petición (`input` en vez de `messages`), la respuesta
 * (una lista de `output` en vez de `choices`) y el streaming (eventos con nombre en vez
 * de trozos homogéneos). Lo que sí se puede es traducir, y es lo que hace este módulo:
 * la petición entra, se convierte a Chat Completions, la sirve el router de siempre sin
 * saber nada de esto, y la respuesta se convierte de vuelta.
 *
 * Todo son funciones puras salvo el generador de eventos, para poder probarlas sin
 * levantar nada.
 */

import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Lo que la Responses API devuelve como eco de la petición. Se guarda al traducir para
 * poder reconstruirlo en la respuesta, que repite los parámetros con los que se llamó.
 */
export interface ResponseEcho {
  instructions: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  tools: unknown[];
  toolChoice: unknown;
  textFormat: Json;
  metadata: Json;
}

export type Translation =
  | { ok: true; chat: Json; echo: ResponseEcho }
  | { ok: false; message: string };

/** Campos que se copian tal cual porque significan lo mismo en las dos APIs. */
const PASSTHROUGH = ['stream', 'stop', 'seed', 'user', 'parallel_tool_calls', 'presence_penalty', 'frequency_penalty'];

export function toChatRequest(body: Json): Translation {
  if (body.input === undefined && !Array.isArray(body.messages)) {
    return { ok: false, message: 'El campo `input` es obligatorio.' };
  }

  // Sin almacenamiento de conversaciones no se puede continuar uno anterior. Fallar aquí
  // es preferible a responder ignorándolo: el cliente creería que mandó el contexto.
  if (typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0) {
    return {
      ok: false,
      message:
        'FreeRouter no guarda conversaciones, así que no admite `previous_response_id`. ' +
        'Manda el historial completo en `input` en cada petición.',
    };
  }

  const messages = toMessages(body.input);
  const instructions = typeof body.instructions === 'string' && body.instructions.length > 0 ? body.instructions : null;
  if (instructions) messages.unshift({ role: 'system', content: instructions });

  if (messages.length === 0) {
    return { ok: false, message: 'El campo `input` no contiene ningún mensaje utilizable.' };
  }

  const chat: Json = { messages };
  for (const field of PASSTHROUGH) {
    if (body[field] !== undefined) chat[field] = body[field];
  }
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;

  const tools = toChatTools(body.tools);
  if (tools.length > 0) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  }

  const textFormat = ((body.text as Json | undefined)?.format as Json | undefined) ?? { type: 'text' };
  const responseFormat = toResponseFormat(textFormat);
  if (responseFormat) chat.response_format = responseFormat;

  return {
    ok: true,
    chat,
    echo: {
      instructions,
      maxOutputTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : null,
      temperature: typeof body.temperature === 'number' ? body.temperature : null,
      topP: typeof body.top_p === 'number' ? body.top_p : null,
      tools: Array.isArray(body.tools) ? body.tools : [],
      toolChoice: body.tool_choice ?? 'auto',
      textFormat,
      metadata: (body.metadata as Json | undefined) ?? {},
    },
  };
}

/** `input` admite una cadena suelta o una lista de items de varios tipos. */
function toMessages(input: unknown): Json[] {
  if (typeof input === 'string') {
    return input.length > 0 ? [{ role: 'user', content: input }] : [];
  }
  if (!Array.isArray(input)) return [];

  const messages: Json[] = [];
  // Las llamadas a herramientas seguidas van en un solo mensaje del asistente: es como
  // las espera Chat Completions, y algunos proveedores rechazan lo contrario.
  let pendingCalls: Json[] = [];

  const flush = () => {
    if (pendingCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };

  for (const raw of input) {
    const item = raw as Json;
    const type = String(item.type ?? 'message');

    if (type === 'function_call') {
      pendingCalls.push({
        id: String(item.call_id ?? item.id ?? newId('call')),
        type: 'function',
        function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') },
      });
      continue;
    }

    flush();

    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }

    const role = String(item.role ?? 'user');
    const content = toChatContent(item.content);
    if (content !== null) messages.push({ role, content });
  }

  flush();
  return messages;
}

/**
 * Contenido de un mensaje. Si todo son textos se devuelve una cadena: bastantes
 * proveedores gratuitos no digieren bien la forma en lista, y aquí no aporta nada.
 */
function toChatContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: Json[] = [];
  for (const raw of content) {
    const part = raw as Json;
    const type = String(part.type ?? '');

    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      parts.push({ type: 'text', text: String(part.text ?? '') });
    } else if (type === 'input_image' || type === 'image_url') {
      // En Responses `image_url` es la URL suelta; en Chat Completions es un objeto.
      const source = part.image_url;
      const url = typeof source === 'string' ? source : (source as Json | undefined)?.url;
      if (typeof url === 'string' && url.length > 0) {
        const image: Json = { url };
        if (typeof part.detail === 'string' && part.detail !== 'auto') image.detail = part.detail;
        parts.push({ type: 'image_url', image_url: image });
      }
    } else if (type === 'refusal') {
      parts.push({ type: 'text', text: String(part.refusal ?? '') });
    } else {
      // Audio y ficheros usan la misma forma en las dos APIs; lo que no conozcamos se
      // reenvía tal cual antes que descartarlo.
      parts.push(part);
    }
  }

  if (parts.length === 0) return null;
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => String(part.text ?? '')).join('');
  return parts;
}

/**
 * Las herramientas de función van planas en Responses y anidadas en Chat Completions.
 * Las integradas (búsqueda web, intérprete de código…) las ejecuta OpenAI en su servidor
 * y ningún proveedor gratuito las tiene, así que se descartan en vez de romper.
 */
function toChatTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const raw of tools) {
    const tool = raw as Json;
    if (tool.type !== 'function') continue;
    // Ya viene anidada: algún cliente manda el formato de Chat Completions por aquí.
    if (tool.function && typeof tool.function === 'object') {
      out.push(tool);
      continue;
    }
    const fn: Json = { name: String(tool.name ?? ''), parameters: tool.parameters ?? { type: 'object', properties: {} } };
    if (typeof tool.description === 'string') fn.description = tool.description;
    if (typeof tool.strict === 'boolean') fn.strict = tool.strict;
    out.push({ type: 'function', function: fn });
  }
  return out;
}

function toResponseFormat(format: Json): Json | null {
  const type = String(format.type ?? 'text');
  if (type === 'json_object') return { type: 'json_object' };
  if (type === 'json_schema') {
    const schema: Json = { name: String(format.name ?? 'response'), schema: format.schema ?? {} };
    if (typeof format.strict === 'boolean') schema.strict = format.strict;
    return { type: 'json_schema', json_schema: schema };
  }
  return null;
}

// ── De vuelta: Chat Completions → Responses ──────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

function readToolCalls(message: Json): ToolCall[] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((raw) => {
    const call = raw as Json;
    const fn = (call.function ?? {}) as Json;
    return {
      id: String(call.id ?? newId('call')),
      name: String(fn.name ?? ''),
      arguments: String(fn.arguments ?? '{}'),
    };
  });
}

function messageItem(text: string, itemId: string): Json {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallItem(call: ToolCall, itemId: string): Json {
  return {
    id: itemId,
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

function toUsage(usage: unknown): Json | null {
  if (!usage || typeof usage !== 'object') return null;
  const source = usage as Json;
  const input = Number(source.prompt_tokens ?? 0);
  const output = Number(source.completion_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: Number(source.total_tokens ?? input + output),
  };
}

/** `length` en Chat Completions es «me quedé sin sitio», que allí tiene otro nombre. */
function incompleteDetails(finishReason: string): Json | null {
  return finishReason === 'length' ? { reason: 'max_output_tokens' } : null;
}

interface EnvelopeOptions {
  id: string;
  model: string;
  echo: ResponseEcho;
  status: 'in_progress' | 'completed' | 'incomplete';
  output: Json[];
  usage: Json | null;
  finishReason: string;
  createdAt: number;
}

function envelope(options: EnvelopeOptions): Json {
  const { echo } = options;
  const incomplete = options.status === 'completed' ? incompleteDetails(options.finishReason) : null;
  return {
    id: options.id,
    object: 'response',
    created_at: options.createdAt,
    status: incomplete ? 'incomplete' : options.status,
    background: false,
    error: null,
    incomplete_details: incomplete,
    instructions: echo.instructions,
    max_output_tokens: echo.maxOutputTokens,
    metadata: echo.metadata,
    model: options.model,
    output: options.output,
    // No forma parte de la respuesta de OpenAI, pero varios SDK la exponen con este
    // nombre y algún cliente la lee directamente. Sale gratis y evita sorpresas.
    output_text: options.output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content as Json[] | undefined) ?? [])
      .map((part) => String(part.text ?? ''))
      .join(''),
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: echo.temperature,
    text: { format: echo.textFormat },
    tool_choice: echo.toolChoice,
    tools: echo.tools,
    top_p: echo.topP,
    truncation: 'disabled',
    usage: options.usage,
    user: null,
  };
}

/** Respuesta completa a partir de la de Chat Completions. */
export function toResponsesPayload(payload: Json, model: string, echo: ResponseEcho): Json {
  const choice = ((payload.choices as Json[] | undefined) ?? [])[0] ?? {};
  const message = ((choice as Json).message ?? {}) as Json;
  const text = typeof message.content === 'string' ? message.content : '';
  const finishReason = String((choice as Json).finish_reason ?? 'stop');

  const output: Json[] = [];
  if (text.length > 0) output.push(messageItem(text, newId('msg')));
  for (const call of readToolCalls(message)) output.push(functionCallItem(call, newId('fc')));

  return envelope({
    id: newId('resp'),
    model,
    echo,
    status: 'completed',
    output,
    usage: toUsage(payload.usage),
    finishReason,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

// ── Streaming ────────────────────────────────────────────────────────────────────────

export interface NamedEvent {
  event: string;
  data: Json;
}

interface StreamState {
  text: string;
  calls: Map<number, ToolCall>;
  usage: Json | null;
  finishReason: string;
}

/** Acumula un trozo de Chat Completions en el estado del stream. */
function absorb(state: StreamState, chunk: Json): string {
  const choice = ((chunk.choices as Json[] | undefined) ?? [])[0];
  if (chunk.usage) state.usage = toUsage(chunk.usage) ?? state.usage;
  if (!choice) return '';

  const finish = (choice as Json).finish_reason;
  if (typeof finish === 'string' && finish.length > 0) state.finishReason = finish;

  const delta = ((choice as Json).delta ?? {}) as Json;

  for (const raw of (delta.tool_calls as Json[] | undefined) ?? []) {
    const index = Number(raw.index ?? 0);
    const existing = state.calls.get(index) ?? { id: '', name: '', arguments: '' };
    const fn = (raw.function ?? {}) as Json;
    if (typeof raw.id === 'string' && raw.id.length > 0) existing.id = raw.id;
    if (typeof fn.name === 'string' && fn.name.length > 0) existing.name = fn.name;
    if (typeof fn.arguments === 'string') existing.arguments += fn.arguments;
    state.calls.set(index, existing);
  }

  const piece = typeof delta.content === 'string' ? delta.content : '';
  state.text += piece;
  return piece;
}

/**
 * Convierte el stream de Chat Completions en el de la Responses API.
 *
 * Los eventos van con nombre y numerados, y el ciclo de vida es explícito: cada item de
 * salida se abre, recibe sus deltas y se cierra. Los clientes que hablan esta API se
 * apoyan en esa estructura, así que se emite completa aunque el origen no la tenga.
 */
export async function* toResponsesEvents(
  chatEvents: AsyncGenerator<string>,
  model: string,
  echo: ResponseEcho,
): AsyncGenerator<NamedEvent> {
  const responseId = newId('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  const state: StreamState = { text: '', calls: new Map(), usage: null, finishReason: 'stop' };

  let sequence = 0;
  const emit = (event: string, data: Json): NamedEvent => {
    sequence += 1;
    return { event, data: { ...data, type: event, sequence_number: sequence } };
  };

  const shell = (status: 'in_progress' | 'completed', output: Json[], usage: Json | null): Json =>
    envelope({ id: responseId, model, echo, status, output, usage, finishReason: state.finishReason, createdAt });

  yield emit('response.created', { response: shell('in_progress', [], null) });
  yield emit('response.in_progress', { response: shell('in_progress', [], null) });

  const messageId = newId('msg');
  let messageOpen = false;
  let outputIndex = 0;

  for await (const data of chatEvents) {
    if (data === '[DONE]') break;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      continue;
    }

    const piece = absorb(state, chunk);
    if (piece.length === 0) continue;

    // El item de mensaje se abre con el primer texto, no antes: si la respuesta resulta
    // ser solo llamadas a herramientas, no debe aparecer un mensaje vacío.
    if (!messageOpen) {
      messageOpen = true;
      yield emit('response.output_item.added', {
        output_index: outputIndex,
        item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      yield emit('response.content_part.added', {
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }

    yield emit('response.output_text.delta', {
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      delta: piece,
      logprobs: [],
    });
  }

  const output: Json[] = [];

  if (messageOpen) {
    yield emit('response.output_text.done', {
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      text: state.text,
      logprobs: [],
    });
    yield emit('response.content_part.done', {
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: state.text, annotations: [] },
    });
    const item = messageItem(state.text, messageId);
    output.push(item);
    yield emit('response.output_item.done', { output_index: outputIndex, item });
    outputIndex += 1;
  }

  // Las llamadas a herramientas se emiten al final, con los argumentos ya completos: el
  // origen los manda troceados por índice y no se sabe que uno terminó hasta el cierre.
  for (const call of [...state.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)) {
    const callId = call.id.length > 0 ? call.id : newId('call');
    const itemId = newId('fc');
    const opened: Json = {
      id: itemId,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      name: call.name,
      arguments: '',
    };
    yield emit('response.output_item.added', { output_index: outputIndex, item: opened });
    yield emit('response.function_call_arguments.delta', {
      item_id: itemId,
      output_index: outputIndex,
      delta: call.arguments,
    });
    yield emit('response.function_call_arguments.done', {
      item_id: itemId,
      output_index: outputIndex,
      arguments: call.arguments,
    });
    const item = functionCallItem({ ...call, id: callId }, itemId);
    output.push(item);
    yield emit('response.output_item.done', { output_index: outputIndex, item });
    outputIndex += 1;
  }

  yield emit('response.completed', { response: shell('completed', output, state.usage) });
}

/** Formato SSE de la Responses API: evento con nombre, y sin `[DONE]` al final. */
export async function* toNamedSse(events: AsyncGenerator<NamedEvent>): AsyncGenerator<string> {
  for await (const { event, data } of events) {
    yield `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
