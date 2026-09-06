/** Acceso a datos. Todo el SQL vive aquí; el resto del servidor trabaja con objetos. */

import { createHash, randomUUID } from 'node:crypto';
import { getDb, utcDay } from './db.js';
import { decrypt, encrypt, last4 } from './crypto.js';
import type { Capability, ModelInfo, ProviderId, QualitySource, QuotaLimits } from './providers/types.js';

// ---------------------------------------------------------------- claves de proveedor

export interface ProviderKeyRecord {
  providerId: ProviderId;
  last4: string;
  addedAt: string;
  status: 'active' | 'invalid';
  lastError: string | null;
  limits: QuotaLimits | null;
}

export function saveProviderKey(providerId: ProviderId, apiKey: string, limits: QuotaLimits | null): void {
  getDb()
    .prepare(
      `INSERT INTO provider_keys (provider_id, encrypted_key, last4, added_at, status, last_error, limits_json)
       VALUES (?, ?, ?, ?, 'active', NULL, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         encrypted_key = excluded.encrypted_key,
         last4 = excluded.last4,
         added_at = excluded.added_at,
         status = 'active',
         last_error = NULL,
         limits_json = excluded.limits_json`,
    )
    .run(providerId, encrypt(apiKey), last4(apiKey), new Date().toISOString(), limits ? JSON.stringify(limits) : null);
}

/** Devuelve la clave en claro. Nunca debe cruzar el límite del proceso. */
export function getProviderKeySecret(providerId: ProviderId): string | null {
  const row = getDb()
    .prepare('SELECT encrypted_key FROM provider_keys WHERE provider_id = ? AND status = ?')
    .get(providerId, 'active') as { encrypted_key: string } | undefined;
  return row ? decrypt(row.encrypted_key) : null;
}

export function listProviderKeys(): ProviderKeyRecord[] {
  const rows = getDb().prepare('SELECT * FROM provider_keys ORDER BY provider_id').all() as Array<{
    provider_id: string;
    last4: string;
    added_at: string;
    status: string;
    last_error: string | null;
    limits_json: string | null;
  }>;
  return rows.map((row) => ({
    providerId: row.provider_id as ProviderId,
    last4: row.last4,
    addedAt: row.added_at,
    status: row.status === 'invalid' ? 'invalid' : 'active',
    lastError: row.last_error,
    limits: row.limits_json ? (JSON.parse(row.limits_json) as QuotaLimits) : null,
  }));
}

/**
 * Actualiza los límites de un proveedor sin tocar la clave. Los planes cambian —en
 * OpenRouter la cuota diaria pasa de 50 a 1000 al acumular 10$ de crédito— así que
 * refrescar debe poder corregirlos.
 */
export function updateProviderLimits(providerId: ProviderId, limits: QuotaLimits): void {
  getDb()
    .prepare('UPDATE provider_keys SET limits_json = ? WHERE provider_id = ?')
    .run(JSON.stringify(limits), providerId);
}

export function markProviderKeyInvalid(providerId: ProviderId, error: string): void {
  getDb()
    .prepare("UPDATE provider_keys SET status = 'invalid', last_error = ? WHERE provider_id = ?")
    .run(error, providerId);
}

export function deleteProviderKey(providerId: ProviderId): void {
  getDb().prepare('DELETE FROM provider_keys WHERE provider_id = ?').run(providerId);
}

// ---------------------------------------------------------------------------- modelos

