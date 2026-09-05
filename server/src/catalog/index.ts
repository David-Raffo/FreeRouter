/**
 * Catálogo: límites, capacidades y calidad.
 *
 * Los datos viven en `server/catalog/*.json` (fuera de `src/`) para que se puedan
 * editar sin recompilar. Se cargan una vez y se cachean; `reloadCatalog()` fuerza
 * una relectura tras una sincronización.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InputModality, OutputModality, ProviderId, QuotaLimits } from '../providers/types.js';

// src/catalog/index.ts y dist/catalog/index.js quedan a la misma profundidad,
// así que esta ruta relativa vale tanto en desarrollo como compilado.
const CATALOG_DIR = new URL('../../catalog/', import.meta.url);

/**
 * Sufijos que describen CÓMO se sirve el modelo, no QUÉ modelo es. Los proveedores los
 * añaden y Artificial Analysis no los usa, así que impiden el emparejamiento sin aportar
 * identidad: `llama-3.3-70b-instruct-fp8-fast` es el mismo modelo evaluado que
 * `llama-3.3-70b-instruct`.
 *
 * `fast` solo se quita acompañando a una cuantización. Suelto NO se toca: hay modelos
 * que lo llevan en el nombre y son otro modelo con otra nota — `grok-4-fast` puntúa
 * 10,5 y `grok-4` puntúa 26,5, así que tratarlos como el mismo sería un error grave.
 */
const SERVING_SUFFIXES = /-(fp8|fp16|bf16|int8|int4|awq|gptq|q4|q8)(-fast)?$|-latest$/;

/**
 * Marca de instantánea al final del id: `-0731`, `0420`, `-2024-08-06`, `20250731`.
 * Los proveedores fijan una fecha concreta del modelo y el índice suele evaluar solo la
 * versión base. Se quita únicamente como ÚLTIMO recurso, después de intentar el
 * emparejamiento exacto, para que una instantánea que sí esté evaluada gane siempre.
 */
const SNAPSHOT_SUFFIX = /-?(\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})$/;

function formatVersion(raw: string): string {
  return `Artificial Analysis Intelligence Index v${raw}`;
}

/** Reescribe las claves ya normalizadas, para que no haya dos formas del mismo slug. */
function canonicalize<T>(entries: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) out[normalizeSlug(key)] = value;
  return out;
}

/** Quitar la fecha no debe dejar un identificador demasiado corto para ser fiable. */
const MIN_SLUG_LENGTH = 6;

function stripSnapshot(slug: string): string | null {
  const stripped = slug.replace(SNAPSHOT_SUFFIX, '').replace(/-$/, '');
  if (stripped === slug || stripped.length < MIN_SLUG_LENGTH) return null;
  return stripped;
}

function catalogPath(name: string): string {
  return fileURLToPath(new URL(name, CATALOG_DIR));
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(catalogPath(name), 'utf8')) as T;
}

interface LimitsFile {
  [providerId: string]: { default?: QuotaLimits; models?: Record<string, Partial<QuotaLimits>> } | unknown;
}

interface CapabilityRule {
  match: string;
  input?: InputModality[];
  output?: OutputModality[];
  tools?: boolean;
  chat?: boolean;
  context?: number;
}

export interface CapabilityEntry {
  input: InputModality[];
  output: OutputModality[];
  tools: boolean;
  /** `false` para modelos que no sirven en /chat/completions (whisper, TTS, guard…). */
  chat: boolean;
  /** Ventana de contexto asumida cuando el proveedor no la informa. */
  context: number;
}

interface CapabilitiesFile {
  _exclude?: { patterns?: string[] };
  [providerId: string]: { rules?: CapabilityRule[]; default?: CapabilityEntry } | unknown;
}

