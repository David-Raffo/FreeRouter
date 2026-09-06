/**
 * API del panel. Solo la usa la web local.
 *
 * Regla que no se rompe: por aquí nunca sale una clave de proveedor en claro, solo
 * sus últimos 4 caracteres.
 */

import type { FastifyInstance } from 'fastify';
import { qualityMeta } from '../catalog/index.js';
import { getSetting, setSetting } from '../db.js';
import { syncQualityScores } from '../catalog/sync.js';
import { generateApiKey } from '../crypto.js';
import { connectProvider, refreshProviderModels } from '../providers/connect.js';
import { loadDescriptors } from '../providers/descriptor.js';
import { allProviders, getProvider, isProviderId, modelCapabilities } from '../providers/registry.js';
import type { Capability } from '../providers/types.js';
import { allHealth, isQuarantined } from '../routing/health.js';
import { quotaStatus } from '../routing/quota.js';
import { isWarmupRunning, measureModel, warmupAll } from '../routing/probe.js';
import { route } from '../routing/select.js';
import { estimateTokens } from '../routing/tokens.js';
import {
  createApiKey,
  deleteProviderKey,
  getProviderKeySecret,
  listApiKeys,
  listModels,
  listProviderKeys,
  clearRequestContent,
  recentRequests,
  requestDetail,
  revokeApiKey,
  setModelEnabled,
  type Profile,
} from '../store.js';