/** Reemplaza el catálogo de modelos de un proveedor, conservando el flag `enabled`. */
export function replaceModels(providerId: ProviderId, models: ModelInfo[]): void {
  const db = getDb();
  const disabled = new Set(
    (
      db.prepare('SELECT model_id FROM models WHERE provider_id = ? AND enabled = 0').all(providerId) as Array<{
        model_id: string;
      }>
    ).map((row) => row.model_id),
  );

  const wipe = db.prepare('DELETE FROM models WHERE provider_id = ?');
  const insert = db.prepare(
    `INSERT INTO models (provider_id, model_id, display_name, context_length, max_completion_tokens,
                         input_modalities, output_modalities, supports_tools, quality_score, quality_source,
                         requires_identified_account, enabled, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    wipe.run(providerId);
    const now = new Date().toISOString();
    for (const model of models) {
      insert.run(
        model.providerId,
        model.id,
        model.displayName,
        model.contextLength,
        model.maxCompletionTokens,
        JSON.stringify(model.inputModalities),
        JSON.stringify(model.outputModalities),
        model.supportsTools ? 1 : 0,
        model.qualityScore,
        model.qualitySource,
        model.requiresIdentifiedAccount ? 1 : 0,
        disabled.has(model.id) ? 0 : 1,
        now,
      );
    }
  })();
}

export interface StoredModel extends ModelInfo {
  enabled: boolean;
  /**
   * El proveedor rechazó servir este modelo troceado. Se aprende del primer rechazo
   * para no volver a pedírselo: la medición del TTFT es un extra y nunca debe costar
   * una petición fallida.
   */
  streamingUnsupported: boolean;
}

const ENABLED_MODELS_SQL = `
  SELECT m.* FROM models m
  JOIN provider_keys k ON k.provider_id = m.provider_id AND k.status = 'active'
  WHERE m.enabled = 1`;

export function listModels(onlyEnabled = true): StoredModel[] {
  const sql = onlyEnabled ? ENABLED_MODELS_SQL : 'SELECT m.* FROM models m';
  const rows = getDb().prepare(sql).all() as Array<Record<string, unknown>>;
  return rows.map(rowToModel);
}

function rowToModel(row: Record<string, unknown>): StoredModel {
  return {
    providerId: row.provider_id as ProviderId,
    id: row.model_id as string,
    displayName: row.display_name as string,
    contextLength: row.context_length as number,
    maxCompletionTokens: (row.max_completion_tokens as number | null) ?? null,
    inputModalities: JSON.parse(row.input_modalities as string),
    outputModalities: JSON.parse(row.output_modalities as string),
    supportsTools: row.supports_tools === 1,
    qualityScore: (row.quality_score as number | null) ?? null,
    qualitySource: (row.quality_source as QualitySource | null) ?? null,
    requiresIdentifiedAccount: row.requires_identified_account === 1,
    streamingUnsupported: row.streaming_unsupported === 1,
    enabled: row.enabled === 1,
  };
}

/**
 * Deja constancia de que un modelo no admite streaming.
 *
 * No desactiva nada: el modelo sigue siendo perfectamente utilizable, solo que se le
 * pedirá la respuesta de una pieza y por tanto no tendrá TTFT.
 */
export function markStreamingUnsupported(providerId: ProviderId, modelId: string): void {
  getDb()
    .prepare('UPDATE models SET streaming_unsupported = 1 WHERE provider_id = ? AND model_id = ?')
    .run(providerId, modelId);
}

export function setModelEnabled(providerId: ProviderId, modelId: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE models SET enabled = ? WHERE provider_id = ? AND model_id = ?')
    .run(enabled ? 1 : 0, providerId, modelId);
}

/**
 * Aparta los modelos que el proveedor anuncia pero no sirve.
 *
 * Se ejecuta al arrancar para recoger los que quedaron en cuarentena antes de que
 * `model_not_found` pasara a apartarlos: reintentarlos cada cuarto de hora no los
 * resucita, solo gasta cuota. Es idempotente.
 */
export function retireMissingModels(): number {
  const result = getDb()
    .prepare(
      `UPDATE models SET enabled = 0
       WHERE enabled = 1
         AND (provider_id, model_id) IN (
           SELECT provider_id, model_id FROM health WHERE last_error LIKE 'model_not_found:%'
         )`,
    )
    .run();
  if (result.changes > 0) {
    getDb()
      .prepare("UPDATE health SET quarantined_until = NULL WHERE last_error LIKE 'model_not_found:%'")
      .run();
  }
  return result.changes;
}

/**
 * Reduce la ventana de contexto registrada de un modelo. Se llama cuando el proveedor
 * rechaza una petición por contexto excedido: así el catálogo se corrige solo en los
 * proveedores que no publican el tamaño real (Cerebras).
 */
export function shrinkContextLength(providerId: ProviderId, modelId: string, newLength: number): void {
  getDb()
    .prepare('UPDATE models SET context_length = ? WHERE provider_id = ? AND model_id = ? AND context_length > ?')
    .run(newLength, providerId, modelId, newLength);
}

// --------------------------------------------------------------- API keys de FreeRouter

export type Profile = 'rapido' | 'balanceado' | 'calidad';

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  name: string;
  profile: Profile;
  capabilities: Capability[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export function hashApiKey(key: string): string {
  // Las API keys son 24 bytes aleatorios: un hash rápido basta, porque no hay
  // diccionario posible contra el que defenderse.
  return createHash('sha256').update(key).digest('hex');
}

export function createApiKey(
  name: string,
  profile: Profile,
  capabilities: Capability[],
  plaintext: string,
): ApiKeyRecord {
  const record: ApiKeyRecord = {
    id: randomUUID(),
    prefix: plaintext.slice(0, 11),
    name,
    profile,
    capabilities,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
  };
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, key_hash, prefix, name, profile, capabilities, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      hashApiKey(plaintext),
      record.prefix,
      name,
      profile,
      JSON.stringify(capabilities),
      record.createdAt,
    );
  return record;
}

export function findApiKey(plaintext: string): ApiKeyRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0')
    .get(hashApiKey(plaintext)) as Record<string, unknown> | undefined;
  return row ? rowToApiKey(row) : null;
}

export function listApiKeys(): ApiKeyRecord[] {
  const rows = getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToApiKey);
}

export function revokeApiKey(id: string): void {
  getDb().prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
}

export function touchApiKey(id: string): void {
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    prefix: row.prefix as string,
    name: row.name as string,
    profile: row.profile as Profile,
    capabilities: JSON.parse(row.capabilities as string),
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revoked: row.revoked === 1,
  };
}

// ----------------------------------------------------------------------- consumo diario

export interface DailyUsage {
  requests: number;
  tokens: number;
}

export function bumpDailyUsage(providerId: ProviderId, modelId: string, requests: number, tokens: number): void {
  getDb()
    .prepare(
      `INSERT INTO daily_usage (provider_id, model_id, day, requests, tokens)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, model_id, day) DO UPDATE SET
         requests = requests + excluded.requests,
         tokens = tokens + excluded.tokens`,
    )
    .run(providerId, modelId, utcDay(), requests, tokens);
}

export function getDailyUsage(providerId: ProviderId, modelId: string): DailyUsage {
  const row = getDb()
    .prepare('SELECT requests, tokens FROM daily_usage WHERE provider_id = ? AND model_id = ? AND day = ?')
    .get(providerId, modelId, utcDay()) as DailyUsage | undefined;
  return row ?? { requests: 0, tokens: 0 };
}

/** Consumo diario agregado por proveedor (OpenRouter limita por cuenta, no por modelo). */
export function getProviderDailyUsage(providerId: ProviderId): DailyUsage {
  return getDb()
    .prepare(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens
       FROM daily_usage WHERE provider_id = ? AND day = ?`,
    )
    .get(providerId, utcDay()) as DailyUsage;
}

