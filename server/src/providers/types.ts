/**
 * Contrato de proveedor.
 *
 * Los tres proveedores iniciales (Groq, Cerebras, OpenRouter) exponen una API
 * compatible con OpenAI, así que un proveedor no implementa su propio HTTP: es un
 * descriptor con los datos que lo diferencian (URL, auth, cabeceras de rate limit,
 * descubrimiento de modelos). La llamada real la hace `callChat` en `chat.ts`.
 *
 * Añadir un cuarto proveedor compatible con OpenAI = escribir un descriptor.
 */

import type { QualitySource } from '../catalog/index.js';

/**
 * Identificador de proveedor. Es un `string` y no una unión cerrada porque los
 * proveedores se cargan desde `catalog/providers.json`: añadir uno no debe obligar a
 * tocar tipos. La validación se hace en runtime con `isProviderId`.
 */
export type ProviderId = string;

export type { QualitySource };

export type InputModality = 'text' | 'image' | 'audio' | 'video';
export type OutputModality = 'text' | 'image' | 'audio';

/** Capacidades que el usuario puede exigir al crear una API key. */
export type Capability = 'vision' | 'audio' | 'tools' | 'long_context' | 'image_output';

/** Umbral (en tokens) a partir del cual consideramos que un modelo es de "contexto largo". */
export const LONG_CONTEXT_THRESHOLD = 128_000;

export interface ModelInfo {
  providerId: ProviderId;
  /** Id tal y como lo espera el proveedor en el campo `model`. */
  id: string;
  displayName: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  inputModalities: InputModality[];
  outputModalities: OutputModality[];
  supportsTools: boolean;
/**
   * Intelligence Index de Artificial Analysis. `null` solo mientras el adaptador no
   * lo ha resuelto todavía; el registry lo rellena antes de guardarlo.
   */
  qualityScore: number | null;
  /**
   * De dónde sale esa puntuación: `measured` es un valor real del índice,
   * `estimated` una heurística por familia de modelo. El panel lo distingue para
   * que no parezca un dato medido cuando no lo es.
   */
  qualitySource: QualitySource | null;
  /**
   * El proveedor marca este modelo como reservado a cuentas identificadas o con saldo.
   * Se usa para NO elegirlo al validar una clave: si se prueba con uno de estos, una
   * cuenta sin saldo se rechaza entera aunque sus modelos gratuitos funcionen.
   */
  requiresIdentifiedAccount?: boolean;
}

/** Límites de cuota de un par (proveedor, modelo). `null` = sin límite conocido. */
export interface QuotaLimits {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  tpd: number | null;
}

/**
 * Lo que el proveedor nos cuenta sobre nuestra cuota en una respuesta concreta.
 * Se usa para auto-corregir los límites estimados del catálogo: manda la verdad
 * del proveedor, no nuestro JSON.
 */
export interface RateLimitSnapshot {
  limitRequests: number | null;
  remainingRequests: number | null;
  resetRequestsMs: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
  resetTokensMs: number | null;
  /** Ventana a la que aplican los contadores de peticiones. */
  requestWindow: 'minute' | 'day' | null;
}

export type ErrorKind =
  | 'rate_limit'
  | 'auth'
  /** 402: la cuenta no puede servir (trial agotado, requiere pago). */
  | 'payment_required'
  | 'server'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'context_length'
  | 'model_not_found';

/**
 * ¿Tiene sentido probar con el SIGUIENTE candidato tras este error?
 *
 * Siempre. Un 402 de una cuenta, un 401 de un modelo restringido o un 429 no dicen nada
 * sobre los demás candidatos, y `context_length` continúa porque el siguiente puede
 * tener una ventana más grande.
 *
 * `bad_request` también continúa, aunque en teoría un 400 sea culpa de la petición. En
 * la práctica no lo es: OpenCode devuelve 400 con «Upstream request failed: Model is
 * unavailable», que es un problema suyo disfrazado de error del cliente. Cortar la
 * cadena ahí le devolvía al cliente un fallo que otro proveedor habría atendido sin
 * problema.
 *
 * El coste de equivocarse es asimétrico. Si el 400 era de verdad culpa de la petición,
 * se gastan hasta tres llamadas más —la cadena está limitada a cuatro— y el cliente
 * acaba recibiendo el mismo error, que además se devuelve como 400 y no como 502 cuando
 * todos los candidatos coinciden en rechazarla. Si no lo era, se salva la petición.
 */