interface QualityFile {
  _meta: {
    indexVersion: string;
    measuredAt: string;
    syncedAt: string | null;
    attribution: string;
    note?: string;
  };
  /**
   * slug NORMALIZADO -> Intelligence Index.
   *
   * Se guarda ya normalizado a propósito: cuando convivían claves crudas y normalizadas
   * (`gpt-oss-120b` y `gpt-oss120b`) las dos resolvían a la misma entrada del índice en
   * memoria y cuál ganaba dependía del orden de iteración, con lo que la nota de un
   * modelo cambiaba sola entre arranques.
   */
  scores: Record<string, number>;
  /**
   * slug -> nombre publicado por Artificial Analysis. Sirve para comprobar a qué
   * instantánea corresponde una entrada sin fecha: el nombre de `deepseek-v4-flash` es
   * «DeepSeek V4 Flash 0731», así que se puede confirmar que es la misma que sirve el
   * proveedor en vez de suponerlo.
   */
  names?: Record<string, string>;
  /** "<providerId>:<modelId>" -> slug de Artificial Analysis. */
  overrides: Record<string, string>;
  heuristics: Array<{ match: string; prior: number }>;
  defaultPrior: number;
}

/**
 * Estado del catálogo, construido de forma PEREZOSA.
 *
 * Antes se inicializaba al cargar el módulo, y eso obligaba a que cualquier constante
 * usada por las funciones de compilación estuviese declarada más arriba: con `const` no
 * hay hoisting, así que declararla después reventaba el arranque con un
 * «Cannot access before initialization». Construir a la primera consulta elimina esa
 * dependencia del orden del fichero.
 */
interface CatalogState {
  limits: LimitsFile;
  capabilities: CapabilitiesFile;
  quality: QualityFile;
  compiledCapabilities: Map<string, { rules: Array<{ re: RegExp; rule: CapabilityRule }>; fallback: CapabilityEntry }>;
  compiledHeuristics: Array<{ re: RegExp; prior: number }>;
  normalizedScores: Map<string, number>;
  scoresByTokens: Map<string, number>;
  exclusions: RegExp[];
}

let state: CatalogState | null = null;

function build(): CatalogState {
  const capabilities = readJson<CapabilitiesFile>('capabilities.json');
  const quality = readJson<QualityFile>('quality.json');
  return {
    limits: readJson<LimitsFile>('limits.json'),
    capabilities,
    quality,
    compiledCapabilities: compileCapabilities(capabilities),
    compiledHeuristics: compileHeuristics(quality),
    normalizedScores: normalizeScores(quality),
    scoresByTokens: tokenIndex(quality),
    exclusions: compileExclusions(capabilities),
  };
}

function catalog(): CatalogState {
  state ??= build();
  return state;
}

export function reloadCatalog(): void {
  state = build();
}

/**
 * Las claves del catálogo se normalizan con la MISMA función que los ids de los
 * proveedores. Si no, un guion de más deja sin puntuación medida a un modelo que sí
 * la tiene: `qwen-3.8-27b` (Cerebras) y `qwen/qwen3.8-27b` (Groq) son el mismo modelo
 * y deben resolver a la misma entrada.
 */
function normalizeScores(file: QualityFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const [slug, score] of Object.entries(file.scores)) {
    out.set(normalizeSlug(slug), score);
  }
  return out;
}

/**
 * Índice por conjunto de términos. Solo guarda las claves que NO son ambiguas: si dos
 * modelos distintos comparten conjunto de términos, ninguno entra. Emparejar mal es peor
 * que no emparejar, porque una puntuación equivocada dirige mal el enrutado en silencio.
 */
function tokenIndex(file: QualityFile): Map<string, number> {
  const seen = new Map<string, Set<number>>();
  for (const [slug, score] of Object.entries(file.scores)) {
    const key = tokenKey(slug);
    // Con menos de dos términos el riesgo de colisión es alto y el valor bajo.
    if (key.split('-').length < 2) continue;
    seen.set(key, (seen.get(key) ?? new Set()).add(score));
  }
  const out = new Map<string, number>();
  for (const [key, scores] of seen) {
    if (scores.size === 1) out.set(key, [...scores][0]!);
  }
  return out;
}

