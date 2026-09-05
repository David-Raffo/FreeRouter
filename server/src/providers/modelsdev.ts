/**
 * Metadatos desde models.dev.
 *
 * Hay proveedores cuyo `/models` devuelve poco más que el id — OpenCode Zen sirve 70
 * modelos y solo dice cómo se llaman. Sin precio no se puede saber cuáles son gratis, y
 * enrutar a uno de pago en un router de inferencia gratuita cuesta dinero de verdad.
 *
 * models.dev es el catálogo abierto que usa el propio OpenCode, y publica precio,
 * ventana de contexto, modalidades y tool use por modelo. Se consulta como complemento
 * del listado del proveedor: manda quién sirve qué (el proveedor) y models.dev aporta
 * lo que ese listado no cuenta.
 */

const ENDPOINT = 'https://models.dev/api.json';
/** El catálogo pesa varios MB y cambia poco; se cachea para no traerlo en cada refresco. */
const TTL_MS = 60 * 60 * 1000;

export interface ModelsDevEntry {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
}

interface Catalog {
  [providerKey: string]: { models?: Record<string, ModelsDevEntry> };
}

let cache: { at: number; data: Catalog } | null = null;
let inFlight: Promise<Catalog> | null = null;

async function load(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  // Varias conexiones simultáneas no deben descargar el catálogo varias veces.
  inFlight ??= fetch(ENDPOINT)
    .then(async (res) => {
      if (!res.ok) throw new Error(`models.dev devolvió ${res.status}`);
      const data = (await res.json()) as Catalog;
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Metadatos de un proveedor, indexados por id de modelo. Devuelve un mapa vacío si
 * models.dev no responde: es un complemento, no una dependencia — que se caiga no debe
 * impedir conectar un proveedor.
 */
export async function modelsDevMetadata(providerKey: string): Promise<Map<string, ModelsDevEntry>> {
  try {
    const catalog = await load();
    const models = catalog[providerKey]?.models ?? {};
    return new Map(Object.entries(models));
  } catch {
    return new Map();
  }
}

/** Solo para tests. */
export function resetModelsDevCache(): void {
  cache = null;
}
