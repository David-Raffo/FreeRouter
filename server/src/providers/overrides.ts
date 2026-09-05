/**
 * Lógica propia de los proveedores que no encajan del todo en el descriptor genérico.
 *
 * Todo lo que está aquí existe por una razón concreta y comprobada, no por gusto:
 * Groq es el único que informa de la cuota en cabeceras, y OpenRouter es el único con
 * un endpoint de cuenta que dice si estás en 50 o en 1000 peticiones al día.
 */

import { capabilitiesFor, isChatModel } from '../catalog/index.js';
import { splitCredential } from './generic.js';
import type { ModelInfo, Provider, QuotaLimits, RateLimitSnapshot, ValidationResult } from './types.js';

export const OVERRIDES: Record<string, (base: Provider) => Partial<Provider>> = {
  groq: () => ({ parseRateLimit: parseGroqRateLimit }),
  cloudflare: () => ({ listModels: listCloudflareModels, validateKey: validateCloudflareKey }),
  openrouter: (base) => ({
    accountInfo: (key) => openRouterAccountInfo(base.baseUrl, key),
    validateKey: (key) => validateOpenRouterKey(base, key),
  }),
};

// ------------------------------------------------------------------------------ Groq

function parseGroqRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limitRequests = num(headers.get('x-ratelimit-limit-requests'));
  const limitTokens = num(headers.get('x-ratelimit-limit-tokens'));
  if (limitRequests === null && limitTokens === null) return null;
  return {
    limitRequests,
    remainingRequests: num(headers.get('x-ratelimit-remaining-requests')),
    resetRequestsMs: duration(headers.get('x-ratelimit-reset-requests')),
    limitTokens,
    remainingTokens: num(headers.get('x-ratelimit-remaining-tokens')),
    resetTokensMs: duration(headers.get('x-ratelimit-reset-tokens')),
    // En Groq el cubo de peticiones es el diario (RPD) y el de tokens el por minuto (TPM).
    requestWindow: 'day',
  };
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Groq expresa los resets como duraciones tipo `2m59.56s`, `7.66s` o `1h2m3s`.
 * Devuelve milisegundos.
 */
export function duration(value: string | null): number | null {
  if (!value) return null;
  const matches = value.matchAll(/([\d.]+)(ms|h|m|s)/g);
  let total = 0;
  let found = false;
  for (const match of matches) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    found = true;
    switch (match[2]) {
      case 'ms': total += amount; break;
      case 's': total += amount * 1000; break;
      case 'm': total += amount * 60_000; break;
      case 'h': total += amount * 3_600_000; break;
    }
  }
  if (found) return Math.round(total);
  const plain = Number(value);
  return Number.isFinite(plain) ? plain * 1000 : null;
}

// ------------------------------------------------------------------------ Cloudflare

/**
 * Cloudflare no expone `/models` en su ruta compatible con OpenAI (devuelve 405): los
 * modelos se listan en `/ai/models/search`, con su propio formato y un filtro por
 * tarea. Además la credencial es «idDeCuenta:token», porque el id va dentro de la URL.
 */