function compileExclusions(file: CapabilitiesFile): RegExp[] {
  return (file._exclude?.patterns ?? []).map((pattern) => new RegExp(pattern, 'i'));
}

/**
 * ¿Este modelo sirve para /chat/completions?
 *
 * Los catálogos de los proveedores mezclan transcripción, TTS, clasificadores de
 * seguridad y generadores de audio con los modelos de chat. Enrutarles una conversación
 * es un error seguro, así que se filtran antes de llegar al router.
 */
export function isChatModel(modelId: string): boolean {
  return !catalog().exclusions.some((pattern) => pattern.test(modelId));
}

function compileCapabilities(file: CapabilitiesFile): Map<string, { rules: Array<{ re: RegExp; rule: CapabilityRule }>; fallback: CapabilityEntry }> {
  const out = new Map<string, { rules: Array<{ re: RegExp; rule: CapabilityRule }>; fallback: CapabilityEntry }>();
  for (const [key, value] of Object.entries(file)) {
    // `_default` es la única clave con guion bajo que SÍ es una entrada de proveedor;
    // el resto (`_meta`, `_exclude`) son metadatos y hay que saltárselos.
    if ((key.startsWith('_') && key !== '_default') || typeof value !== 'object' || value === null) continue;
    const entry = value as { rules?: CapabilityRule[]; default?: CapabilityEntry };
    out.set(key, {
      rules: (entry.rules ?? []).map((rule) => ({ re: new RegExp(rule.match, 'i'), rule })),
      fallback: entry.default ?? { input: ['text'], output: ['text'], tools: false, chat: true, context: 8192 },
    });
  }
  return out;
}

function compileHeuristics(file: QualityFile): Array<{ re: RegExp; prior: number }> {
  return file.heuristics.map((h) => ({ re: new RegExp(h.match, 'i'), prior: h.prior }));
}

const NO_LIMITS: QuotaLimits = { rpm: null, tpm: null, rpd: null, tpd: null };

/** Límites del catálogo para un modelo: los del modelo si existen, si no los del proveedor. */
export function limitsFor(providerId: ProviderId, modelId: string, providerDefault: QuotaLimits): QuotaLimits {
  const entry = catalog().limits[providerId];
  if (typeof entry !== 'object' || entry === null) return providerDefault;
  const typed = entry as { default?: QuotaLimits; models?: Record<string, Partial<QuotaLimits>> };
  const base = { ...NO_LIMITS, ...providerDefault, ...(typed.default ?? {}) };
  const perModel = typed.models?.[modelId];
  return perModel ? { ...base, ...perModel } : base;
}

/** Capacidades declaradas para Groq/Cerebras. `null` si el proveedor las descubre solo. */
export function capabilitiesFor(providerId: ProviderId, modelId: string): CapabilityEntry | null {
  // `_default` cubre a los proveedores que no tienen entrada propia, que son la
  // mayoría desde que el catálogo se carga desde JSON.
  const compiled = catalog().compiledCapabilities.get(providerId) ?? catalog().compiledCapabilities.get('_default');
  if (!compiled) return null;
  for (const { re, rule } of compiled.rules) {
    if (re.test(modelId)) {
      return {
        input: rule.input ?? compiled.fallback.input,
        output: rule.output ?? compiled.fallback.output,
        tools: rule.tools ?? compiled.fallback.tools,
        chat: rule.chat ?? true,
        context: rule.context ?? compiled.fallback.context,
      };
    }
  }
  return compiled.fallback;
}

/**
 * De dónde sale la nota de un modelo:
 *  - `measured`: valor del índice para ESE modelo.
 *  - `approx`: valor del modelo base cuando el proveedor sirve una instantánea fechada
 *    que el índice no ha evaluado por separado (`deepseek-v4-flash-0731` frente a
 *    `deepseek-v4-flash`). Es el mismo modelo en otra fecha, no una adivinanza.
 *  - `estimated`: heurística por familia, sin ninguna medida detrás.
 */
