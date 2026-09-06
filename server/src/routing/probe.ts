/**
 * Medición de velocidad.
 *
 * Se miden dos cosas distintas y ambas importan:
 *   - **TTFT**: cuánto tarda en empezar. Manda en respuestas cortas y en autocompletado.
 *   - **tok/s extremo a extremo**: tokens generados entre el tiempo TOTAL de la
 *     petición. Manda en cuanto la respuesta pasa de un par de frases.
 *
 * El ritmo se mide sobre el tiempo total y no sobre el intervalo de streaming por una
 * razón concreta y comprobada: varios proveedores (los que van detrás del proxy de
 * OpenRouter) generan la respuesta entera del lado servidor y la sueltan de golpe. En
 * esos casos el "intervalo de streaming" mide la DESCARGA, no la generación, y da
 * cifras infladas hasta 3-4 veces. El tiempo total es inmune a eso: si el proveedor
 * bufferiza, el tiempo se desplaza al TTFT y el total no cambia. Y es además lo que
 * determina cuánto espera quien hizo la petición.
 *
 * Para que haya algo que medir hace falta que el modelo genere de verdad: con
 * `max_tokens: 1` solo se obtiene TTFT. Por eso el sondeo usa un prompt de tamaño medio.
 *
 * Aun así el sondeo es tacaño: respeta la cuota como cualquier petición, salta los
 * proveedores con poco margen diario y espacia las mediciones.
 */

import { callChat, iterateSSE, sseHasContent } from '../providers/chat.js';
import { getProvider } from '../providers/registry.js';
import { getProviderKeySecret, listModels, setModelEnabled, type StoredModel } from '../store.js';
import type { ProviderId } from '../providers/types.js';
import { verifyAccountFailure } from './execute.js';
import {
  allHealth,
  healthOf,
  isQuarantined,
  recordFailure,
  recordSuccess,
  resetSpeedMetrics,
  stalenessMs,
} from './health.js';
import { checkQuota, effectiveLimits, quotaStatus, reserve, settle } from './quota.js';

/**
 * Cada cuánto se vuelve a medir un modelo que nadie está usando.
 *
 * No es un número fijo, y no puede serlo: el sondeo gasta una petición real de la cuota
 * del proveedor. Medir cada modelo cada hora le cuesta a Cohere el 72 % de sus 33
 * peticiones diarias y a OpenRouter el 48 % de sus 50, mientras que a NVIDIA o Cloudflare
 * —que no tienen tope diario— no le cuesta nada. Un umbral único o arruina al pobre o
 * desaprovecha al rico.
 *
 * Así que el ritmo sale de la cuota: se reserva para sondeos una parte pequeña de las
 * peticiones diarias del proveedor y se reparte entre sus modelos.
 *
 *     sondeos_por_modelo_al_dia = rpd · PROBE_BUDGET_SHARE / nº de modelos
 *     cooldown                  = 24 h / sondeos_por_modelo_al_dia
 *
 * Un proveedor sin tope diario usa `BASE_PROBE_COOLDOWN_MS` directamente. Tres horas y no
 * una: la velocidad de un modelo no cambia de hora en hora, los que de verdad se usan ya
 * refrescan sus métricas con el tráfico real sin coste añadido, y hay proveedores sin
 * tope de peticiones que sí lo tienen de otra cosa —Cloudflare cuenta neuronas— a los que
 * 68 sondeos por hora sí les dolería. Y a un
 * proveedor tan justo que ni eso se lo pueda permitir le sale un cooldown enorme, que es
 * la respuesta correcta: con 33 peticiones al día no se gastan en medir, se mide una vez
 * en la calibración inicial y a partir de ahí manda el tráfico real, que actualiza las
 * mismas métricas sin costar nada aparte.
 */