const PROFILES: Profile[] = ['rapido', 'balanceado', 'calidad'];
const CAPABILITIES: Capability[] = ['vision', 'audio', 'tools', 'long_context', 'image_output'];

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/status', async () => {
    const keys = listProviderKeys();
    const models = listModels();
    return {
      connectedProviders: keys.length,
      activeProviders: keys.filter((key) => key.status === 'active').length,
      models: models.length,
      apiKeys: listApiKeys().filter((key) => !key.revoked).length,
      quality: qualityMeta(),
      onboardingComplete: keys.some((key) => key.status === 'active'),
    };
  });

  app.get('/api/providers', async () => {
    const keys = new Map(listProviderKeys().map((key) => [key.providerId, key]));
    const descriptors = new Map(loadDescriptors().map((entry) => [entry.id, entry]));
    return allProviders().map((provider) => {
      const key = keys.get(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        keyHint: provider.keyHint,
        consoleUrl: provider.consoleUrl,
        quotaScope: provider.quotaScope,
        freeTier: provider.freeTier,
        keyOptional: Boolean(descriptors.get(provider.id)?.keyOptional),
        warning: descriptors.get(provider.id)?.warning ?? null,
        connected: Boolean(key),
        status: key?.status ?? null,
        last4: key?.last4 ?? null,
        addedAt: key?.addedAt ?? null,
        lastError: key?.lastError ?? null,
        limits: key?.limits ?? provider.defaultLimits,
        models: listModels(false).filter((model) => model.providerId === provider.id).length,
      };
    });
  });

  app.post<{ Params: { id: string }; Body: { key?: string } }>('/api/providers/:id/key', async (request, reply) => {
    const provider = getProvider(request.params.id);
    if (!provider) return reply.code(404).send({ error: 'Proveedor desconocido.' });

    const descriptor = loadDescriptors().find((entry) => entry.id === provider.id);
    const key = request.body?.key?.trim() ?? '';
    if (!key && !descriptor?.keyOptional) return reply.code(400).send({ error: 'Falta la clave.' });

    const validation = await provider.validateKey(key);
    if (!validation.ok || !validation.models) {
      return reply.code(400).send({ error: validation.error ?? 'La clave no se pudo validar.' });
    }

    const saved = await connectProvider(provider, key, validation);

    // Calibrar en cuanto se conecta. El sondeo periódico mide un modelo cada dos
    // minutos, así que conectar un proveedor con decenas de modelos tardaría más de una
    // hora en tener datos y el router decidiría casi a ciegas mientras tanto.
    void warmupAll()
      .then((result) => app.log.info({ provider: provider.id, result }, 'Calibración tras conectar'))
      .catch((err) => app.log.warn({ err }, 'Calibración tras conectar fallida'));

    return reply.send({
      ok: true,
      models: saved.length,
      notes: validation.notes ?? [],
      capabilities: summarizeCapabilities(provider.id),
    });
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/refresh', async (request, reply) => {
    const provider = getProvider(request.params.id);
    if (!provider) return reply.code(404).send({ error: 'Proveedor desconocido.' });
    const result = await refreshProviderModels(provider);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return reply.send({ ok: true, models: result.count });
  });

  app.get<{ Params: { id: string } }>('/api/providers/:id/diagnostics', async (request, reply) => {
    const provider = getProvider(request.params.id);
    if (!provider) return reply.code(404).send({ error: 'Proveedor desconocido.' });
    if (!provider.accountInfo) return reply.send({ supported: false });
    const secret = getProviderKeySecret(provider.id);
    if (!secret) return reply.code(400).send({ error: 'No hay clave activa para este proveedor.' });
    try {
      return reply.send({ supported: true, info: await provider.accountInfo(secret) });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => {
    if (!isProviderId(request.params.id)) return reply.code(404).send({ error: 'Proveedor desconocido.' });
    deleteProviderKey(request.params.id);
    return reply.send({ ok: true });
  });

  /**
   * Listado de modelos, ordenado y paginado en el servidor.
   *
   * La paginación no es cosmética: un catálogo con varios miles de modelos serían
   * megabytes en cada refresco del panel, que se repite cada pocos segundos.
   */
  app.get<{ Querystring: { sort?: string; page?: string; pageSize?: string; q?: string } }>(
    '/api/models',
    async (request) => {
      const health = new Map(allHealth().map((state) => [`${state.providerId}:${state.modelId}`, state]));
      const providerStatus = new Map(listProviderKeys().map((key) => [key.providerId, key.status]));

      const rows = listModels(false).map((model) => {
        const state = health.get(`${model.providerId}:${model.id}`);
        const quota = quotaStatus(model.providerId, model.id);
        const status = providerStatus.get(model.providerId) ?? null;
        return {
          providerId: model.providerId,
          id: model.id,
          displayName: model.displayName,
          contextLength: model.contextLength,
          capabilities: modelCapabilities(model),
          qualityScore: model.qualityScore,
          qualitySource: model.qualitySource,
          enabled: model.enabled,
          ttftMs: state?.ttftMs ?? null,
          tps: state?.tps ?? null,
          samples: state?.samples ?? 0,
          lastError: state?.lastError ?? null,
          quarantined: state ? isQuarantined(state) : false,
          quarantinedUntil: state?.quarantinedUntil ?? null,
          providerStatus: status,
          state: modelState(model.enabled, status, state ? isQuarantined(state) : false, quota),
          quota,
        };
      });

      const query = (request.query.q ?? '').trim().toLowerCase();
      const filtered = query
        ? rows.filter((row) => `${row.providerId}/${row.id}`.toLowerCase().includes(query))
        : rows;

      const sort = request.query.sort === 'quality' ? 'quality' : 'speed';
      filtered.sort((a, b) => compareModels(a, b, sort));

      const pageSize = clampInt(request.query.pageSize, 25, 1, 200);
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = clampInt(request.query.page, 1, 1, pages);
      const start = (page - 1) * pageSize;

      const routable = rows.filter((row) => row.state === 'active' || row.state === 'cooldown' || row.state === 'no_quota');
      return {
        rows: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pages,
        pageSize,
        summary: {
          total: rows.length,
          routable: routable.length,
          uncalibrated: routable.filter((row) => row.tps === null).length,
          calibrating: isWarmupRunning(),
        },
      };
    },
  );

  /**
   * Activar o desactivar un modelo. El id va en el CUERPO, no en la ruta.
   *
   * Iba en la ruta y fallaba para media docena de proveedores. Los ids de modelo llevan
   * barras —`deepseek-ai/deepseek-v4-pro-0813`, `@cf/meta/llama-3.2-3b-instruct`— y
   * aunque el panel las escapa como `%2F`, casi cualquier proxy inverso las vuelve a
   * convertir en barras de verdad antes de reenviar: Apache lo hace por defecto
   * (`AllowEncodedSlashes Off`), y nginx, Caddy y compañía normalizan la ruta por su
   * cuenta. Fastify recibía entonces `/api/models/deepseek-ai/deepseek-v4-pro-0813/enabled`,
   * que no encaja con ninguna ruta, y devolvía 404. Desde el navegador el botón
   * simplemente no hacía nada.
   *
   * En el cuerpo no hay nada que normalizar, así que deja de depender de qué haya
   * delante. Es también la razón por la que los ids no deberían viajar nunca en un
   * segmento de ruta: además de `/` llevan `@` y `:`.
   */
  app.post<{ Body: { providerId?: string; modelId?: string; enabled?: boolean } }>(
    '/api/models/enabled',
    async (request, reply) => {
      const providerId = request.body?.providerId;
      const modelId = request.body?.modelId;
      if (!providerId || !isProviderId(providerId)) return reply.code(400).send({ error: 'providerId inválido.' });
      if (!modelId) return reply.code(400).send({ error: 'Falta modelId.' });
      setModelEnabled(providerId, modelId, request.body?.enabled !== false);
      return reply.send({ ok: true });
    },
  );

  /**
   * La ruta antigua, conservada a propósito. Un navegador con el panel viejo en caché
   * sigue llamando aquí; quitarla lo dejaría peor que antes, roto también para los ids
   * sin barra, que sí funcionaban.
   */
  app.post<{ Params: { id: string }; Body: { providerId?: string; enabled?: boolean } }>(
    '/api/models/:id/enabled',
    async (request, reply) => {
      const providerId = request.body?.providerId;
      if (!providerId || !isProviderId(providerId)) return reply.code(400).send({ error: 'providerId inválido.' });
      setModelEnabled(providerId, decodeURIComponent(request.params.id), request.body?.enabled !== false);
      return reply.send({ ok: true });
    },
  );

  app.get('/api/keys', async () => listApiKeys().filter((key) => !key.revoked));

  /**
   * Cuántos modelos servirían una key con este perfil y capacidades. El panel lo llama
   * antes de crearla para poder avisar cuando la respuesta es "ninguno" — que es
   * exactamente lo que pasa hoy al pedir generación de imágenes.
   */
  app.post<{ Body: { profile?: string; capabilities?: string[] } }>('/api/keys/preview', async (request, reply) => {
    const parsed = parseKeySpec(request.body ?? {});
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

    const routed = route({
      profile: parsed.profile,
      capabilities: parsed.capabilities,
      estimate: estimateTokens({ messages: [{ role: 'user', content: 'hola' }] }),
      usesTools: false,
    });

    return reply.send({
      matches: routed.chain.length,
      top: routed.chain.slice(0, 3).map((candidate) => ({
        providerId: candidate.model.providerId,
        modelId: candidate.model.id,
        score: Number(candidate.score.toFixed(3)),
        qualityScore: candidate.model.qualityScore,
        qualitySource: candidate.model.qualitySource,
        ttftMs: candidate.ttftMs,
        tps: candidate.tps,
      })),
      rejected: routed.rejected.length,
    });
  });

  app.post<{ Body: { name?: string; profile?: string; capabilities?: string[] } }>('/api/keys', async (request, reply) => {
    const parsed = parseKeySpec(request.body ?? {});
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

    const name = request.body?.name?.trim() || `Key ${parsed.profile}`;
    const plaintext = generateApiKey();
    const record = createApiKey(name, parsed.profile, parsed.capabilities, plaintext);

    // Única vez que se devuelve la clave en claro: después solo queda su hash.
    return reply.send({ ...record, key: plaintext });
  });

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (request, reply) => {
    revokeApiKey(request.params.id);
    return reply.send({ ok: true });
  });

  /**
   * Calibración: mide TTFT y tok/s de todos los modelos sin datos. Se lanza en segundo
   * plano porque recorre decenas de modelos con pausas entre ellos; el progreso se ve
   * en /api/models según van llegando las medidas.
   */
  app.post<{ Querystring: { force?: string } }>('/api/warmup', async (request, reply) => {
    if (isWarmupRunning()) return reply.send({ started: false, reason: 'Ya hay una calibración en curso.' });
    void warmupAll({ force: request.query.force === 'true' })
      .then((result) => app.log.info({ result }, 'Calibración terminada'))
      .catch((err) => app.log.warn({ err }, 'Calibración fallida'));
    return reply.send({ started: true });
  });

  app.get('/api/warmup', async () => ({ running: isWarmupRunning() }));

  /** Fuerza una sincronización con Artificial Analysis y reaplica las puntuaciones. */
  app.post<{ Querystring: { force?: string } }>('/api/quality/sync', async (request, reply) => {
    const result = await syncQualityScores(request.query.force === 'true');
    return reply.send({ ...result, quality: qualityMeta() });
  });

  /**
   * Mide un modelo concreto y devuelve el detalle, para auditar de dónde sale su cifra.
   * El id va en el cuerpo por el mismo motivo que en la ruta de arriba.
   */
  app.post<{ Body: { providerId?: string; modelId?: string } }>('/api/models/measure', async (request, reply) => {
    const providerId = request.body?.providerId;
    const modelId = request.body?.modelId;
    if (!providerId || !isProviderId(providerId)) return reply.code(400).send({ error: 'providerId inválido.' });
    if (!modelId) return reply.code(400).send({ error: 'Falta modelId.' });
    const model = listModels(false).find((m) => m.providerId === providerId && m.id === modelId);
    if (!model) return reply.code(404).send({ error: 'Modelo desconocido.' });
    return reply.send(await measureModel(model));
  });

  app.get('/api/activity', async () => recentRequests(50));

  /** Prompt y respuesta de una petición: lo que se despliega al pinchar una fila. */
  app.get<{ Params: { id: string } }>('/api/activity/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id inválido.' });
    const detail = requestDetail(id);
    if (!detail) return reply.code(404).send({ error: 'Petición no encontrada.' });
    return reply.send(detail);
  });

  /**
   * Registro de contenido. Guardar prompts y respuestas es lo que hace útil el
   * historial, pero son datos sensibles que quedan en la base de datos local, así que
   * se puede apagar. Apagarlo no borra lo ya guardado; para eso está el botón de purga.
   */
  app.get('/api/settings/logging', async () => ({ logContent: getSetting('log_content') !== 'false' }));

  /**
   * Medir el TTFT pidiendo streaming a los proveedores aunque el cliente no lo pida.
   * Se puede apagar: la respuesta al cliente es idéntica en los dos casos, pero apagarlo
   * deja al router sin TTFT del tráfico que no venga troceado.
   */
  app.get('/api/settings/measurement', async () => ({ measureTtft: getSetting('measure_ttft') !== 'false' }));

  app.post<{ Body: { measureTtft?: boolean } }>('/api/settings/measurement', async (request, reply) => {
    setSetting('measure_ttft', request.body?.measureTtft === false ? 'false' : 'true');
    return reply.send({ measureTtft: request.body?.measureTtft !== false });
  });

  app.post<{ Body: { logContent?: boolean } }>('/api/settings/logging', async (request, reply) => {
    setSetting('log_content', request.body?.logContent === false ? 'false' : 'true');
    return reply.send({ logContent: request.body?.logContent !== false });
  });

  app.delete('/api/activity', async (_request, reply) => {
    clearRequestContent();
    return reply.send({ ok: true });
  });

  app.get('/api/meta', async () => ({
    profiles: PROFILES,
    capabilities: CAPABILITIES,
    quality: qualityMeta(),
  }));
}

