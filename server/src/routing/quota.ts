/**
 * Control de cuota. Es la pieza que justifica el proyecto entero: en vez de comerse
 * un 429 y reintentar, un candidato sin cuota **no llega a entrar en la selección**.
 *
 * Dos capas:
 *   1. Ventana deslizante en memoria para RPM y TPM.
 *   2. Contadores diarios en SQLite para RPD y TPD, que sobreviven a reinicios.
 *      Sin esto, reiniciar el servidor regalaría cuota ya gastada — y con las 50
 *      peticiones/día de OpenRouter eso se nota enseguida.
 *
 * Los límites del catálogo son solo la semilla: `applySnapshot` los sustituye por lo
 * que el proveedor diga en sus cabeceras.
 */

import { limitsFor } from '../catalog/index.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderId, QuotaLimits, RateLimitSnapshot } from '../providers/types.js';
import { bumpDailyUsage, getDailyUsage, getProviderDailyUsage, listProviderKeys } from '../store.js';

const MINUTE_MS = 60_000;

interface Sample {
  at: number;
  tokens: number;
}

/** Ventana deslizante de un minuto: peticiones y tokens. */
class MinuteWindow {
  private samples: Sample[] = [];

  private trim(now: number): void {
    const cutoff = now - MINUTE_MS;
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.at <= cutoff) i += 1;
    if (i > 0) this.samples = this.samples.slice(i);
  }

  add(tokens: number, now = Date.now()): void {
    this.trim(now);
    this.samples.push({ at: now, tokens });
  }

  /** Corrige los tokens de la última muestra cuando llega el uso real. */
  adjustLast(deltaTokens: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last) last.tokens = Math.max(0, last.tokens + deltaTokens);
  }

  requests(now = Date.now()): number {
    this.trim(now);
    return this.samples.length;
  }

  tokens(now = Date.now()): number {
    this.trim(now);
    return this.samples.reduce((sum, sample) => sum + sample.tokens, 0);
  }

  /** Milisegundos hasta que la muestra más antigua salga de la ventana. */
  msUntilSlot(now = Date.now()): number {
    this.trim(now);
    const oldest = this.samples[0];
    return oldest ? Math.max(0, oldest.at + MINUTE_MS - now) : 0;
  }
}

const windows = new Map<string, MinuteWindow>();
/** Límites aprendidos de las cabeceras del proveedor: pisan a los del catálogo. */
const learned = new Map<string, Partial<QuotaLimits>>();
/** Cuarentenas por 429, con el instante en el que expiran. */
const cooldowns = new Map<string, number>();

/**
 * Cuántos 429 seguidos lleva cada modelo. Se borra en cuanto uno responde bien.
 *
 * Sirve para distinguir dos cosas que el propio 429 no distingue: un pico momentáneo
 * —un modelo `:free` congestionado a la hora punta, que en un minuto vuelve— de un cubo
 * agotado de verdad, que va a seguir agotado un buen rato. Reintentar cada minuto el
 * segundo caso es lo que hace daño: cada intento cuesta tiempo y, en OpenRouter, una de
 * las 50 peticiones diarias, porque allí las fallidas también cuentan.
 */
const rateLimitStreaks = new Map<string, number>();

/** Primer castigo tras un 429 sin `retry-after`. */
const RATE_LIMIT_BASE_MS = MINUTE_MS;

/** Tope del castigo. Más allá, un modelo que se recuperó tardaría demasiado en volver. */
const RATE_LIMIT_MAX_MS = 6 * 60 * 60 * 1000;

function bucketKey(providerId: ProviderId, modelId: string): string {
  // En OpenRouter todos los modelos comparten el cubo de la cuenta.
  return getProvider(providerId)?.quotaScope === 'account' ? providerId : `${providerId}:${modelId}`;
}

function windowFor(key: string): MinuteWindow {
  let window = windows.get(key);
  if (!window) {
    window = new MinuteWindow();
    windows.set(key, window);
  }
  return window;
}