/** Borra el consumo de días pasados; se llama al arrancar. */
export function pruneOldUsage(): void {
  getDb().prepare('DELETE FROM daily_usage WHERE day < ?').run(utcDay());
}

// -------------------------------------------------------------------------- registro

/** Tope de texto guardado por petición. Acota el crecimiento de la base de datos. */
export const LOG_TEXT_LIMIT = 4000;
/** Peticiones que se conservan en el historial. */
const LOG_KEEP = 500;

/**
 * Un intento contra un modelo concreto, con lo que costó.
 *
 * El historial guardaba solo cuántos intentos hubo. Saber *quién* falló y *cuánto* tardó
 * en fallar es lo que permite entender un TTFT alto: el tiempo perdido antes del modelo
 * que acabó respondiendo no aparece en ninguna otra métrica.
 */
export interface AttemptDetail {
  providerId: string;
  modelId: string;
  ok: boolean;
  /** Duración del intento. En el que respondió, el total de la petición. */
  ms: number;
  /** Solo del que respondió: cuánto tardó en llegar el primer token. */
  ttftMs: number | null;
  errorKind: string | null;
  message: string | null;
}

export interface LogEntry {
  apiKeyId: string | null;
  providerId: ProviderId | null;
  modelId: string | null;
  profile: string | null;
  ok: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  errorKind: string | null;
  attempts: number;
  /** Tokens por segundo de esta petición concreta. */
  tps: number | null;
  /** Texto enviado y recibido. `null` si el registro de contenido está desactivado. */
  prompt: string | null;
  response: string | null;
  /** A quién se intentó y con qué resultado, en orden. */
  timeline: AttemptDetail[];
  /** Tiempo gastado dentro de FreeRouter, sin contar la espera a los proveedores. */
  routerMs: number | null;
}