/**
 * Estado de un modelo de cara al enrutado. Se calcula aquí y no en el panel para que el
 * orden del listado y lo que se ve en pantalla no puedan discrepar.
 */
type ModelState = 'active' | 'cooldown' | 'no_quota' | 'quarantined' | 'disabled' | 'provider_down';

/** Los que no pueden servir van al final, en orden de "cuán roto está". */
const STATE_ORDER: Record<ModelState, number> = {
  active: 0,
  cooldown: 1,
  no_quota: 2,
  quarantined: 3,
  disabled: 4,
  provider_down: 5,
};

function modelState(
  enabled: boolean,
  providerStatus: string | null,
  quarantined: boolean,
  quota: ReturnType<typeof quotaStatus>,
): ModelState {
  if (providerStatus !== 'active') return 'provider_down';
  if (!enabled) return 'disabled';
  if (quarantined) return 'quarantined';
  if (exhausted(quota)) return 'no_quota';
  if (quota.cooldownMs > 0) return 'cooldown';
  return 'active';
}

function exhausted(quota: ReturnType<typeof quotaStatus>): boolean {
  const { limits } = quota;
  if (limits.rpd !== null && quota.dailyRequests >= limits.rpd) return true;
  if (limits.tpd !== null && quota.dailyTokens >= limits.tpd) return true;
  return false;
}