export function shouldTryNextCandidate(_kind: ErrorKind): boolean {
  return true;
}

export interface ValidationResult {
  ok: boolean;
  /** Mensaje legible para el panel cuando `ok` es false. */
  error?: string;
  /** Modelos descubiertos si la validación fue bien. */
  models?: ModelInfo[];
  /** Datos extra a mostrar en el onboarding (p. ej. la cuota diaria de OpenRouter). */
  notes?: string[];
  /** Límites reales leídos de la cuenta, si el proveedor los expone. Pisan al catálogo. */
  limits?: QuotaLimits;
}

/**
 * Cómo de gratuito es el proveedor. Importa porque el objetivo del proyecto es no
 * pagar: un proveedor cuyo tier gratuito ha desaparecido debe decirlo, no aparecer
 * como uno más.
 */
export interface FreeTierInfo {
  /** `true` si la cuota gratuita se renueva sola; `false` si es un crédito que se agota. */
  renewing: boolean;
  note: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  freeTier: FreeTierInfo;
  /** Base OpenAI-compatible, sin barra final. `${baseUrl}/chat/completions` debe ser válido. */
  baseUrl: string;
  /**
   * URL real para una credencial concreta. Existe porque Cloudflare mete el id de
   * cuenta dentro de la ruta, así que su base no se puede fijar en el catálogo.
   * Cuando falta, se usa `baseUrl` tal cual.
   */
  resolveBaseUrl?(key: string): string;
  /** Pista del formato de clave, para el onboarding. */
  keyHint: string;
  /** Dónde consigue el usuario la clave. */
  consoleUrl: string;
  /**
   * Orden por defecto en la cadena de failover: menor = se intenta antes.
   * OpenRouter va al final porque su cuota diaria es diminuta y los fallos cuentan.
   */
  failoverRank: number;

  authHeaders(key: string): Record<string, string>;
  /** Cabeceras fijas adicionales (OpenRouter pide identificación de la app). */
  extraHeaders?: Record<string, string>;

  /** Descubre los modelos gratuitos utilizables con esta clave. */
  listModels(key: string): Promise<ModelInfo[]>;
  /** Valida la clave contra el proveedor real y devuelve los modelos. */
  validateKey(key: string): Promise<ValidationResult>;

  /** Lee las cabeceras de rate limit de una respuesta. `null` si el proveedor no las manda. */
  parseRateLimit(headers: Headers): RateLimitSnapshot | null;

  /**
   * Lo que el proveedor cuenta sobre la cuenta (cuota, tier). Sirve para explicar en el
   * panel de dónde salen los límites cuando no cuadran con lo esperado.
   */
  accountInfo?(key: string): Promise<Record<string, unknown>>;

  /** Límites por defecto cuando el catálogo no tiene una entrada específica del modelo. */
  defaultLimits: QuotaLimits;

  /**
   * A qué se aplican los límites: `model` = cada modelo tiene su propio cubo
   * (Groq, Cerebras); `account` = todos los modelos comparten el cubo de la cuenta
   * (OpenRouter). Cambia por completo cómo se contabiliza la cuota.
   */
  quotaScope: 'model' | 'account';
  /** Multiplica el castigo tras un 429. 1 salvo donde reintentar salga caro. */
  rateLimitPenaltyFactor: number;

  /** Ajustes del cuerpo antes de enviarlo (quirks del proveedor). */
  prepareBody?(body: Record<string, unknown>): Record<string, unknown>;
}
