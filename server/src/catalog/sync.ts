/**
 * Sincronización del Intelligence Index de Artificial Analysis.
 *
 * Totalmente opcional. La app YA arranca con los índices reales de los modelos
 * conocidos en `quality.json`, así que sin clave el perfil `calidad` funciona con datos
 * medidos, no estimados.
 *
 * Lo que aporta una clave (gratuita, 100 peticiones/24 h) es cobertura: los proveedores
 * gratuitos añaden modelos nuevos constantemente, y para esos no hay valor medido hasta
 * que alguien los evalúa. La sincronización FUSIONA con lo que ya hay: nunca borra un
 * valor existente por el hecho de que el endpoint gratuito no lo devuelva.
 *
 * El uso de estos datos exige atribución visible a https://artificialanalysis.ai/,
 * que el panel muestra en el pie.
 */

import { normalizeSlug, qualityMeta, writeQualityScores } from './index.js';
import { getSetting } from '../db.js';
import { listModels, replaceModels, type StoredModel } from '../store.js';
import type { ProviderId } from '../providers/types.js';
import { qualityFor } from './index.js';

const ENDPOINT = 'https://artificialanalysis.ai/api/v2/language/models/free';
/** No se resincroniza si el último intento fue hace menos de esto (cuota: 100/día). */
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface AAModel {
  slug?: string;
  name?: string;
  /** Donde vive de verdad el índice en la v2. */
  evaluations?: { artificial_analysis_intelligence_index?: number | null } & Record<string, number | null>;
  /** Algunos tiers lo exponen también en la raíz; se acepta por si acaso. */
  artificial_analysis_intelligence_index?: number | null;
}

interface AAPage {
  tier?: string;
  intelligence_index_version?: string;
  pagination?: { page: number; page_size: number; total_pages: number; has_more: boolean };
  data?: AAModel[];
}

/** Tope de páginas por sincronización, para no gastar la cuota de 100 peticiones/24 h. */
const MAX_PAGES = 10;

export function artificialAnalysisKey(): string | null {
  return process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? getSetting('artificial_analysis_key');
}

export async function syncQualityScores(force = false): Promise<{ ok: boolean; updated: number; reason?: string }> {
  const key = artificialAnalysisKey();
  if (!key) {
    return {
      ok: false,
      updated: 0,
      reason: 'Sin clave de Artificial Analysis: se usan los índices que vienen en el catálogo.',
    };
  }

  const meta = qualityMeta();
  if (!force && meta.syncedAt && Date.now() - Date.parse(meta.syncedAt) < MIN_INTERVAL_MS) {
    return { ok: true, updated: 0, reason: 'Ya sincronizado recientemente.' };
  }

  const scores: Record<string, number> = {};
  const names: Record<string, string> = {};
  let indexVersion: string | null = null;

  // El catálogo va paginado (200 por página, ~630 modelos con índice). Quedarse en la
  // primera página dejaría fuera dos tercios de la cobertura, que es justo lo que se
  // busca al conectar la clave.
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await fetch(`${ENDPOINT}?page=${page}`, { headers: { 'x-api-key': key } });
      if (!res.ok) {
        if (page === 1) return { ok: false, updated: 0, reason: `Artificial Analysis devolvió ${res.status}.` };
        break; // con parte de las páginas ya traídas, mejor guardar lo que hay
      }
      const payload = (await res.json()) as AAPage;
      indexVersion ??= payload.intelligence_index_version ?? null;

      for (const model of payload.data ?? []) {
        const index = model.evaluations?.artificial_analysis_intelligence_index ?? model.artificial_analysis_intelligence_index;
        if (!model.slug || typeof index !== 'number') continue;
        const key = normalizeSlug(model.slug);
        scores[key] = index;
        // El nombre publicado lleva la fecha de la instantánea ("DeepSeek V4 Flash
        // 0731"), que es lo único que permite confirmar a cuál corresponde un slug sin
        // fecha en vez de darlo por supuesto.
        if (model.name) names[key] = model.name;
      }

      if (!payload.pagination?.has_more) break;
    }
  } catch (err) {
    return { ok: false, updated: 0, reason: err instanceof Error ? err.message : String(err) };
  }

  if (Object.keys(scores).length === 0) {
    return { ok: false, updated: 0, reason: 'La respuesta no traía ningún Intelligence Index.' };
  }

  try {
    writeQualityScores(scores, new Date().toISOString(), indexVersion, names);
  } catch (err) {
    // El catálogo puede estar montado en solo lectura (p. ej. un bind mount de Docker).
    // Sin esto el fallo sería mudo y parecería que la sincronización no hace nada.
    return {
      ok: false,
      updated: 0,
      reason: `No se pudo escribir quality.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  rescoreStoredModels();
  return { ok: true, updated: Object.keys(scores).length };
}

/**
 * Reaplica la puntuación a los modelos ya guardados. Sin esto, los valores nuevos no
 * llegarían al router hasta el siguiente refresco del catálogo de proveedores.
 */
function rescoreStoredModels(): number {
  const byProvider = new Map<ProviderId, StoredModel[]>();
  for (const model of listModels(false)) {
    const quality = qualityFor(model.providerId, model.id);
    const list = byProvider.get(model.providerId) ?? [];
    list.push({ ...model, qualityScore: quality.score, qualitySource: quality.source });
    byProvider.set(model.providerId, list);
  }
  let total = 0;
  for (const [providerId, models] of byProvider) {
    replaceModels(providerId, models);
    total += models.length;
  }
  return total;
}
