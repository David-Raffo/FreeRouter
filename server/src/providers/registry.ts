/**
 * Registro de proveedores: descriptores del catálogo + overrides de los que necesitan
 * lógica propia. Añadir un proveedor compatible con OpenAI es una entrada en
 * `catalog/providers.json`; no hace falta tocar código.
 */

import { qualityFor } from '../catalog/index.js';
import { loadDescriptors, reloadDescriptors } from './descriptor.js';
import { buildProvider } from './generic.js';
import { OVERRIDES } from './overrides.js';
import { LONG_CONTEXT_THRESHOLD, type Capability, type ModelInfo, type Provider, type ProviderId } from './types.js';

function assemble(): Provider[] {
  return loadDescriptors().map((descriptor) => {
    // El override recibe el proveedor base ya construido para poder reutilizar sus
    // partes (por ejemplo, `validateKey` de OpenRouter usa el `listModels` genérico).
    const base = buildProvider(descriptor);
    const override = OVERRIDES[descriptor.id];
    return override ? { ...base, ...override(base) } : base;
  });
}

let providers: Provider[] = assemble();
let byId = new Map<ProviderId, Provider>(providers.map((provider) => [provider.id, provider]));

export function reloadProviders(): void {
  reloadDescriptors();
  providers = assemble();
  byId = new Map(providers.map((provider) => [provider.id, provider]));
}

export function allProviders(): Provider[] {
  return providers;
}

export function getProvider(id: string): Provider | undefined {
  return byId.get(id);
}

export function isProviderId(id: string): id is ProviderId {
  return byId.has(id);
}

/** Resuelve la puntuación de calidad de cada modelo contra el catálogo. */
export function withQuality(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => {
    const quality = qualityFor(model.providerId, model.id);
    return { ...model, qualityScore: quality.score, qualitySource: quality.source };
  });
}

/** ¿Este modelo cubre la capacidad pedida? */
export function modelHasCapability(model: ModelInfo, capability: Capability): boolean {
  switch (capability) {
    case 'vision':
      return model.inputModalities.includes('image');
    case 'audio':
      return model.inputModalities.includes('audio');
    case 'tools':
      return model.supportsTools;
    case 'long_context':
      return model.contextLength >= LONG_CONTEXT_THRESHOLD;
    case 'image_output':
      return model.outputModalities.includes('image');
  }
}

export function modelCapabilities(model: ModelInfo): Capability[] {
  const all: Capability[] = ['vision', 'audio', 'tools', 'long_context', 'image_output'];
  return all.filter((capability) => modelHasCapability(model, capability));
}