const BASE_PROBE_COOLDOWN_MS = 3 * 60 * 60_000;
/** Parte de la cuota diaria que puede irse en sondeos. */
const PROBE_BUDGET_SHARE = 0.05;
/** No se sondea un proveedor al que le quede menos de este porcentaje de cuota diaria. */
const MIN_DAILY_HEADROOM = 0.2;
/** Techo de generación del sondeo. */
const PROBE_MAX_TOKENS = 200;
/**
 * Tope total del sondeo. Generoso a propósito: un modelo grande servido gratis puede
 * tardar de verdad más de un minuto en escribir 200 tokens, y descartarlo por lento
 * sería retirar algo que en producción funciona.
 */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Plazo para el PRIMER token, aparte del tope total.
 *
 * Un modelo que ni siquiera arranca en este tiempo no va a ser elegido jamás: la
 * puntuación de velocidad ya da cero a partir de 10 s de TTFT. Esperarle dos minutos
 * para acabar apuntando lo que ya se sabía es lo que hacía eterna la calibración
 * inicial: cuatro modelos muertos de NVIDIA se comían 480 s de los 786 s del proveedor.
 *
 * En cuanto llega el primer token este plazo se cancela y manda el tope total, para no
 * cortar a un modelo lento pero sano mientras escribe.
 */
const PROBE_FIRST_TOKEN_MS = 25_000;
/** Coste estimado de un sondeo, para reservar cuota antes de lanzarlo. */
const PROBE_TOKENS = PROBE_MAX_TOKENS + 40;
/** Pausa entre mediciones consecutivas de un mismo proveedor. */
const WARMUP_GAP_MS = 800;
/** Máximo que la calibración espera a que se libere cuota antes de rendirse. */
const MAX_QUOTA_WAIT_MS = 75_000;
/**
 * Mediciones simultáneas como mucho, sumando todos los proveedores.
 *
 * Existe un tope porque las medidas se estorban entre sí: varios streams compitiendo
 * por el mismo ancho de banda y el mismo bucle de eventos hacen que el ritmo salga más
 * bajo del real. Con seis a la vez el sesgo es despreciable —cada stream son unos pocos
 * KB/s— y la calibración baja de minutos a decenas de segundos.
 */
const MAX_CONCURRENT_PROBES = 6;
/**
 * Mediciones simultáneas dentro de un mismo proveedor.
 *
 * Igual al tope global: el semáforo global sigue mandando, así que subirlo no aumenta
 * cuántos streams compiten a la vez ni estropea las medidas. Lo único que cambia es que
 * un proveedor con muchos modelos puede aprovechar los huecos que dejan los demás al
 * terminar, en vez de ir de dos en dos mientras cuatro ranuras se quedan libres. En una
 * instalación nueva NVIDIA trae 68 modelos y era el cuello de botella de toda la
 * calibración: el resto acababa en 90 s y él tardaba 393 s.
 *
 * Las cuotas siguen protegidas: cada sondeo reserva antes de llamar y espera su hueco.
 */
const MAX_PER_PROVIDER = MAX_CONCURRENT_PROBES;

/**
 * Prompt de calibración. Ni corto ni largo a propósito: pide bastante texto como para
 * que el ritmo de generación sea medible, pero acotado para no gastar cuota. Es el
 * mismo para todos los modelos, que es lo que hace comparables las medidas.
 */
const PROBE_PROMPT = 'Escribe un párrafo de unas cien palabras explicando qué es el ciclo del agua.';

export interface Measurement {
  ttftMs: number;
  /** Tokens por segundo extremo a extremo: tokens entre el tiempo total de la petición. */
  tps: number | null;
  completionTokens: number;
  /** Detalle de la medición, para poder auditar de dónde sale la cifra. */
  detail: MeasurementDetail;
}

/**
 * Lo que hace falta para saber si una medida de ritmo es creíble.
 *
 * Un proveedor que entrega la respuesta en ráfaga (proxies que bufferizan) da un ritmo
 * altísimo que no tiene nada que ver con la velocidad real de generación: lo que se
 * está cronometrando es la descarga. Estos números permiten distinguir un caso del otro.
 */
