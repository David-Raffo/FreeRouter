/**
 * Salud y velocidad de cada modelo.
 *
 * Se guardan dos métricas de velocidad y ambas cuentan al puntuar: **tok/s extremo a
 * extremo** (tokens entre el tiempo total, que es lo que domina en cuanto la respuesta
 * pasa de un par de frases) y **TTFT** (lo que tarda en arrancar). Las dos van en una
 * EWMA para que una petición lenta suelta no tumbe a un modelo bueno ni una rápida
 * rehabilite a uno malo.
 *
 * `tps` puede llegar como `null` —respuestas demasiado cortas para dar una tasa
 * estable— y en ese caso se conserva el valor anterior en vez de registrar ruido.
 *
 * Todo se persiste: al reiniciar, el router no arranca ciego.
 */

import { getDb } from '../db.js';
import { setModelEnabled } from '../store.js';
import type { ErrorKind, ProviderId } from '../providers/types.js';

/** Peso de la muestra nueva en la media exponencial. */
const ALPHA = 0.3;
const FAILURES_TO_QUARANTINE = 3;
/**
 * Fallos seguidos tras los que se aparta el modelo del enrutado.
 *
 * La cuarentena con backoff sirve para caídas pasajeras, pero llega un punto en que
 * insistir deja de tener sentido: a partir de aquí el modelo lleva más de media hora
 * fallando sin parar y cada reintento es cuota tirada. Vuelve si el usuario lo reactiva
 * o si el proveedor lo retira y lo vuelve a publicar.
 */
const FAILURES_TO_RETIRE = 8;
const BASE_QUARANTINE_MS = 30_000;
const MAX_QUARANTINE_MS = 15 * 60_000;

export interface HealthState {
  providerId: ProviderId;
  modelId: string;
  ttftMs: number | null;
  tps: number | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  quarantinedUntil: string | null;
  samples: number;
}

const EMPTY = (providerId: ProviderId, modelId: string): HealthState => ({
  providerId,
  modelId,
  ttftMs: null,
  tps: null,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  quarantinedUntil: null,
  samples: 0,
});