interface CloudflareModel {
  name?: string;
  description?: string;
  task?: { name?: string };
  // Cloudflare devuelve los valores como cadena, número o booleano según la propiedad.
  properties?: Array<{ property_id?: string; value?: string | number | boolean }>;
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Tarea que identifica a los modelos de chat en el catálogo de Cloudflare. */
const TEXT_GENERATION = 'text generation';

async function listCloudflareModels(key: string): Promise<ModelInfo[]> {
  const { account, token } = splitCredential(key);
  if (!account || !token) {
    throw new Error('Cloudflare necesita «idDeCuenta:token». Pega los dos separados por dos puntos.');
  }

  const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(account)}/ai/models/search?per_page=200&hide_experimental=false`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Cloudflare /ai/models/search devolvió ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  const payload = (await res.json()) as { result?: CloudflareModel[]; success?: boolean };
  const models: ModelInfo[] = [];

  for (const raw of payload.result ?? []) {
    const id = raw.name;
    if (!id) continue;
    if ((raw.task?.name ?? '').toLowerCase() !== TEXT_GENERATION) continue;
    if (!isChatModel(id)) continue;

    const caps = capabilitiesFor('cloudflare', id);
    models.push({
      providerId: 'cloudflare',
      id,
      displayName: id,
      contextLength: readContext(raw) ?? caps?.context ?? 8192,
      maxCompletionTokens: null,
      inputModalities: caps?.input ?? ['text'],
      outputModalities: caps?.output ?? ['text'],
      supportsTools: hasProperty(raw, 'function_calling') ?? caps?.tools ?? false,
      qualityScore: null,
      qualitySource: null,
    });
  }
  return models;
}

/** Las capacidades de Cloudflare viajan en una lista de pares clave/valor. */
function property(model: CloudflareModel, id: string): string | number | boolean | undefined {
  return model.properties?.find((entry) => entry.property_id === id)?.value;
}

function readContext(model: CloudflareModel): number | null {
  for (const id of ['context_window', 'max_input_tokens', 'max_total_tokens']) {
    const value = Number(property(model, id));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function hasProperty(model: CloudflareModel, id: string): boolean | null {
  const value = property(model, id);
  if (value === undefined) return null;
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function validateCloudflareKey(key: string): Promise<ValidationResult> {
  try {
    const models = await listCloudflareModels(key);
    if (models.length === 0) {
      return { ok: false, error: 'La credencial funciona pero no se ve ningún modelo de generación de texto.' };
    }
    return {
      ok: true,
      models,
      notes: [
        `${models.length} modelos de generación de texto disponibles.`,
        'La cuota gratuita son 10.000 neuronas al día, que se reinician a las 00:00 UTC. Cloudflare no expresa el límite en peticiones, así que el router usa una estimación conservadora por minuto.',
      ],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------------ OpenRouter

export interface OpenRouterKeyInfo {
  label?: string;
  limit?: number | null;
  usage?: number;
  is_free_tier?: boolean;
  /** Deprecado por OpenRouter; se conserva solo para mostrarlo en el diagnóstico. */
  rate_limit?: { requests?: number; interval?: string; note?: string };
}

/** Tope de peticiones por minuto sobre modelos gratuitos, documentado por OpenRouter. */
const FREE_RPM_CAP = 20;

/**
 * Traduce lo que devuelve `GET /api/v1/key` a nuestros límites.
 * Es la fuente de verdad sobre si la cuenta está en 50/día o en 1000/día.
 *
 * El campo `rate_limit` NO se usa: OpenRouter lo marca como deprecado en la propia
 * respuesta y hoy llega con `requests: -1`. Derivar un rpm de ahí producía un límite
 * de 1 petición por minuto que parecía legítimo pero estrangulaba al proveedor.
 */
export function limitsFromKeyInfo(info: OpenRouterKeyInfo): QuotaLimits {
  const rpd = info.is_free_tier === false ? 1000 : 50;
  return { rpm: FREE_RPM_CAP, tpm: null, rpd, tpd: null };
}

async function fetchKeyInfo(baseUrl: string, key: string): Promise<Response> {
  return fetch(`${baseUrl}/key`, { headers: { authorization: `Bearer ${key}` } });
}

async function openRouterAccountInfo(baseUrl: string, key: string): Promise<Record<string, unknown>> {
  const res = await fetchKeyInfo(baseUrl, key);
  if (!res.ok) throw new Error(`OpenRouter /key devolvió ${res.status}`);
  const payload = (await res.json()) as { data?: OpenRouterKeyInfo };
  const info = payload.data ?? {};
  return { raw: info, derived: limitsFromKeyInfo(info) };
}

async function validateOpenRouterKey(base: Provider, key: string): Promise<ValidationResult> {
  try {
    const res = await fetchKeyInfo(base.baseUrl, key);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Clave rechazada por OpenRouter (401/403).' };
    }
    if (!res.ok) return { ok: false, error: `OpenRouter /key devolvió ${res.status}.` };

    const payload = (await res.json()) as { data?: OpenRouterKeyInfo };
    const info = payload.data ?? {};
    const models = await base.listModels(key);
    const limits = limitsFromKeyInfo(info);

    return {
      ok: true,
      models,
      limits,
      notes: [
        `${models.length} modelos gratuitos disponibles.`,
        info.is_free_tier === false
          ? 'Cuota diaria: 1000 peticiones. Tu cuenta ya superó los 10 $ de crédito acumulado, que es lo que desbloquea este límite; el valor por defecto son 50/día.'
          : 'Cuota diaria: 50 peticiones, que es el valor por defecto. Sube a 1000/día de forma permanente en cuanto la cuenta compre 10 $ de crédito, aunque luego lo gastes.',
        'Ojo: en OpenRouter las peticiones fallidas también gastan cuota diaria, por eso se usa como última opción.',
      ],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