interface SortableModel {
  state: ModelState;
  tps: number | null;
  qualityScore: number | null;
  providerId: string;
  id: string;
}

/**
 * Ordena: primero por estado (lo que no sirve, al fondo), luego por la métrica elegida.
 * Un modelo sin medir queda por detrás de los medidos pero por delante de los rotos —
 * todavía puede servir, solo que aún no sabemos cómo de bien.
 */
function compareModels(a: SortableModel, b: SortableModel, sort: 'speed' | 'quality'): number {
  const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (byState !== 0) return byState;

  const valueA = sort === 'speed' ? a.tps : a.qualityScore;
  const valueB = sort === 'speed' ? b.tps : b.qualityScore;
  if (valueA === null && valueB === null) return `${a.providerId}/${a.id}`.localeCompare(`${b.providerId}/${b.id}`);
  if (valueA === null) return 1;
  if (valueB === null) return -1;
  if (valueB !== valueA) return valueB - valueA;
  return `${a.providerId}/${a.id}`.localeCompare(`${b.providerId}/${b.id}`);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(parsed, min), max);
}

function parseKeySpec(
  body: { profile?: string; capabilities?: string[] },
): { profile: Profile; capabilities: Capability[] } | { error: string } {
  const profile = body.profile ?? 'balanceado';
  if (!PROFILES.includes(profile as Profile)) {
    return { error: `Perfil inválido. Usa uno de: ${PROFILES.join(', ')}.` };
  }
  const capabilities = body.capabilities ?? [];
  const invalid = capabilities.filter((capability) => !CAPABILITIES.includes(capability as Capability));
  if (invalid.length > 0) {
    return { error: `Capacidades desconocidas: ${invalid.join(', ')}.` };
  }
  return { profile: profile as Profile, capabilities: capabilities as Capability[] };
}

/** Cuántos modelos de un proveedor cubren cada capacidad; se enseña tras conectar. */
function summarizeCapabilities(providerId: string): Record<string, number> {
  const models = listModels(false).filter((model) => model.providerId === providerId);
  const summary: Record<string, number> = {};
  for (const capability of CAPABILITIES) {
    summary[capability] = models.filter((model) => modelCapabilities(model).includes(capability)).length;
  }
  return summary;
}