export function healthOf(providerId: ProviderId, modelId: string): HealthState {
  const row = getDb()
    .prepare('SELECT * FROM health WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as Record<string, unknown> | undefined;
  return row ? rowToHealth(row) : EMPTY(providerId, modelId);
}

export function allHealth(): HealthState[] {
  const rows = getDb().prepare('SELECT * FROM health').all() as Array<Record<string, unknown>>;
  return rows.map(rowToHealth);
}

function rowToHealth(row: Record<string, unknown>): HealthState {
  return {
    providerId: row.provider_id as ProviderId,
    modelId: row.model_id as string,
    ttftMs: (row.ttft_ewma_ms as number | null) ?? null,
    tps: (row.tps_ewma as number | null) ?? null,
    lastOkAt: (row.last_ok_at as string | null) ?? null,
    lastErrorAt: (row.last_error_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    quarantinedUntil: (row.quarantined_until as string | null) ?? null,
    samples: (row.samples as number) ?? 0,
  };
}

function upsert(state: HealthState): void {
  getDb()
    .prepare(
      `INSERT INTO health (provider_id, model_id, ttft_ewma_ms, tps_ewma, last_ok_at, last_error_at, last_error, consecutive_failures, quarantined_until, samples)
       VALUES (@providerId, @modelId, @ttftMs, @tps, @lastOkAt, @lastErrorAt, @lastError, @consecutiveFailures, @quarantinedUntil, @samples)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET
         ttft_ewma_ms = excluded.ttft_ewma_ms,
         tps_ewma = excluded.tps_ewma,
         last_ok_at = excluded.last_ok_at,
         last_error_at = excluded.last_error_at,
         last_error = excluded.last_error,
         consecutive_failures = excluded.consecutive_failures,
         quarantined_until = excluded.quarantined_until,
         samples = excluded.samples`,
    )
    .run(state);
}

function ewma(previous: number | null, sample: number): number {
  return previous === null ? sample : previous * (1 - ALPHA) + sample * ALPHA;
}

/**
 * Una petición que salió bien.
 *
 * `ttftMs` puede ser `null`: en una respuesta no troceada no existe el concepto de
 * primer token, y meter ahí el tiempo total inflaba la media hasta hacerla inservible
 * —una respuesta larga registraba «TTFT» de varios segundos—. Lo que no se sabe no se
 * apunta; el tok/s sí se aprovecha, que ese sí se conoce.
 */
export function recordSuccess(
  providerId: ProviderId,
  modelId: string,
  ttftMs: number | null,
  tps: number | null,
): void {
  const current = healthOf(providerId, modelId);
  upsert({
    ...current,
    ttftMs: ttftMs === null ? current.ttftMs : ewma(current.ttftMs, ttftMs),
    tps: tps === null ? current.tps : ewma(current.tps, tps),
    lastOkAt: new Date().toISOString(),
    consecutiveFailures: 0,
    quarantinedUntil: null,
    samples: current.samples + 1,
  });
}

/**
 * Un fallo. Los 429 no cuentan para el disyuntor: no significan que el modelo esté
 * roto, solo que no toca todavía — de eso ya se encarga la cuota.
 */
export function recordFailure(providerId: ProviderId, modelId: string, kind: ErrorKind, message: string): void {
  const current = healthOf(providerId, modelId);
  // `model_not_found` no entra en el ciclo de cuarentena: no es una avería pasajera
  // sino un modelo que el proveedor anuncia y no sirve, así que se aparta del catálogo
  // en `handleFailure` en vez de reintentarse con backoff para siempre.
  const countsAsBroken =
    kind !== 'rate_limit' && kind !== 'bad_request' && kind !== 'context_length' && kind !== 'model_not_found';
  const failures = countsAsBroken ? current.consecutiveFailures + 1 : current.consecutiveFailures;

  let quarantinedUntil = current.quarantinedUntil;
  if (countsAsBroken && failures >= FAILURES_TO_QUARANTINE) {
    // Backoff exponencial a partir del tercer fallo consecutivo.
    const extra = failures - FAILURES_TO_QUARANTINE;
    const wait = Math.min(BASE_QUARANTINE_MS * 2 ** extra, MAX_QUARANTINE_MS);
    quarantinedUntil = new Date(Date.now() + wait).toISOString();
  }

  upsert({
    ...current,
    lastErrorAt: new Date().toISOString(),
    lastError: `${kind}: ${message}`.slice(0, 300),
    consecutiveFailures: failures,
    quarantinedUntil,
  });

  if (countsAsBroken && failures >= FAILURES_TO_RETIRE) {
    setModelEnabled(providerId, modelId, false);
  }
}

export function isQuarantined(state: HealthState, now = Date.now()): boolean {
  if (!state.quarantinedUntil) return false;
  return Date.parse(state.quarantinedUntil) > now;
}

/** ¿Hace cuánto que no tenemos una medida de este modelo? `Infinity` si nunca. */
export function stalenessMs(state: HealthState, now = Date.now()): number {
  if (!state.lastOkAt) return Number.POSITIVE_INFINITY;
  return now - Date.parse(state.lastOkAt);
}

/**
 * Borra las medidas de velocidad de un modelo. Se usa al recalibrar a la fuerza: si no,
 * la media móvil seguiría arrastrando los valores antiguos y "remedir todo" no
 * remediría nada de verdad.
 */
export function resetSpeedMetrics(providerId: ProviderId, modelId: string): void {
  const current = healthOf(providerId, modelId);
  upsert({ ...current, ttftMs: null, tps: null, samples: 0 });
}

export function clearQuarantine(providerId: ProviderId, modelId: string): void {
  const current = healthOf(providerId, modelId);
  upsert({ ...current, quarantinedUntil: null, consecutiveFailures: 0 });
}
