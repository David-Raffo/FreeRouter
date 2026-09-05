/**
 * Conectar y refrescar proveedores: valida la clave, guarda el catálogo de modelos y
 * mantiene ambos al día. Aquí es donde el descubrimiento de OpenRouter y el catálogo
 * manual de Groq/Cerebras acaban en la misma tabla.
 */

import { isChatModel } from '../catalog/index.js';
import {
  getProviderKeySecret,
  listProviderKeys,
  replaceModels,
  saveProviderKey,
  updateProviderLimits,
} from '../store.js';
import { withQuality } from './registry.js';
import type { ModelInfo, Provider, ValidationResult } from './types.js';

/** Descarta lo que no es un modelo de chat y resuelve la puntuación de calidad. */
function prepare(models: ModelInfo[]): ModelInfo[] {
  return withQuality(models.filter((model) => isChatModel(model.id)));
}

export async function connectProvider(
  provider: Provider,
  key: string,
  validation: ValidationResult,
): Promise<ModelInfo[]> {
  const models = prepare(validation.models ?? []);
  // La clave se guarda antes que los modelos: `models` tiene una FK a `provider_keys`.
  saveProviderKey(provider.id, key, validation.limits ?? null);
  replaceModels(provider.id, models);
  return models;
}

/**
 * Refresca el catálogo de un proveedor.
 *
 * Usa `validateKey` y no `listModels` a propósito: además de listar, comprueba a qué
 * grupos de modelos da acceso ESTA clave. Con `listModels` a secas el refresco volvía a
 * meter los modelos que la cuenta no cubre —los 33 de LLM7 que exigen saldo, por
 * ejemplo— y deshacía lo que la conexión había averiguado.
 */
export async function refreshProviderModels(
  provider: Provider,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const secret = getProviderKeySecret(provider.id);
  if (secret === null) return { ok: false, error: 'No hay ninguna clave activa para este proveedor.' };
  try {
    const validation = await provider.validateKey(secret);
    if (!validation.ok || !validation.models) {
      // Un refresco fallido no debe vaciar el catálogo: se conserva el anterior.
      return { ok: false, error: validation.error ?? 'No se pudo refrescar el catálogo.' };
    }
    const models = prepare(validation.models);
    replaceModels(provider.id, models);
    await refreshLimits(provider, secret);
    return { ok: true, count: models.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Vuelve a leer la cuota de la cuenta. Un fallo aquí no invalida el refresco de
 * modelos: se sigue con los límites que ya había.
 */
async function refreshLimits(provider: Provider, secret: string): Promise<void> {
  if (!provider.accountInfo) return;
  try {
    const info = await provider.accountInfo(secret);
    const derived = (info as { derived?: unknown }).derived;
    if (derived) updateProviderLimits(provider.id, derived as never);
  } catch {
    // sin conexión o endpoint caído: los límites actuales siguen siendo válidos
  }
}

/**
 * Refresca el catálogo de todos los proveedores conectados. Se llama al arrancar y
 * cada 6 horas: los proveedores gratuitos retiran y añaden modelos con frecuencia, y
 * enrutar hacia un modelo que ya no existe es un 404 garantizado.
 */
export async function refreshAllProviders(providers: Provider[]): Promise<void> {
  const connected = new Set(listProviderKeys().filter((key) => key.status === 'active').map((key) => key.providerId));
  await Promise.all(
    providers.filter((provider) => connected.has(provider.id)).map((provider) => refreshProviderModels(provider)),
  );
}