export interface MeasurementDetail {
  /** Eventos SSE con contenido recibidos. */
  chunks: number;
  /** Tokens que reportó el proveedor, si los reportó. */
  reportedTokens: number | null;
  /** Milisegundos entre el primer evento con contenido y el fin del stream. */
  streamMs: number;
  /** Mediana del hueco entre eventos consecutivos. Cerca de 0 = llegó todo de golpe. */
  medianGapMs: number;
  /** Fracción de eventos que llegaron a menos de 1 ms del anterior. */
  burstRatio: number;
  /**
   * Segundos de generación según el propio proveedor, si los informa (Groq manda
   * `usage.completion_time`). Es la única referencia externa que tenemos para
   * contrastar nuestras cifras, así que se guarda tal cual.
   */
  providerCompletionSeconds: number | null;
  /** tok/s según el proveedor, excluyendo latencia de red. `null` si no lo informa. */
  providerTps: number | null;
}

/**
 * Mide un modelo con una petición en streaming.
 *
 * El TTFT se toma en el primer evento con contenido real (no en el que solo trae el
 * rol), y el ritmo se calcula sobre el tiempo restante: mezclarlos daría una cifra que
 * no es ni una cosa ni la otra.
 */
export async function measureModel(
  model: StoredModel,
  options: { firstTokenMs?: number } = {},
): Promise<Measurement | { error: string; kind: string }> {
  const firstTokenDeadline = options.firstTokenMs ?? PROBE_FIRST_TOKEN_MS;
  const provider = getProvider(model.providerId);
  const secret = provider ? getProviderKeySecret(model.providerId) : null;
  if (!provider || secret === null) return { error: 'Sin clave activa', kind: 'auth' };

  reserve(model.providerId, model.id, PROBE_TOKENS);

  // Dos relojes: uno corto para el primer token y el tope total para el resto. El corto
  // se cancela en cuanto el modelo arranca.
  const firstToken = new AbortController();
  let firstTokenTimer: NodeJS.Timeout | null = setTimeout(() => firstToken.abort(), firstTokenDeadline);
  const stopFirstTokenClock = (): void => {
    if (firstTokenTimer) {
      clearTimeout(firstTokenTimer);
      firstTokenTimer = null;
    }
  };

  const result = await callChat(
    provider,
    secret,
    {
      model: model.id,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_TOKENS,
      temperature: 0,
      stream: true,
    },
    { timeoutMs: PROBE_TIMEOUT_MS, signal: firstToken.signal },
  );

  if (!result.ok) {
    stopFirstTokenClock();
    if (firstToken.signal.aborted) {
      return { error: `Sin el primer token tras ${firstTokenDeadline / 1000} s`, kind: 'timeout' };
    }
    return { error: result.message, kind: result.kind };
  }

  let firstTokenAt: number | null = null;
  let previousAt: number | null = null;
  let chunks = 0;
  let chars = 0;
  let reportedTokens: number | null = null;
  let providerSeconds: number | null = null;
  const gaps: number[] = [];

  try {
    for await (const data of iterateSSE(result.response)) {
      if (data === '[DONE]') continue;
      if (sseHasContent(data)) {
        const now = performance.now();
        if (firstTokenAt === null) {
          firstTokenAt = now;
          stopFirstTokenClock();
        } else gaps.push(now - previousAt!);
        previousAt = now;
        chunks += 1;
        chars += contentLength(data);
      }
      const usage = readCompletionTokens(data);
      if (usage !== null) reportedTokens = usage;
      const seconds = readCompletionSeconds(data);
      if (seconds !== null) providerSeconds = seconds;
    }
  } catch (err) {
    stopFirstTokenClock();
    if (firstTokenAt === null && firstToken.signal.aborted) {
      return { error: `Sin el primer token tras ${firstTokenDeadline / 1000} s`, kind: 'timeout' };
    }
    return { error: err instanceof Error ? err.message : String(err), kind: 'network' };
  } finally {
    stopFirstTokenClock();
  }

  if (firstTokenAt === null) {
    return { error: 'El modelo no generó ningún token', kind: 'no_output' };
  }

  const streamEndAt = performance.now();
  const ttftMs = firstTokenAt - result.startedAt;
  const completionTokens = countTokens(reportedTokens, chunks, chars);
  const generationMs = streamEndAt - firstTokenAt;
  const totalMs = streamEndAt - result.startedAt;
  const tps = totalMs > 0 && completionTokens > 0 ? (completionTokens / totalMs) * 1000 : null;

  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const detail: MeasurementDetail = {
    chunks,
    reportedTokens,
    streamMs: generationMs,
    medianGapMs: sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0,
    burstRatio: gaps.length > 0 ? gaps.filter((gap) => gap < 1).length / gaps.length : 1,
    providerCompletionSeconds: providerSeconds,
    providerTps: providerSeconds && providerSeconds > 0 ? completionTokens / providerSeconds : null,
  };

  settle(model.providerId, model.id, PROBE_TOKENS, estimatePromptTokens() + completionTokens);
  return { ttftMs, tps, completionTokens, detail };
}

