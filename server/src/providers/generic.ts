/**
 * Fábrica de proveedores compatibles con OpenAI.
 *
 * Construye un `Provider` a partir de un descriptor. Lo único con enjundia aquí es leer
 * el listado de modelos: cada proveedor devuelve el mismo endpoint `/models` con un
 * esquema ligeramente distinto (unos informan precio, otros modalidades, otros solo el
 * id), así que en vez de un mapeador por proveedor hay uno que busca cada dato en los
 * sitios donde suele estar.
 */

import { capabilitiesFor, isChatModel } from '../catalog/index.js';
import type { ProviderDescriptor } from './descriptor.js';
import { modelsDevMetadata } from './modelsdev.js';
import type { InputModality, ModelInfo, OutputModality, Provider, ValidationResult } from './types.js';

/** Rutas donde los distintos proveedores publican cada dato, en orden de preferencia. */
const FIELD_PATHS = {
  context: ['context_window', 'context_length', 'max_model_len', 'top_provider.context_length', 'limit.context'],
  maxOutput: ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens', 'limit.output'],
  inputPrice: ['input_price', 'pricing.input', 'pricing.prompt', 'cost.input'],
  outputPrice: ['output_price', 'pricing.output', 'pricing.completion', 'cost.output'],
  inputModalities: ['architecture.input_modalities', 'modalities.input', 'input_modalities'],
  outputModalities: ['architecture.output_modalities', 'modalities.output', 'output_modalities'],
} as const;

type Raw = Record<string, unknown>;

function dig(model: Raw, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Raw)[key];
  }, model);
}