/** Límites efectivos: catálogo → clave guardada → lo aprendido de las cabeceras. */
export function effectiveLimits(providerId: ProviderId, modelId: string): QuotaLimits {
  const provider = getProvider(providerId);
  const base = limitsFor(providerId, modelId, provider?.defaultLimits ?? { rpm: null, tpm: null, rpd: null, tpd: null });
  const stored = listProviderKeys().find((key) => key.providerId === providerId)?.limits;
  const learnedLimits = learned.get(bucketKey(providerId, modelId));
  return {
    ...base,
    ...(stored ?? {}),
    ...(learnedLimits ?? {}),
  };
}

export interface QuotaVerdict {
  ok: boolean;
  /** Motivo legible cuando no hay cuota; se enseña en el 503 y en el panel. */
  reason?: string;
  /** Milisegundos estimados hasta que vuelva a haber hueco. */
  retryInMs?: number;
}

/**
 * ¿Se puede servir una petición de ~`estimatedTokens` con este modelo ahora?
 * No modifica nada: `reserve` es lo que consume.
 */
export function checkQuota(providerId: ProviderId, modelId: string, estimatedTokens: number): QuotaVerdict {
  const key = bucketKey(providerId, modelId);
  const now = Date.now();

  const cooldownUntil = cooldowns.get(key);
  if (cooldownUntil && cooldownUntil > now) {
    return { ok: false, reason: 'en espera tras un 429', retryInMs: cooldownUntil - now };
  }

  const limits = effectiveLimits(providerId, modelId);
  const window = windowFor(key);

  if (limits.rpm !== null && window.requests(now) >= limits.rpm) {
    return { ok: false, reason: `límite por minuto alcanzado (${limits.rpm} rpm)`, retryInMs: window.msUntilSlot(now) };
  }
  if (limits.tpm !== null && window.tokens(now) + estimatedTokens > limits.tpm) {
    return { ok: false, reason: `límite de tokens por minuto alcanzado (${limits.tpm} tpm)`, retryInMs: window.msUntilSlot(now) };
  }

  const daily = dailyUsageFor(providerId, modelId);
  if (limits.rpd !== null && daily.requests >= limits.rpd) {
    return { ok: false, reason: `cuota diaria agotada (${daily.requests}/${limits.rpd} peticiones)`, retryInMs: msUntilUtcMidnight(now) };
  }
  if (limits.tpd !== null && daily.tokens + estimatedTokens > limits.tpd) {
    return { ok: false, reason: `tokens diarios agotados (${daily.tokens}/${limits.tpd})`, retryInMs: msUntilUtcMidnight(now) };
  }

  return { ok: true };
}

function dailyUsageFor(providerId: ProviderId, modelId: string): { requests: number; tokens: number } {
  return getProvider(providerId)?.quotaScope === 'account'
    ? getProviderDailyUsage(providerId)
    : getDailyUsage(providerId, modelId);
}

/**
 * Consume cuota ANTES de llamar al proveedor. Es deliberado: si la petición falla, la
 * cuota se ha gastado igualmente (en OpenRouter literalmente, y en los demás la
 * petición sí llegó a salir), así que contarla por adelantado es lo correcto y además
 * evita que dos peticiones concurrentes pasen a la vez el mismo hueco.
 */
export function reserve(providerId: ProviderId, modelId: string, estimatedTokens: number): void {
  windowFor(bucketKey(providerId, modelId)).add(estimatedTokens);
  bumpDailyUsage(providerId, modelId, 1, estimatedTokens);
}

/** Corrige la reserva con el consumo real una vez terminada la petición. */
export function settle(providerId: ProviderId, modelId: string, estimatedTokens: number, actualTokens: number): void {
  const delta = actualTokens - estimatedTokens;
  if (delta === 0) return;
  windowFor(bucketKey(providerId, modelId)).adjustLast(delta);
  bumpDailyUsage(providerId, modelId, 0, delta);
}

/**
 * Aprende de las cabeceras del proveedor. Groq manda cuánto le queda de verdad, así
 * que si nuestro contador va más optimista que el suyo, gana el suyo.
 */