function estimatePromptTokens(): number {
  return Math.ceil(PROBE_PROMPT.length / 3.5) + 4;
}

/**
 * Cuántos tokens generó. Se prefiere lo que diga el proveedor; si no lo dice, el número
 * de eventos con contenido es un buen sustituto en streams finos, y para los que mandan
 * todo de golpe se estima por longitud del texto.
 */
function countTokens(reported: number | null, chunks: number, chars: number): number {
  if (reported !== null) return reported;
  if (chunks > 1) return chunks;
  return Math.max(1, Math.ceil(chars / 4));
}

function contentLength(data: string): number {
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning?: string } }> };
    const delta = parsed.choices?.[0]?.delta;
    return (delta?.content?.length ?? 0) + (delta?.reasoning?.length ?? 0);
  } catch {
    return 0;
  }
}

/** Groq añade `completion_time` a `usage`: segundos de generación pura, sin red. */
function readCompletionSeconds(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { usage?: { completion_time?: number } };
    const seconds = parsed.usage?.completion_time;
    return typeof seconds === 'number' && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

function readCompletionTokens(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { usage?: { completion_tokens?: number } };
    const tokens = parsed.usage?.completion_tokens;
    return typeof tokens === 'number' && tokens > 0 ? tokens : null;
  } catch {
    return null;
  }
}

/** Aplica el resultado de una medición a la salud del modelo. */
async function applyMeasurement(model: StoredModel, outcome: Awaited<ReturnType<typeof measureModel>>): Promise<boolean> {
  if ('error' in outcome) {
    recordFailure(model.providerId, model.id, outcome.kind as never, outcome.error);
    if (outcome.kind === 'auth' || outcome.kind === 'payment_required') {
      await verifyAccountFailure(model, outcome.error);
    } else if (outcome.kind === 'model_not_found') {
      // Anunciado pero no servido: se aparta en vez de reintentarse indefinidamente.
      setModelEnabled(model.providerId, model.id, false);
    }
    return false;
  }
  recordSuccess(model.providerId, model.id, outcome.ttftMs, outcome.tps);
  return true;
}

/** ¿Queda suficiente cuota diaria como para permitirse un sondeo? */
function hasHeadroom(model: StoredModel): boolean {
  const limits = effectiveLimits(model.providerId, model.id);
  if (limits.rpd === null) return true;
  const used = quotaStatus(model.providerId, model.id).dailyRequests;
  return (limits.rpd - used) / limits.rpd > MIN_DAILY_HEADROOM;
}

function probeable(model: StoredModel): boolean {
  return hasHeadroom(model) && checkQuota(model.providerId, model.id, PROBE_TOKENS).ok;
}

/** Elige el candidato que más falta hace medir, o `null` si no toca sondear nada. */
/**
 * Cada cuánto puede remedirse este modelo, según lo que le cueste a su proveedor.
 * Ver `BASE_PROBE_COOLDOWN_MS`.
 */
export function probeCooldownMs(model: StoredModel, modelsOfProvider: number): number {
  const { rpd } = effectiveLimits(model.providerId, model.id);
  if (rpd === null) return BASE_PROBE_COOLDOWN_MS;

  const perModelPerDay = (rpd * PROBE_BUDGET_SHARE) / Math.max(1, modelsOfProvider);
  if (perModelPerDay <= 0) return Number.POSITIVE_INFINITY;
  // Nunca más a menudo que la base: la cuota permite más, pero la velocidad de un modelo
  // no cambia de hora en hora y el tráfico real ya refresca la de los que se usan.
  return Math.max(BASE_PROBE_COOLDOWN_MS, 86_400_000 / perModelPerDay);
}