export function logRequest(entry: LogEntry): void {
  getDb()
    .prepare(
      `INSERT INTO request_log (ts, api_key_id, provider_id, model_id, profile, ok, ttft_ms, total_ms, tokens_in, tokens_out, error_kind, attempts, tps, prompt, response, attempts_detail, router_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      entry.apiKeyId,
      entry.providerId,
      entry.modelId,
      entry.profile,
      entry.ok ? 1 : 0,
      entry.ttftMs,
      entry.totalMs,
      entry.tokensIn,
      entry.tokensOut,
      entry.errorKind,
      entry.attempts,
      entry.tps,
      truncate(entry.prompt),
      truncate(entry.response),
      entry.timeline.length > 0 ? JSON.stringify(entry.timeline) : null,
      entry.routerMs,
    );
  pruneRequestLog();
}

function truncate(text: string | null): string | null {
  if (text === null) return null;
  return text.length > LOG_TEXT_LIMIT ? `${text.slice(0, LOG_TEXT_LIMIT)}
… (recortado)` : text;
}

/** El historial no crece sin fin: se conservan las últimas `LOG_KEEP` peticiones. */
function pruneRequestLog(): void {
  getDb()
    .prepare('DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?')
    .run(LOG_KEEP);
}

/**
 * Historial reciente sin los textos: la lista del panel no necesita cargarlos, y son
 * con diferencia lo más pesado de cada fila.
 */
export function recentRequests(limit = 50): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT r.id, r.ts, r.provider_id, r.model_id, r.profile, r.ok, r.ttft_ms, r.total_ms,
              r.tokens_in, r.tokens_out, r.error_kind, r.attempts, r.tps,
              k.name AS api_key_name,
              (r.prompt IS NOT NULL OR r.response IS NOT NULL) AS has_content
       FROM request_log r
       LEFT JOIN api_keys k ON k.id = r.api_key_id
       ORDER BY r.id DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}

/** Borra los textos guardados sin perder las métricas del historial. */
export function clearRequestContent(): void {
  getDb().prepare('UPDATE request_log SET prompt = NULL, response = NULL').run();
}

/** Prompt y respuesta de una petición concreta, para el desplegable del panel. */
export interface RequestDetail {
  prompt: string | null;
  response: string | null;
  timeline: AttemptDetail[];
  /** Tiempo gastado decidiendo, frente al que se fue esperando a los proveedores. */
  routerMs: number | null;
}

export function requestDetail(id: number): RequestDetail | null {
  const row = getDb()
    .prepare('SELECT prompt, response, attempts_detail, router_ms FROM request_log WHERE id = ?')
    .get(id) as
    | { prompt: string | null; response: string | null; attempts_detail: string | null; router_ms: number | null }
    | undefined;
  if (!row) return null;
  return {
    prompt: row.prompt,
    response: row.response,
    timeline: parseTimeline(row.attempts_detail),
    routerMs: row.router_ms,
  };
}

/** Las peticiones anteriores a esta función no tienen cronología; devuelven una vacía. */
function parseTimeline(raw: string | null): AttemptDetail[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AttemptDetail[]) : [];
  } catch {
    return [];
  }
}
