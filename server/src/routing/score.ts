/**
 * Puntuación de candidatos. Funciones puras: aquí no se toca ni la red ni la base de
 * datos, para que el comportamiento del router se pueda testear entero.
 */

import type { HealthState } from './health.js';
import type { Profile, StoredModel } from '../store.js';

export interface ProfileWeights {
  /** Peso de la calidad objetiva (Intelligence Index). */
  quality: number;
  /** Peso de la velocidad medida (tok/s y TTFT). */
  speed: number;
}

export const PROFILE_WEIGHTS: Record<Profile, ProfileWeights> = {
  rapido: { quality: 0.15, speed: 0.85 },
  balanceado: { quality: 0.5, speed: 0.5 },
  calidad: { quality: 0.85, speed: 0.15 },
};

export interface Candidate {
  model: StoredModel;
  health: HealthState;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** Componente de calidad ya normalizado a 0-1. */
  qualityNorm: number;
  /** Componente de velocidad ya normalizado a 0-1. */
  speedNorm: number;
  /** TTFT medido; `null` si el modelo aún no tiene medidas. */
  ttftMs: number | null;
  /** Tokens por segundo medidos; `null` si aún no se ha calibrado. */
  tps: number | null;
}

/**
 * Ordena los candidatos de mejor a peor para un perfil.
 *
 * Las tres componentes se miden en **escala absoluta**, no relativa al grupo. La versión
 * anterior normalizaba cada métrica contra los propios candidatos —1 para el mejor, 0
 * para el peor— y eso tenía dos vicios: en un grupo de modelos lentos alguien sacaba un
 * 1 de velocidad igualmente, y el más rápido se llevaba la puntuación máxima aunque su
 * ventaja fuese imperceptible. Con escala absoluta, un modelo vale lo que vale.
 *
 *   score = (peso_calidad · calidad + peso_velocidad · velocidad) · penalización
 *
 * Un modelo sin medidas se queda en 0,5 de velocidad: ni ventaja ni castigo por ser
 * nuevo. La calibración le pondrá su número.
 */
export function scoreCandidates(candidates: Candidate[], profile: Profile): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  const weights = PROFILE_WEIGHTS[profile];

  return candidates
    .map((candidate) => {
      const quality = candidate.model.qualityScore ?? DEFAULT_QUALITY;
      const qualityNorm = normalizeQuality(quality);
      const speedNorm =
        SPEED_WEIGHTS.rate * normalizeRate(candidate.health.tps) +
        SPEED_WEIGHTS.ttft * normalizeTtft(candidate.health.ttftMs);

      const base = weights.quality * qualityNorm + weights.speed * speedNorm;

      return {
        ...candidate,
        qualityNorm,
        speedNorm,
        ttftMs: candidate.health.ttftMs,
        tps: candidate.health.tps,
        score: base * qualityPenalty(quality),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Reparto interno de la componente de velocidad. El ritmo pesa casi el doble que el
 * arranque: en una respuesta de cien tokens, 200 ms de más al empezar se notan mucho
 * menos que generar a la mitad de velocidad.
 */
export const SPEED_WEIGHTS = { rate: 0.65, ttft: 0.35 };

/**
 * Por encima de esto, más tokens por segundo ya no se notan.
 *
 * A 200 tok/s una respuesta de cien tokens sale en medio segundo. Que un modelo vaya a
 * 667 no la hace perceptiblemente mejor, pero antes le daba la puntuación máxima de
 * velocidad y lo colocaba por delante de modelos mucho más capaces. Saturar aquí es lo
 * que impide que la velocidad bruta compre el primer puesto.
 */
export const SPEED_SATURATION_TPS = 200;

/** Por debajo de esto el arranque ya se percibe como instantáneo. */
export const TTFT_FLOOR_MS = 300;

/** A partir de aquí el arranque es malo se mire como se mire. */
export const TTFT_CEILING_MS = 10_000;

/**
 * Suelo de calidad. Por debajo, la puntuación se hunde.
 *
 * No es un filtro: un modelo flojo sigue siendo mejor que ningún modelo, así que se
 * queda en la cadena como último recurso. Pero deja de competir por el primer puesto,
 * que es lo que hacía cuando era muy rápido. El castigo es cuadrático para que la caída
 * sea de verdad pronunciada: con el suelo en 15, un 11 conserva la mitad de su
 * puntuación y un 1 se queda en la milésima parte.
 */
export const QUALITY_FLOOR = 15;

/**
 * Referencia de la escala de calidad: el mejor Intelligence Index que se ve en el tier
 * gratuito. Dividir entre 100 —el máximo teórico— dejaría a todos por debajo de 0,5 y el
 * perfil `calidad` pesaría bastante menos de lo que anuncia su tabla.
 */
export const QUALITY_REFERENCE = 50;

/** Puntuación asumida para un modelo cuyo índice no se pudo resolver. */
const DEFAULT_QUALITY = 22;

function normalizeQuality(quality: number): number {
  return clamp01(quality / QUALITY_REFERENCE);
}

function qualityPenalty(quality: number): number {
  if (quality >= QUALITY_FLOOR) return 1;
  const ratio = clamp01(quality / QUALITY_FLOOR);
  return ratio * ratio;
}

/**
 * Tokens por segundo, en escala logarítmica y saturada. Logarítmica porque la diferencia
 * entre 10 y 20 tok/s importa mucho más que entre 190 y 200.
 */
function normalizeRate(tps: number | null): number {
  if (tps === null || tps <= 0) return 0.5;
  return clamp01(Math.log1p(Math.min(tps, SPEED_SATURATION_TPS)) / Math.log1p(SPEED_SATURATION_TPS));
}

/** TTFT, también logarítmico, con suelo y techo absolutos. */
function normalizeTtft(ttftMs: number | null): number {
  if (ttftMs === null || ttftMs <= 0) return 0.5;
  if (ttftMs <= TTFT_FLOOR_MS) return 1;
  if (ttftMs >= TTFT_CEILING_MS) return 0;
  const span = Math.log(TTFT_CEILING_MS) - Math.log(TTFT_FLOOR_MS);
  return clamp01(1 - (Math.log(ttftMs) - Math.log(TTFT_FLOOR_MS)) / span);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