function firstNumber(model: Raw, paths: readonly string[]): number | null {
  for (const path of paths) {
    const value = dig(model, path);
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstStringArray(model: Raw, paths: readonly string[]): string[] | null {
  for (const path of paths) {
    const value = dig(model, path);
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  }
  return null;
}

/**
 * ¿Es gratis? `null` significa "el proveedor no publica precios", que no es lo mismo
 * que gratis: quien decide en ese caso es `freeOnly` del descriptor.
 */
function isFree(model: Raw): boolean | null {
  const input = firstNumber(model, FIELD_PATHS.inputPrice);
  const output = firstNumber(model, FIELD_PATHS.outputPrice);
  if (input === null && output === null) return null;
  return (input ?? 0) === 0 && (output ?? 0) === 0;
}

/**
 * Campos con los que un proveedor marca que un modelo necesita una cuenta identificada,
 * aunque su catálogo lo liste junto a los demás.
 *
 * LLM7 usa `usage_based_only`. Su listado es IDÉNTICO con clave y sin ella, así que no
 * hay forma de saber por adelantado qué desbloquea un token concreto: lo único
 * comprobado es que sin clave estos modelos responden `model_credentials_unavailable`.
 *
 * Por eso el filtro depende de la clave: sin ella se descartan (está demostrado que no
 * sirven, y descubrirlo fallando cuesta una petición por modelo), y con ella se dejan
 * pasar. Si el token no los cubre, el propio router los desactiva uno a uno al primer
 * fallo, que es el comportamiento que ya existe para modelos vetados.
 */
const IDENTIFIED_ACCOUNT_FLAGS = ['usage_based_only', 'requires_key', 'requires_subscription'];

function needsIdentifiedAccount(model: Raw): boolean {
  return IDENTIFIED_ACCOUNT_FLAGS.some((path) => dig(model, path) === true);
}

/**
 * Tipos de modelo que NO sirven para /chat/completions. Algunos proveedores lo declaran
 * (LLM7 usa `model_type`), y aprovecharlo es mucho más fiable que adivinarlo por el
 * nombre: enrutar un chat a un generador de imágenes o de vídeo falla siempre.
 */
const NON_CHAT_TYPES = new Set([
  'image',
  'video',
  'audio',
  'embedding',
  'embeddings',
  'rerank',
  'moderation',
  'tts',
  'stt',
  // Pollinations publica también estos dos, y ninguno atiende /chat/completions.
  '3d',
  'realtime',
]);

function isChatType(model: Raw): boolean {
  // `category` lo usa Pollinations, que en un mismo listado mezcla 280 modelos de texto
  // con 114 de imagen, audio, vídeo, 3D y realtime.
  for (const path of ['model_type', 'type', 'modality', 'category']) {
    const value = dig(model, path);
    if (typeof value === 'string' && NON_CHAT_TYPES.has(value.toLowerCase())) return false;
  }
  return true;
}

/** Detecta tool use en los distintos formatos vistos en la práctica. */
function detectTools(model: Raw): boolean | null {
  const supported = dig(model, 'supported_parameters');
  if (Array.isArray(supported)) return supported.includes('tools');
  for (const path of ['capabilities.tools', 'supports_tools', 'capabilities.function_calling', 'tool_call', 'tools']) {
    const value = dig(model, path);
    if (typeof value === 'boolean') return value;
  }
  const capabilities = dig(model, 'capabilities');
  if (Array.isArray(capabilities)) {
    // `tool_calling` es como lo llama Pollinations.
    return capabilities.includes('tools') || capabilities.includes('function_calling') || capabilities.includes('tool_calling');
  }
  return null;
}

const INPUT_MODALITIES: InputModality[] = ['text', 'image', 'audio', 'video'];
const OUTPUT_MODALITIES: OutputModality[] = ['text', 'image', 'audio'];

function narrowInput(values: string[] | null): InputModality[] | null {
  if (!values) return null;
  const kept = values.filter((value): value is InputModality => (INPUT_MODALITIES as string[]).includes(value));
  return kept.length > 0 ? kept : null;
}

function narrowOutput(values: string[] | null): OutputModality[] | null {
  if (!values) return null;
  const kept = values.filter((value): value is OutputModality => (OUTPUT_MODALITIES as string[]).includes(value));
  return kept.length > 0 ? kept : null;
}

/**
 * Comprueba que la clave sirve para generar, con la petición más barata posible.
 * Devuelve el motivo del rechazo, o `null` si la clave funciona.
 */
async function checkKeyWorks(provider: Provider, key: string, modelId: string): Promise<string | null> {
  const { callChat } = await import('./chat.js');
  const result = await callChat(
    provider,
    key,
    { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
    { timeoutMs: 30_000 },
  );
  if (result.ok) {
    await result.response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (result.kind === 'auth') return `Clave rechazada por el proveedor: ${result.message}`;
  if (result.kind === 'payment_required') return `La cuenta no puede servir peticiones: ${result.message}`;
  // Algunos proveedores responden 5xx cuando el modelo no está disponible para la cuenta
  // (LLM7 usa `model_credentials_unavailable`), y eso también deja el modelo inservible.
  if (result.kind === 'server' && /credential|unavailable|balance|quota/i.test(result.message)) {
    return `El modelo no está disponible para esta cuenta: ${result.message}`;
  }
  // Un 429 o un fallo puntual del modelo elegido no dicen nada malo de la clave.
  return null;
}

/**
 * Separa «idDeCuenta:token» en sus dos partes. Se corta por el PRIMER `:` porque el
 * token puede contener más.
 */
export function splitCredential(key: string): { account: string; token: string } {
  const index = key.indexOf(':');
  if (index === -1) return { account: '', token: key };
  return { account: key.slice(0, index), token: key.slice(index + 1) };
}

export function buildProvider(descriptor: ProviderDescriptor, overrides: Partial<Provider> = {}): Provider {
  const exclusions = (descriptor.excludePatterns ?? []).map((pattern) => new RegExp(pattern, 'i'));
  // Cuando el proveedor no publica precios legibles, el id es lo único que separa lo
  // gratuito de lo que factura. Ver `freeIdPattern` en el descriptor.
  const soloGratis = descriptor.freeIdPattern ? new RegExp(descriptor.freeIdPattern, 'i') : null;
  const splits = descriptor.credentialFormat === 'account:token';

  const tokenOf = (key: string): string => (splits ? splitCredential(key).token : key);
  const urlOf = (key: string): string => {
    if (!splits || !descriptor.baseUrlTemplate) return descriptor.baseUrl;
    return descriptor.baseUrlTemplate.replace('{account}', splitCredential(key).account);
  };

  const base: Provider = {
    id: descriptor.id,
    label: descriptor.label,
    freeTier: descriptor.freeTier,
    baseUrl: descriptor.baseUrl,
    keyHint: descriptor.keyHint,
    consoleUrl: descriptor.consoleUrl,
    failoverRank: descriptor.failoverRank,
    defaultLimits: descriptor.defaultLimits,
    quotaScope: descriptor.quotaScope,
    rateLimitPenaltyFactor: descriptor.rateLimitPenaltyFactor ?? 1,

    // Con clave opcional y campo vacío no se manda cabecera: varios proveedores
    // rechazan un `Bearer ` vacío con 401 en vez de tratarlo como anónimo.
    authHeaders: (key): Record<string, string> => {
      const token = tokenOf(key);
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    ...(splits ? { resolveBaseUrl: urlOf } : {}),
    ...(descriptor.extraHeaders ? { extraHeaders: descriptor.extraHeaders } : {}),

    async listModels(key: string) {
      const headers: Record<string, string> = descriptor.publicModelList
        ? {}
        : { authorization: `Bearer ${tokenOf(key)}` };
      const res = await fetch(`${urlOf(key)}/models`, {
        headers: { ...headers, ...(descriptor.extraHeaders ?? {}) },
      });
      if (!res.ok) {
        throw new Error(`${descriptor.label} /models devolvió ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      const payload = (await res.json()) as { data?: Raw[] };
      const models: ModelInfo[] = [];

      // Complemento opcional: quién sirve qué lo dice el proveedor; models.dev aporta
      // el precio y las capacidades que su listado no incluye.
      const extra = descriptor.modelsDevKey
        ? await modelsDevMetadata(descriptor.modelsDevKey)
        : new Map<string, Raw>();

      for (const entry of payload.data ?? []) {
        const id = typeof entry.id === 'string' ? entry.id : null;
        if (!id) continue;
        // El listado del proveedor manda: sus campos pisan a los de models.dev.
        const raw: Raw = { ...((extra.get(id) as Raw) ?? {}), ...entry };
        if (!isChatModel(id)) continue;
        if (!isChatType(raw)) continue;
        const identified = needsIdentifiedAccount(raw);
        if (!key && identified) continue;
        if (exclusions.some((pattern) => pattern.test(id))) continue;
        if (soloGratis && !soloGratis.test(id)) continue;

        // Cuando el proveedor publica precios y solo queremos lo gratuito, un modelo sin
        // precio conocido se descarta: es más seguro perder un modelo que facturar.
        const free = isFree(raw);
        if (descriptor.freeOnly && free !== true) continue;

        const caps = capabilitiesFor(descriptor.id, id);
        const input = narrowInput(firstStringArray(raw, FIELD_PATHS.inputModalities)) ?? caps?.input ?? ['text'];
        const output = narrowOutput(firstStringArray(raw, FIELD_PATHS.outputModalities)) ?? caps?.output ?? ['text'];

        models.push({
          providerId: descriptor.id,
          id,
          displayName: typeof raw.name === 'string' ? raw.name : id,
          contextLength: firstNumber(raw, FIELD_PATHS.context) ?? caps?.context ?? descriptor.defaultContext ?? 8192,
          maxCompletionTokens: firstNumber(raw, FIELD_PATHS.maxOutput),
          inputModalities: input,
          outputModalities: output,
          supportsTools: detectTools(raw) ?? caps?.tools ?? false,
          // La calidad la resuelve el registry contra el catálogo.
          qualityScore: null,
          qualitySource: null,
          requiresIdentifiedAccount: identified,
        });
      }
      return models;
    },

    async validateKey(key: string): Promise<ValidationResult> {
      try {
        const models = await this.listModels(key);
        if (models.length === 0) {
          return {
            ok: false,
            error: descriptor.freeOnly
              ? 'El proveedor no ofrece ahora mismo ningún modelo a precio cero.'
              : 'No se expone ningún modelo de chat.',
          };
        }

        // Cuando el listado es público, haberlo obtenido NO demuestra que la clave sea
        // válida: hay que gastarse una petición mínima para comprobarlo de verdad. Sin
        // esto, una clave mal pegada se guardaría como buena y fallaría en cada uso.
        const notes: string[] = [];
        let usable = models;

        if (descriptor.publicModelList && !(descriptor.keyOptional && key === '')) {
          // Se prueba con un modelo abierto, no con el primero de la lista: si se elige
          // uno reservado a cuentas con saldo, una cuenta sin saldo se rechazaría entera
          // aunque sus modelos gratuitos funcionen perfectamente.
          const open = models.find((model) => !model.requiresIdentifiedAccount);
          const problem = await checkKeyWorks(base, key, (open ?? models[0]!).id);
          if (problem) return { ok: false, error: problem };
        }

        // Los modelos reservados a cuentas identificadas se comprueban aparte: el
        // listado del proveedor es el mismo con clave y sin ella, así que la única forma
        // de saber si ESTA clave los cubre es pedirle uno. Guardarlos sin comprobarlo
        // dejaría decenas de modelos que fallan en cada intento.
        const restringidos = models.filter((model) => model.requiresIdentifiedAccount);
        if (restringidos.length > 0 && key) {
          const problem = await checkKeyWorks(base, key, restringidos[0]!.id);
          if (problem) {
            usable = models.filter((model) => !model.requiresIdentifiedAccount);
            notes.push(
              `${restringidos.length} modelos quedan fuera porque tu cuenta no los cubre: ${problem.replace(/^[^:]+:\s*/, '')}`,
            );
          } else {
            notes.push(`Tu clave desbloquea ${restringidos.length} modelos que sin ella no estarían disponibles.`);
          }
        }

        if (usable.length === 0) {
          return { ok: false, error: 'La clave funciona pero no da acceso a ningún modelo utilizable.' };
        }

        notes.unshift(`${usable.length} modelos disponibles.`);
        if (descriptor.warning) notes.push(descriptor.warning);
        return { ok: true, models: usable, notes };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    parseRateLimit: () => null,

    ...(descriptor.streamUsage
      ? {
          prepareBody(body: Record<string, unknown>) {
            if (!body.stream) return body;
            return {
              ...body,
              stream_options: { include_usage: true, ...((body.stream_options as object) ?? {}) },
            };
          },
        }
      : {}),
  };

  return { ...base, ...overrides };
}