/**
 * Todos los modelos que toca remedir ahora mismo.
 *
 * Antes se elegía uno solo cada dos minutos, y con un catálogo de 76 modelos el bucle no
 * daba abasto ni de lejos: hacían falta 152 mediciones por hora y se hacían 30. Ahora se
 * barre la lista entera y el freno lo pone el cooldown de cada modelo, que ya está atado
 * a lo que su proveedor se puede permitir.
 */
export function pickProbeTargets(models: StoredModel[] = listModels()): StoredModel[] {
  const health = new Map(allHealth().map((state) => [`${state.providerId}:${state.modelId}`, state]));
  const porProveedor = new Map<ProviderId, number>();
  for (const model of models) porProveedor.set(model.providerId, (porProveedor.get(model.providerId) ?? 0) + 1);

  const due: Array<{ model: StoredModel; staleness: number }> = [];
  for (const model of models) {
    const state = health.get(`${model.providerId}:${model.id}`) ?? healthOf(model.providerId, model.id);
    if (isQuarantined(state)) continue;
    if (stalenessMs(state) < probeCooldownMs(model, porProveedor.get(model.providerId) ?? 1)) continue;
    if (!probeable(model)) continue;
    due.push({ model, staleness: stalenessMs(state) });
  }

  // Primero el que lleva más tiempo sin medirse.
  due.sort((a, b) => b.staleness - a.staleness);
  return due.map((x) => x.model);
}

/** Compatibilidad: el más urgente de los que tocan. */
export function pickProbeTarget(models: StoredModel[] = listModels()): StoredModel | null {
  return pickProbeTargets(models)[0] ?? null;
}

export async function probeOnce(): Promise<{ probed: string | null }> {
  const target = pickProbeTarget();
  if (!target) return { probed: null };
  await applyMeasurement(target, await measureModel(target));
  return { probed: `${target.providerId}/${target.id}` };
}

/**
 * Remide de una tacada todos los modelos a los que les toca.
 *
 * Casi siempre no toca ninguno y esto no hace nada, que es lo esperado: el freno no es la
 * frecuencia del barrido sino el cooldown de cada modelo, atado a la cuota de su
 * proveedor. Así el coste no depende del tamaño del catálogo, cosa que sí pasaba cuando
 * se medía de uno en uno.
 */
export async function probeSweep(): Promise<WarmupResult> {
  const result: WarmupResult = { measured: 0, failed: 0, skipped: 0, total: 0 };
  if (warmupRunning) return result;

  const due = pickProbeTargets();
  result.total = due.length;
  if (due.length === 0) return result;

  const byProvider = new Map<ProviderId, StoredModel[]>();
  for (const model of due) {
    const list = byProvider.get(model.providerId) ?? [];
    list.push(model);
    byProvider.set(model.providerId, list);
  }

  warmupRunning = true;
  try {
    await measureBatch(byProvider, result);
  } finally {
    warmupRunning = false;
  }
  return result;
}

export interface WarmupResult {
  measured: number;
  failed: number;
  skipped: number;
  total: number;
  alreadyRunning?: boolean;
}

/**
 * Calibración inicial: mide TODOS los modelos que aún no tienen datos.
 *
 * Sin esto el router arranca a ciegas y decide por calidad durante un buen rato,
 * porque un modelo sin medidas hereda la mediana del grupo. Se ejecuta en secuencia y
 * con pausas para no agotar el cubo por minuto de ningún proveedor.
 */
export async function warmupAll(options: { force?: boolean } = {}): Promise<WarmupResult> {
  // El flag vive aquí y no en las rutas porque hay dos disparadores —el arranque y el
  // botón del panel— y ambos tienen que ver el mismo estado.
  if (warmupRunning) return { measured: 0, failed: 0, skipped: 0, total: 0, alreadyRunning: true };
  warmupRunning = true;
  try {
    return await runWarmup(options);
  } finally {
    warmupRunning = false;
  }
}

let warmupRunning = false;

export function isWarmupRunning(): boolean {
  return warmupRunning;
}