export type QualitySource = 'measured' | 'approx' | 'estimated';

export interface QualityResult {
  score: number;
  /** `measured` = Intelligence Index real; `estimated` = heurística por familia. */
  source: QualitySource;
}

/**
 * Puntuación de calidad de un modelo. Prefiere el Intelligence Index real; si no hay
 * sincronización o el modelo no se puede mapear, cae a la heurística por familia.
 */
export function qualityFor(providerId: ProviderId, modelId: string): QualityResult {
  const reference = catalog().quality.overrides[`${providerId}:${modelId}`] ?? modelId;
  const exact = catalog().normalizedScores.get(normalizeSlug(reference));
  if (typeof exact === 'number') return { score: exact, source: 'measured' };

  // Segundo intento sin depender del orden de los términos.
  const byTokens = catalog().scoresByTokens.get(tokenKey(reference));
  if (typeof byTokens === 'number') return { score: byTokens, source: 'measured' };

  // Tercer intento: con el vendedor pegado delante. Artificial Analysis a veces lo
  // incluye en el slug (`nvidia-nemotron3-ultra550b-a55b`) mientras el proveedor lo pone
  // como segmento de ruta (`nvidia/nemotron-3-ultra-550b-a55b`). No es una suposición:
  // el vendedor sale del propio id, del trozo que se descarta al normalizar.
  const vendor = /^([^/]+)\//.exec(reference)?.[1];
  if (vendor) {
    const withVendor = `${normalizeSlug(vendor)}-${normalizeSlug(reference)}`;
    const byVendor = catalog().normalizedScores.get(withVendor) ?? catalog().scoresByTokens.get(tokenKey(withVendor));
    if (typeof byVendor === 'number') return { score: byVendor, source: 'measured' };
  }

  // Cuarto intento: la misma familia sin la fecha de la instantánea. Va el último a
  // propósito, para que una instantánea evaluada de verdad gane a su modelo base.
  const normalized = normalizeSlug(reference);
  const base = stripSnapshot(normalized);
  if (base) {
    const byBase = catalog().normalizedScores.get(base) ?? catalog().scoresByTokens.get(tokenKey(base));
    if (typeof byBase === 'number') {
      // Si el nombre publicado incluye la misma fecha, no es una aproximación: es
      // exactamente la instantánea que sirve el proveedor.
      const snapshot = normalized.slice(base.length).replace(/\D/g, '');
      const publishedName = catalog().quality.names?.[base] ?? '';
      const sameSnapshot = snapshot.length > 0 && publishedName.replace(/\D/g, '').includes(snapshot);
      return { score: byBase, source: sameSnapshot ? 'measured' : 'approx' };
    }
  }

  for (const { re, prior } of catalog().compiledHeuristics) {
    if (re.test(modelId)) return { score: prior, source: 'estimated' };
  }
  return { score: catalog().quality.defaultPrior, source: 'estimated' };
}