export function applySnapshot(providerId: ProviderId, modelId: string, snapshot: RateLimitSnapshot | null): void {
  if (!snapshot) return;
  const key = bucketKey(providerId, modelId);
  const update: Partial<QuotaLimits> = { ...(learned.get(key) ?? {}) };

  if (snapshot.limitRequests !== null) {
    if (snapshot.requestWindow === 'day') update.rpd = snapshot.limitRequests;
    else if (snapshot.requestWindow === 'minute') update.rpm = snapshot.limitRequests;
  }
  if (snapshot.limitTokens !== null) update.tpm = snapshot.limitTokens;
  learned.set(key, update);

  // Si el proveedor dice que quedan menos peticiones de las que creemos haber gastado,
  // ajustamos el contador diario a su versión.
  if (snapshot.requestWindow === 'day' && snapshot.limitRequests !== null && snapshot.remainingRequests !== null) {
    const providerUsed = snapshot.limitRequests - snapshot.remainingRequests;
    const ourUsed = dailyUsageFor(providerId, modelId).requests;
    if (providerUsed > ourUsed) {
      bumpDailyUsage(providerId, modelId, providerUsed - ourUsed, 0);
    }
  }
}

/** Marca una espera tras un 429. Sin `retryAfterMs` usa un minuto por defecto. */
/**
 * Aparta un modelo tras un 429, con castigo creciente.
 *
 * El primero cuesta un minuto —cuatro en OpenRouter, ver `rateLimitPenaltyFactor`—; si
 * al volver se repite, se dobla, y así hasta el tope.
 * Un castigo fijo no sirve para los dos casos que existen: con uno corto, un modelo
 * agotado de verdad se reintenta sin parar; con uno largo, un pico de un minuto te deja
 * sin el mejor modelo durante horas. Doblar empieza barato y se pone caro solo con quien
 * demuestra estarlo.
 *
 * Nunca se castiga más allá del reinicio diario: pasada esa hora la cuota vuelve sola y
 * seguir apartándolo sería tirar un modelo que ya funciona.
 */
export function penalize(providerId: ProviderId, modelId: string, retryAfterMs: number | null): void {
  const key = bucketKey(providerId, modelId);
  const streak = (rateLimitStreaks.get(key) ?? 0) + 1;
  rateLimitStreaks.set(key, streak);

  // Si el proveedor dice cuándo volver, sabe más que nosotros y manda su cifra.
  if (retryAfterMs && retryAfterMs > 0) {
    cooldowns.set(key, Date.now() + Math.min(retryAfterMs, RATE_LIMIT_MAX_MS));
    return;
  }

  // Hay proveedores donde equivocarse sale más caro y el castigo se multiplica: en
  // OpenRouter un fallo tarda siete veces más que en Groq y encima gasta una de las 50
  // peticiones diarias, porque allí las fallidas también cuentan.
  const factor = getProvider(providerId)?.rateLimitPenaltyFactor ?? 1;
  const escalated = Math.min(RATE_LIMIT_BASE_MS * factor * 2 ** (streak - 1), RATE_LIMIT_MAX_MS);
  cooldowns.set(key, Date.now() + Math.min(escalated, msUntilUtcMidnight()));
}

/**
 * Una petición que sale bien borra la racha: el modelo ha demostrado que vuelve a
 * servir, así que el próximo 429 debe volver a costar un minuto y no lo que llevara
 * acumulado.
 */
export function clearRateLimitStreak(providerId: ProviderId, modelId: string): void {
  rateLimitStreaks.delete(bucketKey(providerId, modelId));
}

export function msUntilUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/** Foto del estado de cuota, para el panel. */
export interface QuotaStatus {
  limits: QuotaLimits;
  minuteRequests: number;
  minuteTokens: number;
  dailyRequests: number;
  dailyTokens: number;
  cooldownMs: number;
}

export function quotaStatus(providerId: ProviderId, modelId: string): QuotaStatus {
  const key = bucketKey(providerId, modelId);
  const window = windowFor(key);
  const daily = dailyUsageFor(providerId, modelId);
  const cooldownUntil = cooldowns.get(key) ?? 0;
  return {
    limits: effectiveLimits(providerId, modelId),
    minuteRequests: window.requests(),
    minuteTokens: window.tokens(),
    dailyRequests: daily.requests,
    dailyTokens: daily.tokens,
    cooldownMs: Math.max(0, cooldownUntil - Date.now()),
  };
}

/** Solo para tests. */
export function resetQuotaState(): void {
  windows.clear();
  learned.clear();
  cooldowns.clear();
  rateLimitStreaks.clear();
}