/**
 * Mide un lote de modelos agrupados por proveedor.
 *
 * Lo usan la calibración inicial y el barrido periódico, que solo se diferencian en qué
 * modelos eligen. Cada proveedor es una API distinta con su propia cuota, así que van en
 * paralelo; el tope global sigue siendo el que protege la calidad de la medida.
 */
async function measureBatch(byProvider: Map<ProviderId, StoredModel[]>, result: WarmupResult): Promise<void> {
  const globalSlots = new Semaphore(MAX_CONCURRENT_PROBES);

  await Promise.all(
    [...byProvider.values()].map(async (models) => {
      const queue = [...models];
      const workers = Math.min(MAX_PER_PROVIDER, queue.length);

      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (queue.length > 0) {
            const model = queue.shift();
            if (!model) return;

            // Quedarse sin cuota por minuto a mitad de la calibración es lo normal: con
            // 20 req/min el cubo se llena antes de recorrer el catálogo. Esperar el
            // hueco es la diferencia entre calibrar unos pocos y calibrarlos todos.
            if (!(await waitForQuota(model))) {
              result.skipped += 1;
              continue;
            }

            const release = await globalSlots.acquire();
            try {
              const ok = await applyMeasurement(model, await measureModel(model));
              if (ok) result.measured += 1;
              else result.failed += 1;
            } finally {
              release();
            }
            await sleep(WARMUP_GAP_MS);
          }
        }),
      );
    }),
  );
}

async function runWarmup(options: { force?: boolean }): Promise<WarmupResult> {
  const models = listModels();
  const health = new Map(allHealth().map((state) => [`${state.providerId}:${state.modelId}`, state]));

  const pending = models.filter((model) => {
    if (options.force) return true;
    const state = health.get(`${model.providerId}:${model.id}`);
    // Un modelo con TTFT pero sin tok/s también hay que remedirlo: la medida vieja
    // venía de un sondeo de un solo token y no dice nada del ritmo.
    return !state || state.ttftMs === null || state.tps === null;
  });

  // Remedir sobre una media móvil que ya arrastra valores malos no los corrige: hay
  // que partir de cero para que la nueva medida sea la que manda.
  if (options.force) {
    for (const model of pending) resetSpeedMetrics(model.providerId, model.id);
  }

  const result: WarmupResult = { measured: 0, failed: 0, skipped: 0, total: pending.length };

  // Cada proveedor es una API distinta con su propia cuota, así que no hay razón para
  // esperar a uno mientras se mide otro. Dentro de un proveedor sí se va casi en serie:
  // ahí sí comparten el cubo por minuto.
  const byProvider = new Map<ProviderId, StoredModel[]>();
  for (const model of pending) {
    const list = byProvider.get(model.providerId) ?? [];
    list.push(model);
    byProvider.set(model.providerId, list);
  }

  // Dentro de cada proveedor, primero los de más calidad. La calibración completa de un
  // catálogo grande dura minutos, y durante ese rato el router decide con medianas; que
  // los candidatos que de verdad va a elegir tengan su medida en los primeros segundos
  // importa mucho más que el orden del resto de la cola.
  for (const list of byProvider.values()) {
    list.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
  }

  await measureBatch(byProvider, result);
  return result;
}

/** Espera a que haya hueco de cuota para este modelo. `false` si no lo hay a tiempo. */
async function waitForQuota(model: StoredModel): Promise<boolean> {
  if (probeable(model)) return true;
  if (!hasHeadroom(model)) return false;

  const verdict = checkQuota(model.providerId, model.id, PROBE_TOKENS);
  const wait = verdict.retryInMs ?? 0;
  // Solo se espera a un cubo por minuto. Una cuota diaria agotada tarda horas en
  // reponerse y no tiene sentido bloquear la calibración por ella.
  if (wait <= 0 || wait > MAX_QUOTA_WAIT_MS) return false;

  await sleep(wait + 500);
  return probeable(model);
}

/** Semáforo mínimo para limitar cuántas mediciones corren a la vez. */
class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Comprueba cada minuto si hay algo que remedir. Barato: si nada ha cumplido su
 * cooldown, no se hace ni una llamada.
 */
export function startProbeLoop(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void probeSweep().catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return timer;
}
