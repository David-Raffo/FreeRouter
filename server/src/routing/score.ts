/**
 * Puntuación de candidatos. Funciones puras: aquí no se toca ni la red ni la base de
 * datos, para que el comportamiento del router se pueda testear entero.
 */

import type { HealthState } from './health.js';
import type { Profile, StoredModel } from '../store.js';

export interface ProfileWeights {
  /** Peso de la calidad objetiva (Intelligence Index). */
  quality: number;
  /** Peso de la velocidad medida (TTFT). */
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
 * Las dos componentes se normalizan contra el propio conjunto de candidatos: 1 para el
 * mejor, 0 para el peor. Lo que importa no son los valores absolutos sino cuál es la
 * mejor opción de las que hay disponibles ahora mismo.
 *
 * Es importante que ambas usen la misma escala. El Intelligence Index de los modelos
 * abiertos vive entre ~20 y ~60, así que dividirlo entre 100 lo dejaría siempre por
 * debajo de 0,6 mientras la velocidad sí llega a 1 — y el perfil `calidad` pesaría
 * bastante menos de lo que anuncia su tabla de pesos.
 *
 * La velocidad, a su vez, combina dos medidas: los tokens por segundo pesan más que el
 * TTFT porque en cuanto la respuesta pasa de un par de frases es el ritmo, y no el
 * arranque, lo que determina cuánto se espera.
 *
 * Un modelo sin medidas hereda la mediana del grupo, para que no salga favorecido ni
 * penalizado por el mero hecho de ser nuevo; la calibración le pondrá su número.
 */
export function scoreCandidates(candidates: Candidate[], profile: Profile): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  const weights = PROFILE_WEIGHTS[profile];

  // Cada métrica se completa con la mediana de las conocidas antes de normalizar.
  const ttfts = fillWithMedian(candidates.map((candidate) => candidate.health.ttftMs));
  const rates = fillWithMedian(candidates.map((candidate) => candidate.health.tps));

  const ttftRange = range(ttfts);
  const rateRange = range(rates);

  const qualities = candidates.map((candidate) => candidate.model.qualityScore ?? DEFAULT_QUALITY);
  const bestQuality = Math.max(...qualities);
  const worstQuality = Math.min(...qualities);

  return candidates
    .map((candidate, index) => {
      const qualityNorm = normalizeQuality(qualities[index]!, worstQuality, bestQuality);
      const ttftNorm = normalizeLog(ttfts[index] ?? null, ttftRange, 'lower');
      const rateNorm = normalizeLog(rates[index] ?? null, rateRange, 'higher');
      const speedNorm = SPEED_WEIGHTS.rate * rateNorm + SPEED_WEIGHTS.ttft * ttftNorm;

      return {
        ...candidate,
        qualityNorm,
        speedNorm,
        ttftMs: candidate.health.ttftMs,
        tps: candidate.health.tps,
        score: weights.quality * qualityNorm + weights.speed * speedNorm,
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

/** Sustituye los huecos por la mediana de los valores conocidos. */
function fillWithMedian(values: Array<number | null>): Array<number | null> {
  const known = values.filter((value): value is number => value !== null && value > 0).sort((a, b) => a - b);
  const fallback = known.length > 0 ? median(known) : null;
  return values.map((value) => (value !== null && value > 0 ? value : fallback));
}

function range(values: Array<number | null>): { min: number; max: number } | null {
  const valid = values.filter((value): value is number => value !== null && value > 0);
  if (valid.length === 0) return null;
  return { min: Math.min(...valid), max: Math.max(...valid) };
}

/** Puntuación asumida para un modelo cuyo índice no se pudo resolver. */
const DEFAULT_QUALITY = 22;

/** 1 para el mejor del grupo, 0 para el peor. Lineal: el índice ya es una escala lineal. */
function normalizeQuality(quality: number, worst: number, best: number): number {
  if (best <= worst) return 1;
  return clamp01((quality - worst) / (best - worst));
}

/**
 * Normaliza a 0-1 dentro del grupo, en escala logarítmica: la diferencia entre 200 ms
 * y 400 ms importa mucho más que entre 5.000 ms y 5.200 ms, y lo mismo al revés con
 * los tokens por segundo.
 *
 * Devuelve 0,5 cuando no hay nada con lo que comparar, para no inventar una ventaja.
 */
function normalizeLog(
  value: number | null,
  bounds: { min: number; max: number } | null,
  direction: 'higher' | 'lower',
): number {
  // Nadie tiene medida, o este candidato no la tiene: ni ventaja ni penalización.
  if (bounds === null || value === null || value <= 0) return 0.5;
  // Todos empatados: nadie debe perder puntos por ello.
  if (bounds.max <= bounds.min) return 1;
  const span = Math.log(bounds.max) - Math.log(bounds.min);
  const position = (Math.log(value) - Math.log(bounds.min)) / span;
  // La dirección se aplica DESPUÉS de resolver los casos degenerados: invertir un
  // empate resuelto a 1 lo convertiría en 0 y penalizaría a todos por igual.
  return clamp01(direction === 'higher' ? position : 1 - position);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
