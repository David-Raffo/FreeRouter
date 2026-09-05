/**
 * Selección de modelo.
 *
 * Filtra → puntúa → construye la cadena de failover. El cliente nunca ve nada de esto:
 * manda una petición y recibe una respuesta.
 */

import { getProvider, modelHasCapability } from '../providers/registry.js';
import type { Capability } from '../providers/types.js';
import { allHealth, isQuarantined, type HealthState } from './health.js';
import { checkQuota } from './quota.js';
import { scoreCandidates, type Candidate, type ScoredCandidate } from './score.js';
import { listModels, type Profile, type StoredModel } from '../store.js';
import type { TokenEstimate } from './tokens.js';

/** Cuántos modelos se intentan como máximo antes de rendirse. */
const MAX_ATTEMPTS = 4;
/** Probabilidad de probar un candidato sin medidas recientes en vez del mejor. */
const EXPLORATION_RATE = 0.05;

export interface RouteInput {
  profile: Profile;
  /** Capacidades exigidas por la API key. */
  capabilities: Capability[];
  estimate: TokenEstimate;
  usesTools: boolean;
}

export interface Rejection {
  providerId: string;
  modelId: string;
  reason: string;
}

export interface RouteResult {
  /** Modelos a intentar, en orden. Vacío si no hay ninguno servible. */
  chain: ScoredCandidate[];
  /** Por qué se descartó cada modelo; alimenta el 503 explicativo y el panel. */
  rejected: Rejection[];
  /** Capacidades realmente exigidas (las de la key más las deducidas de la petición). */
  required: Capability[];
}

/**
 * Las capacidades no salen solo de la API key: si la petición trae una imagen o
 * define herramientas, se exigen aunque la key no las declarara. Es lo que evita
 * mandar una imagen a un modelo de solo texto y recibir un 400.
 */
export function requiredCapabilities(input: RouteInput): Capability[] {
  const required = new Set<Capability>(input.capabilities);
  if (input.estimate.hasImages) required.add('vision');
  if (input.estimate.hasAudio) required.add('audio');
  if (input.usesTools) required.add('tools');
  return [...required];
}

export function route(input: RouteInput, models: StoredModel[] = listModels()): RouteResult {
  const required = requiredCapabilities(input);
  const healthByKey = new Map(allHealth().map((state) => [`${state.providerId}:${state.modelId}`, state]));

  const candidates: Candidate[] = [];
  const rejected: Rejection[] = [];

  for (const model of models) {
    const reason = rejectionFor(model, required, input, healthByKey);
    if (reason) {
      rejected.push({ providerId: model.providerId, modelId: model.id, reason });
      continue;
    }
    candidates.push({
      model,
      health: healthByKey.get(`${model.providerId}:${model.id}`) ?? emptyHealth(model),
    });
  }

  const scored = scoreCandidates(candidates, input.profile);
  return { chain: buildChain(scored), rejected, required };
}

function rejectionFor(
  model: StoredModel,
  required: Capability[],
  input: RouteInput,
  healthByKey: Map<string, HealthState>,
): string | null {
  const missing = required.filter((capability) => !modelHasCapability(model, capability));
  if (missing.length > 0) return `no soporta: ${missing.join(', ')}`;

  if (model.contextLength < input.estimate.total) {
    return `contexto insuficiente (${model.contextLength} < ${input.estimate.total} tokens estimados)`;
  }

  const health = healthByKey.get(`${model.providerId}:${model.id}`);
  if (health && isQuarantined(health)) {
    return `en cuarentena (${health.lastError ?? 'fallos consecutivos'})`;
  }

  const quota = checkQuota(model.providerId, model.id, input.estimate.total);
  if (!quota.ok) return quota.reason ?? 'sin cuota';

  return null;
}

/**
 * Construye la cadena de intentos.
 *
 * El primero es el mejor por puntuación (con algo de exploración). Los siguientes se
 * ordenan por `failoverRank` antes que por puntuación, para que OpenRouter quede
 * al final: su cuota diaria es de 50 peticiones y los fallos también la gastan, así
 * que no queremos quemarla en reintentos.
 */
function buildChain(scored: ScoredCandidate[]): ScoredCandidate[] {
  if (scored.length === 0) return [];

  const primary = pickPrimary(scored);
  const rest = scored
    .filter((candidate) => candidate !== primary)
    .sort((a, b) => {
      const rankA = getProvider(a.model.providerId)?.failoverRank ?? 5;
      const rankB = getProvider(b.model.providerId)?.failoverRank ?? 5;
      return rankA !== rankB ? rankA - rankB : b.score - a.score;
    });

  return [primary, ...rest].slice(0, MAX_ATTEMPTS);
}

/**
 * Normalmente gana el de mayor puntuación. Un 5% de las veces se prueba un modelo sin
 * medidas, para que un candidato nuevo o recién recuperado consiga sus datos en vez de
 * quedarse fuera para siempre por no tener historial.
 */
function pickPrimary(scored: ScoredCandidate[]): ScoredCandidate {
  const best = scored[0]!;
  if (scored.length < 2 || Math.random() >= EXPLORATION_RATE) return best;
  const unmeasured = scored.filter((candidate) => candidate.health.samples === 0);
  if (unmeasured.length === 0) return best;
  return unmeasured[Math.floor(Math.random() * unmeasured.length)]!;
}

function emptyHealth(model: StoredModel): HealthState {
  return {
    providerId: model.providerId,
    modelId: model.id,
    ttftMs: null,
    tps: null,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    quarantinedUntil: null,
    samples: 0,
  };
}

/**
 * Resumen legible de por qué no hay candidatos, para devolverlo en el 503 en vez de
 * un error genérico. Agrupa por motivo porque con 20 modelos la lista cruda no dice nada.
 */
export function explainNoCandidates(result: RouteResult): string {
  if (result.rejected.length === 0) {
    return 'No hay ningún modelo configurado. Añade al menos una clave de proveedor en el panel.';
  }
  const byReason = new Map<string, number>();
  for (const rejection of result.rejected) {
    const key = rejection.reason.replace(/\(.*\)/, '').trim();
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const parts = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${count === 1 ? 'modelo' : 'modelos'}: ${reason}`);
  const caps = result.required.length > 0 ? ` Capacidades exigidas: ${result.required.join(', ')}.` : '';
  return `Ningún modelo disponible ahora mismo.${caps} Descartados — ${parts.join('; ')}.`;
}
