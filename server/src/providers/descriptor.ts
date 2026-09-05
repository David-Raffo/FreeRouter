/**
 * Descriptores de proveedor cargados desde `catalog/providers.json`.
 *
 * La mayoría de proveedores de inferencia exponen una API compatible con OpenAI y solo
 * se diferencian en la URL, la forma de autenticar y sus límites. Todo eso son datos,
 * no código: mantenerlos en un JSON permite añadir un proveedor sin recompilar y sin
 * escribir un fichero nuevo por cada uno.
 *
 * Los pocos que necesitan lógica propia (leer cabeceras de cuota, consultar el estado
 * de la cuenta) la aportan como override en `overrides.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FreeTierInfo, QuotaLimits } from './types.js';

const CATALOG_DIR = new URL('../../catalog/', import.meta.url);

export interface ProviderDescriptor {
  id: string;
  label: string;
  /** Base compatible con OpenAI, sin barra final. */
  baseUrl: string;
  keyHint: string;
  consoleUrl: string;
  /** Menor = se intenta antes en la cadena de failover. */
  failoverRank: number;
  quotaScope: 'model' | 'account';
  defaultLimits: QuotaLimits;
  freeTier: FreeTierInfo;

  /**
   * Multiplica el castigo tras un 429. Por defecto 1.
   *
   * Sube donde equivocarse sale caro. En OpenRouter un fallo tarda 532 ms de mediana
   * frente a los 76 ms de Groq, y además gasta una de las 50 peticiones diarias porque
   * allí las fallidas también cuentan: reintentar pronto cuesta el doble que en el
   * resto, así que se espera más antes de volver.
   */
  rateLimitPenaltyFactor?: number;

  /**
   * `true` cuando el proveedor mezcla modelos gratuitos y de pago y hay que quedarse
   * solo con los de precio cero. `false` cuando la cuenta entera es de tier gratuito
   * y por tanto todos sus modelos lo son.
   */
  freeOnly: boolean;
  /** El listado de modelos no necesita clave (varios lo exponen en abierto). */
  publicModelList?: boolean;
  /**
   * El proveedor sirve sin clave. Se puede conectar dejando el campo vacío, y entonces
   * no se manda cabecera de autorización (algunos rechazan un Bearer vacío).
   */
  keyOptional?: boolean;
  /**
   * Formato de la credencial cuando no es una clave suelta. `account:token` significa
   * que el usuario pega «idDeCuenta:token» y la parte de cuenta va en la URL.
   */
  credentialFormat?: 'account:token';
  /** Plantilla de URL con `{account}`, para los proveedores con `credentialFormat`. */
  baseUrlTemplate?: string;
  /** El proveedor acepta `stream_options.include_usage`. */
  streamUsage?: boolean;
  /** Cabeceras fijas adicionales. */
  extraHeaders?: Record<string, string>;
  /** Ids o patrones de modelo a excluir siempre en este proveedor. */
  excludePatterns?: string[];
  /** Ventana de contexto asumida cuando el listado no la informa. */
  defaultContext?: number;
  /**
   * Clave de este proveedor en models.dev. Cuando el listado propio no informa de
   * precio ni capacidades, se completan desde ahí. Solo debe ponerse si los precios de
   * models.dev reflejan el tier gratuito del proveedor: en los que cobran por consumo
   * (Cloudflare y sus neuronas) publican tarifas de pago y filtrar por ellas dejaría
   * el catálogo vacío.
   */
  modelsDevKey?: string;

  /** Cuándo se verificaron por última vez estos datos contra el proveedor. */
  verifiedOn?: string;
  /** Aviso que el panel enseña junto al proveedor. */
  warning?: string;
}

interface ProvidersFile {
  _meta?: unknown;
  providers: ProviderDescriptor[];
}

let cached: ProviderDescriptor[] | null = null;

export function loadDescriptors(): ProviderDescriptor[] {
  if (cached) return cached;
  const path = fileURLToPath(new URL('providers.json', CATALOG_DIR));
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProvidersFile;
  cached = parsed.providers;
  return cached;
}

export function reloadDescriptors(): void {
  cached = null;
  loadDescriptors();
}