export function normalizeSlug(modelId: string): string {
  let slug = modelId
    .toLowerCase()
    .replace(/:free$/, '')
    // TODOS los segmentos de ruta, no solo el primero: Cloudflare usa ids con dos
    // ("@cf/meta/llama-3.2-3b-instruct") y quedarse a medias impedía cualquier match.
    .replace(/^.*\//, '')
    // Los dos puntos separan igual que un punto o un guion bajo: Ollama escribe
    // `gemma4:31b` y LLM7 `deepseek-v4-flash:0731`. Va después de quitar `:free`.
    .replace(/[._:]/g, '-')
    // Un guion entre letra y dígito no aporta identidad y cada proveedor lo pone
    // donde quiere: "qwen-3-8-27b" y "qwen3-8-27b" son el mismo modelo.
    .replace(/([a-z])-(\d)/g, '$1$2')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();

  // En cadena, porque se acumulan: "…-fp8-fast".
  let previous = '';
  while (previous !== slug) {
    previous = slug;
    slug = slug.replace(SERVING_SUFFIXES, '');
  }
  return slug;
}

/**
 * Términos que un catálogo escribe y otro omite sin que cambie el modelo. Solo entran
 * aquí los que son de formato: `instruct`, `it` y `chat` describen la variante afinada
 * para conversación, que es la que todos sirven.
 *
 * Deliberadamente NO están `reasoning`, `thinking` ni los niveles de esfuerzo
 * (`high`, `low`, `xhigh`): esos sí son modelos distintos con puntuación distinta, y
 * confundirlos daría una nota equivocada con aspecto de medida.
 */
const FORMAT_TOKENS = new Set(['instruct', 'it', 'chat']);

/**
 * Clave insensible al orden de los términos. Es el segundo intento cuando el slug exacto
 * no casa, y resuelve dos diferencias reales entre catálogos: el orden de los términos
 * (`llama-3.3-70b-instruct` frente a `llama3-3-instruct-70b`) y que Artificial Analysis
 * pega el tamaño al sufijo (`instruct405b`), que aquí se separa antes de comparar.
 */
export function tokenKey(modelId: string): string {
  return normalizeSlug(modelId)
    // Separa letra de dígito para que `instruct405b` sean dos términos y no uno.
    .replace(/([a-z])(\d)/g, '$1-$2')
    .split('-')
    .filter((token) => token.length > 0 && !FORMAT_TOKENS.has(token))
    .sort()
    .join('-');
}

export function qualityMeta(): QualityFile['_meta'] & { measuredModels: number } {
  return { ...catalog().quality._meta, measuredModels: Object.keys(catalog().quality.scores).length };
}

/**
 * Fusiona los scores traídos de Artificial Analysis con los que ya vienen en el
 * fichero. Es una fusión y no un reemplazo a propósito: el endpoint gratuito solo
 * devuelve un subconjunto de modelos, y sobrescribir la tabla entera dejaría sin
 * puntuación medida a los que hoy sí la tienen.
 */
export function writeQualityScores(
  scores: Record<string, number>,
  syncedAt: string,
  indexVersion?: string | null,
  names?: Record<string, string>,
): void {
  const current = catalog().quality;

  // Las versiones del índice no son comparables entre sí: al pasar de la v4.1 a la v4.2
  // todas las puntuaciones bajaron entre 6 y 11 puntos. Mezclarlas haría que un modelo
  // con un valor antiguo pareciera mejor que otro medido con la escala nueva, así que
  // en un cambio de versión se REEMPLAZA la tabla en vez de fusionarla.
  // Se canoniza lo que ya había ANTES de mezclar. Si se canonizara después, dos formas
  // de la misma clave (`glm-5-3` y `glm5-3`) colapsarían en una sola y cuál sobrevive
  // dependería del orden de las propiedades del objeto, que es justo el fallo que hacía
  // que las notas cambiasen solas.
  const sameVersion = !indexVersion || current._meta.indexVersion === formatVersion(indexVersion);
  const merged = sameVersion ? { ...canonicalize(current.scores), ...canonicalize(scores) } : canonicalize(scores);
  const mergedNames = sameVersion
    ? { ...canonicalize(current.names ?? {}), ...canonicalize(names ?? {}) }
    : canonicalize(names ?? {});

  const next: QualityFile = {
    ...current,
    _meta: {
      ...current._meta,
      syncedAt,
      ...(indexVersion ? { indexVersion: formatVersion(indexVersion) } : {}),
    },
    scores: merged,
    names: mergedNames,
  };
  writeFileSync(catalogPath('quality.json'), `${JSON.stringify(next, null, 2)}
`, 'utf8');
  // Se reconstruye entero: `qualityFor` consulta los índices compilados, y sin
  // rehacerlos la sincronización sería un no-op silencioso.
  state = { ...catalog(), quality: next, normalizedScores: normalizeScores(next), scoresByTokens: tokenIndex(next), compiledHeuristics: compileHeuristics(next) };
}
