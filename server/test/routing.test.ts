/**
 * Tests de la lógica de enrutado. Nada de red: todo lo que aquí se prueba son
 * decisiones puras (scoring, filtrado, cuota) sobre una base de datos en memoria.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, useInMemoryDb } from '../src/db.js';
import { PROFILE_WEIGHTS, scoreCandidates, type Candidate } from '../src/routing/score.js';
import {
  checkQuota,
  clearRateLimitStreak,
  penalize,
  quotaStatus,
  reserve,
  msUntilUtcMidnight,
  resetQuotaState,
  settle,
} from '../src/routing/quota.js';
import { getProvider } from '../src/providers/registry.js';
import { computeTps } from '../src/routing/execute.js';
import { explainNoCandidates, requiredCapabilities, route } from '../src/routing/select.js';
import { estimateTokens, requestUsesTools } from '../src/routing/tokens.js';
import { recordFailure, recordSuccess, healthOf, isQuarantined } from '../src/routing/health.js';
import type { HealthState } from '../src/routing/health.js';
import type { StoredModel } from '../src/store.js';
import { listModels, replaceModels, saveProviderKey } from '../src/store.js';
import type { ProviderId } from '../src/providers/types.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { buildProvider, splitCredential } from '../src/providers/generic.js';
import { resetModelsDevCache } from '../src/providers/modelsdev.js';
import { normalizeSlug, tokenKey } from '../src/catalog/index.js';

function model(overrides: Partial<StoredModel> & { id: string; providerId: ProviderId }): StoredModel {
  return {
    displayName: overrides.id,
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    qualityScore: 50,
    qualitySource: 'measured',
    enabled: true,
    ...overrides,
  };
}

function health(overrides: Partial<HealthState> & { providerId: ProviderId; modelId: string }): HealthState {
  return {
    ttftMs: null,
    tps: null,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    quarantinedUntil: null,
    samples: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useInMemoryDb();
  resetQuotaState();
});

after(() => closeDb());

describe('scoring por perfil', () => {
  const fastButDumb = model({ providerId: 'groq', id: 'rapido-tonto', qualityScore: 30 });
  const slowButSmart = model({ providerId: 'openrouter', id: 'lento-listo', qualityScore: 90 });

  const candidates: Candidate[] = [
    { model: fastButDumb, health: health({ providerId: 'groq', modelId: 'rapido-tonto', ttftMs: 150, samples: 10 }) },
    { model: slowButSmart, health: health({ providerId: 'openrouter', modelId: 'lento-listo', ttftMs: 3000, samples: 10 }) },
  ];

  it('el perfil rápido elige el de menor TTFT aunque tenga menos calidad', () => {
    const scored = scoreCandidates(candidates, 'rapido');
    assert.equal(scored[0]?.model.id, 'rapido-tonto');
  });

  it('el perfil calidad elige el de mayor Intelligence Index aunque sea lento', () => {
    const scored = scoreCandidates(candidates, 'calidad');
    assert.equal(scored[0]?.model.id, 'lento-listo');
  });

  it('los pesos de cada perfil suman 1', () => {
    for (const weights of Object.values(PROFILE_WEIGHTS)) {
      assert.equal(weights.quality + weights.speed, 1);
    }
  });

  it('un modelo sin medidas no queda por debajo del más lento del grupo', () => {
    const cold = model({ providerId: 'cerebras', id: 'frio', qualityScore: 30 });
    const scored = scoreCandidates(
      [...candidates, { model: cold, health: health({ providerId: 'cerebras', modelId: 'frio' }) }],
      'rapido',
    );
    const coldScore = scored.find((c) => c.model.id === 'frio')!;
    const slowScore = scored.find((c) => c.model.id === 'lento-listo')!;
    // Hereda la mediana, así que debe quedar por delante del peor medido.
    assert.ok(coldScore.speedNorm > slowScore.speedNorm);
  });

  it('el perfil calidad puede llegar a 1: la calidad se normaliza como la velocidad', () => {
    // Si la calidad se dividiera entre 100 nunca pasaría de 0,6 con modelos abiertos,
    // y el peso de 0,85 del perfil `calidad` valdría en la práctica mucho menos.
    const scored = scoreCandidates(candidates, 'calidad');
    assert.equal(scored[0]?.qualityNorm, 1);
    assert.equal(scored[0]?.score, PROFILE_WEIGHTS.calidad.quality + PROFILE_WEIGHTS.calidad.speed * scored[0]!.speedNorm);
  });

  it('un modelo solo estimado no adelanta a uno medido mejor', () => {
    // Las heurísticas viven en la misma escala que el índice real justo para esto.
    const measured = model({ providerId: 'groq', id: 'medido', qualityScore: 45 });
    const estimated = { ...model({ providerId: 'cerebras', id: 'estimado', qualityScore: 24 }), qualitySource: 'estimated' as const };
    const scored = scoreCandidates(
      [
        { model: measured, health: health({ providerId: 'groq', modelId: 'medido', ttftMs: 1000, samples: 5 }) },
        { model: estimated, health: health({ providerId: 'cerebras', modelId: 'estimado', ttftMs: 1000, samples: 5 }) },
      ],
      'calidad',
    );
    assert.equal(scored[0]?.model.id, 'medido');
  });

  it('los tokens por segundo pesan más que el TTFT', () => {
    // Arrancar 200 ms antes no compensa generar a un tercio de velocidad: en una
    // respuesta de cien tokens se nota mucho más el ritmo que el arranque.
    const arrancaAntes = model({ providerId: 'groq', id: 'arranca-antes' });
    const generaRapido = model({ providerId: 'cerebras', id: 'genera-rapido' });
    const scored = scoreCandidates(
      [
        {
          model: arrancaAntes,
          health: health({ providerId: 'groq', modelId: 'arranca-antes', ttftMs: 100, tps: 30, samples: 5 }),
        },
        {
          model: generaRapido,
          health: health({ providerId: 'cerebras', modelId: 'genera-rapido', ttftMs: 300, tps: 300, samples: 5 }),
        },
      ],
      'rapido',
    );
    assert.equal(scored[0]?.model.id, 'genera-rapido');
  });

  it('la puntuación de un modelo no depende de quién más esté en el grupo', () => {
    // La escala es absoluta, no relativa. Con normalización contra el grupo, este mismo
    // modelo sacaba un 1 estando solo y bajaba al entrar otro más rápido: su nota
    // dependía de la compañía, no de él.
    const solo = {
      model: model({ providerId: 'groq', id: 'solo' }),
      health: health({ providerId: 'groq', modelId: 'solo', ttftMs: 150, tps: 100, samples: 5 }),
    };
    const veloz = {
      model: model({ providerId: 'cerebras', id: 'veloz' }),
      health: health({ providerId: 'cerebras', modelId: 'veloz', ttftMs: 50, tps: 900, samples: 5 }),
    };

    const aSolas = scoreCandidates([solo], 'rapido')[0];
    const acompanado = scoreCandidates([solo, veloz], 'rapido').find((c) => c.model.id === 'solo');

    assert.equal(aSolas?.speedNorm, acompanado?.speedNorm);
    assert.equal(aSolas?.qualityNorm, acompanado?.qualityNorm);
    assert.equal(aSolas?.score, acompanado?.score);
  });

  it('por encima de 200 tok/s la velocidad extra ya no compra puntos', () => {
    // Era lo que ponía a allam-2-7b (calidad 11, 667 tok/s) por delante de modelos
    // mucho más capaces: bastaba ser el más rápido para llevarse el máximo.
    const rapidisimo = scoreCandidates(
      [{ model: model({ providerId: 'groq', id: 'a' }), health: health({ providerId: 'groq', modelId: 'a', ttftMs: 200, tps: 900, samples: 5 }) }],
      'rapido',
    )[0];
    const suficiente = scoreCandidates(
      [{ model: model({ providerId: 'groq', id: 'b' }), health: health({ providerId: 'groq', modelId: 'b', ttftMs: 200, tps: 200, samples: 5 }) }],
      'rapido',
    )[0];
    assert.equal(rapidisimo?.speedNorm, suficiente?.speedNorm, '900 y 200 tok/s valen lo mismo');

    const lento = scoreCandidates(
      [{ model: model({ providerId: 'groq', id: 'c' }), health: health({ providerId: 'groq', modelId: 'c', ttftMs: 200, tps: 20, samples: 5 }) }],
      'rapido',
    )[0];
    assert.ok((lento?.speedNorm ?? 1) < (suficiente?.speedNorm ?? 0), 'por debajo del techo sí se nota');
  });

  it('un modelo muy rápido pero muy flojo no gana ni en el perfil rápido', () => {
    // El caso real: con el mismo prompt, al fallar el primer candidato el router caía en
    // un modelo de calidad 11 solo porque iba a 667 tok/s.
    const scored = scoreCandidates(
      [
        {
          model: model({ providerId: 'groq', id: 'flojo-y-veloz', qualityScore: 11 }),
          health: health({ providerId: 'groq', modelId: 'flojo-y-veloz', ttftMs: 350, tps: 667, samples: 5 }),
        },
        {
          model: model({ providerId: 'groq', id: 'capaz', qualityScore: 41 }),
          health: health({ providerId: 'groq', modelId: 'capaz', ttftMs: 2700, tps: 172, samples: 5 }),
        },
      ],
      'rapido',
    );
    assert.equal(scored[0]?.model.id, 'capaz');
  });

  it('la calidad bajo el suelo hunde la puntuación, pero no expulsa al modelo', () => {
    const scored = scoreCandidates(
      [
        {
          model: model({ providerId: 'cloudflare', id: 'inservible', qualityScore: 1 }),
          health: health({ providerId: 'cloudflare', modelId: 'inservible', ttftMs: 130, tps: 250, samples: 5 }),
        },
        {
          model: model({ providerId: 'groq', id: 'normal', qualityScore: 30 }),
          health: health({ providerId: 'groq', modelId: 'normal', ttftMs: 900, tps: 90, samples: 5 }),
        },
      ],
      'rapido',
    );
    // Perfecto en velocidad y aun así el último: un modelo de calidad 1 no sirve por
    // rápido que sea.
    assert.equal(scored[0]?.model.id, 'normal');
    assert.equal(scored[1]?.model.id, 'inservible');
    // Pero sigue en la lista: mejor un modelo malo que ningún modelo.
    assert.equal(scored.length, 2);
    assert.ok((scored[1]?.score ?? 1) > 0);
  });
});

describe('tokens por segundo', () => {
  const usage = (completionTokens: number) => ({ promptTokens: 30, completionTokens });

  it('mide sobre el tiempo total de la petición', () => {
    // 120 tokens en 1,2 s de reloj = 100 tok/s.
    assert.equal(computeTps(usage(120), 200, 1200), 100);
  });

  it('no depende de dónde bufferice el proveedor', () => {
    // Mismo trabajo y mismo tiempo total, repartido de dos formas: uno transmite token
    // a token (TTFT bajo) y otro genera entero del lado servidor y lo suelta de golpe
    // (TTFT alto, descarga instantánea). Medir sobre el intervalo de streaming daría al
    // segundo una cifra disparatada; sobre el total, ambos valen lo mismo.
    const progresivo = computeTps(usage(120), 100, 1200);
    const enRafaga = computeTps(usage(120), 1150, 1200);
    assert.equal(progresivo, enRafaga);
  });

  it('ignora las respuestas demasiado cortas para dar una tasa estable', () => {
    assert.equal(computeTps(usage(3), 200, 1200), null);
  });

  it('devuelve null sin datos de uso', () => {
    assert.equal(computeTps(null, 200, 1200), null);
  });
});

describe('cuota', () => {
  beforeEach(() => {
    saveProviderKey('cerebras', 'csk-test', { rpm: 2, tpm: 1000, rpd: null, tpd: null });
  });

  it('agota el cubo por minuto y luego lo bloquea', () => {
    assert.equal(checkQuota('cerebras', 'm', 10).ok, true);
    reserve('cerebras', 'm', 10);
    reserve('cerebras', 'm', 10);
    const verdict = checkQuota('cerebras', 'm', 10);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /minuto/);
  });

  it('rechaza cuando la petición no cabe en el presupuesto de tokens por minuto', () => {
    const verdict = checkQuota('cerebras', 'm', 5000);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /tokens por minuto/);
  });

  it('la cuota diaria de OpenRouter se comparte entre todos sus modelos', () => {
    saveProviderKey('openrouter', 'sk-or-test', { rpm: 100, tpm: null, rpd: 2, tpd: null });
    reserve('openrouter', 'modelo-a', 10);
    reserve('openrouter', 'modelo-b', 10);
    // El cubo es de cuenta: gastar en dos modelos distintos agota igual.
    const verdict = checkQuota('openrouter', 'modelo-c', 10);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /diaria/);
  });

  it('la cuota de Groq es por modelo, no por cuenta', () => {
    saveProviderKey('groq', 'gsk-test', { rpm: 1, tpm: null, rpd: null, tpd: null });
    reserve('groq', 'modelo-a', 10);
    assert.equal(checkQuota('groq', 'modelo-a', 10).ok, false);
    assert.equal(checkQuota('groq', 'modelo-b', 10).ok, true);
  });

  it('settle corrige la reserva con el consumo real', () => {
    reserve('cerebras', 'm', 900);
    settle('cerebras', 'm', 900, 100);
    // Tras corregir a 100 tokens vuelve a caber una petición de 800.
    assert.equal(checkQuota('cerebras', 'm', 800).ok, true);
  });
});

describe('castigo tras un 429', () => {
  const MINUTO = 60_000;

  it('el primero cuesta un minuto', () => {
    resetQuotaState();
    penalize('groq', 'm', null);
    const espera = quotaStatus('groq', 'm').cooldownMs;
    assert.ok(espera > MINUTO * 0.9 && espera <= MINUTO, `esperaba ~1 min, fue ${espera}`);
  });

  it('en OpenRouter el castigo va multiplicado por cuatro', () => {
    // Equivocarse ahí sale caro: el fallo tarda siete veces más que en Groq (532 ms
    // frente a 76 ms de mediana, medido con tráfico real) y encima gasta una de las 50
    // peticiones diarias, porque las fallidas también cuentan.
    resetQuotaState();
    penalize('groq', 'm', null);
    penalize('openrouter', 'm', null);

    const groq = quotaStatus('groq', 'm').cooldownMs;
    const openrouter = quotaStatus('openrouter', 'm').cooldownMs;
    assert.ok(
      openrouter > groq * 3.5 && openrouter <= groq * 4.2,
      `OpenRouter debe esperar ~4 veces más: ${openrouter} frente a ${groq}`,
    );
    assert.ok(openrouter > MINUTO * 3.5 && openrouter <= MINUTO * 4, `esperaba ~4 min, fue ${openrouter}`);
  });

  it('el multiplicador de OpenRouter sale del catálogo, no del código', () => {
    // Un proveedor es datos: si mañana OpenRouter deja de ser caro, se cambia el número
    // en providers.json y nadie toca el enrutado.
    assert.equal(getProvider('openrouter')?.rateLimitPenaltyFactor, 4);
    assert.equal(getProvider('groq')?.rateLimitPenaltyFactor, 1);
  });

  it('si se repite, se dobla', () => {
    // Un castigo fijo no vale para los dos casos: con uno corto, un modelo agotado de
    // verdad se reintenta sin parar —y en OpenRouter cada intento gasta una de las 50
    // peticiones diarias, porque las fallidas también cuentan.
    resetQuotaState();
    const esperas: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      penalize('groq', 'm', null);
      esperas.push(quotaStatus('groq', 'm').cooldownMs);
    }
    assert.ok(esperas[1]! > esperas[0]! * 1.8, '1 → 2 minutos');
    assert.ok(esperas[2]! > esperas[1]! * 1.8, '2 → 4 minutos');
    assert.ok(esperas[3]! > esperas[2]! * 1.8, '4 → 8 minutos');
  });

  it('una petición que sale bien devuelve el castigo al mínimo', () => {
    // El modelo ha demostrado que vuelve a servir: no puede seguir arrastrando la racha.
    resetQuotaState();
    penalize('groq', 'm', null);
    penalize('groq', 'm', null);
    penalize('groq', 'm', null);

    clearRateLimitStreak('groq', 'm');
    penalize('groq', 'm', null);

    const espera = quotaStatus('groq', 'm').cooldownMs;
    assert.ok(espera <= MINUTO, `tras recuperarse debe volver a costar un minuto, fue ${espera}`);
  });

  it('si el proveedor dice cuándo volver, manda su cifra', () => {
    resetQuotaState();
    penalize('groq', 'm', 30_000);
    const espera = quotaStatus('groq', 'm').cooldownMs;
    assert.ok(espera > 25_000 && espera <= 30_000, `esperaba los 30 s que pidió, fue ${espera}`);
  });

  it('nunca se castiga más allá del reinicio diario', () => {
    // Pasada esa hora la cuota vuelve sola; seguir apartándolo sería tirar un modelo
    // que ya funciona.
    resetQuotaState();
    for (let i = 0; i < 20; i += 1) penalize('openrouter', 'm', null);
    const espera = quotaStatus('openrouter', 'm').cooldownMs;
    assert.ok(espera <= msUntilUtcMidnight() + 1000, `no debe pasar del reinicio, fue ${espera}`);
  });
});

describe('filtrado de candidatos', () => {
  beforeEach(() => {
    saveProviderKey('groq', 'gsk-test', { rpm: 100, tpm: null, rpd: null, tpd: null });
  });

  const textOnly = model({ providerId: 'groq', id: 'solo-texto' });
  const visionModel = model({ providerId: 'groq', id: 'con-vision', inputModalities: ['text', 'image'] });
  const noTools = model({ providerId: 'groq', id: 'sin-tools', supportsTools: false });
  const shortContext = model({ providerId: 'groq', id: 'contexto-corto', contextLength: 100 });

  const smallEstimate = estimateTokens({ messages: [{ role: 'user', content: 'hola' }] });

  it('descarta los modelos sin la capacidad exigida', () => {
    const result = route(
      { profile: 'balanceado', capabilities: ['vision'], estimate: smallEstimate, usesTools: false },
      [textOnly, visionModel],
    );
    assert.equal(result.chain.length, 1);
    assert.equal(result.chain[0]?.model.id, 'con-vision');
    assert.match(result.rejected[0]?.reason ?? '', /no soporta: vision/);
  });

  it('exige visión cuando la petición trae una imagen, aunque la key no la pidiera', () => {
    const withImage = estimateTokens({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }],
    });
    const required = requiredCapabilities({
      profile: 'balanceado',
      capabilities: [],
      estimate: withImage,
      usesTools: false,
    });
    assert.deepEqual(required, ['vision']);
  });

  it('exige tool use cuando la petición define herramientas', () => {
    const body = { messages: [{ role: 'user', content: 'hola' }], tools: [{ type: 'function' }] };
    const result = route(
      {
        profile: 'balanceado',
        capabilities: [],
        estimate: estimateTokens(body),
        usesTools: requestUsesTools(body),
      },
      [noTools, textOnly],
    );
    assert.equal(result.chain.length, 1);
    assert.equal(result.chain[0]?.model.id, 'solo-texto');
  });

  it('descarta los modelos cuyo contexto no da para la petición', () => {
    const result = route(
      { profile: 'balanceado', capabilities: [], estimate: smallEstimate, usesTools: false },
      [shortContext],
    );
    assert.equal(result.chain.length, 0);
    assert.match(result.rejected[0]?.reason ?? '', /contexto insuficiente/);
  });

  it('descarta los modelos en cuarentena', () => {
    for (let i = 0; i < 3; i += 1) {
      recordFailure('groq', 'solo-texto', 'server', 'boom');
    }
    const result = route(
      { profile: 'balanceado', capabilities: [], estimate: smallEstimate, usesTools: false },
      [textOnly, visionModel],
    );
    assert.ok(!result.chain.some((candidate) => candidate.model.id === 'solo-texto'));
    assert.match(result.rejected[0]?.reason ?? '', /cuarentena/);
  });

  it('el 503 explica por qué no hay candidatos', () => {
    const result = route(
      { profile: 'balanceado', capabilities: ['image_output'], estimate: smallEstimate, usesTools: false },
      [textOnly, visionModel],
    );
    assert.equal(result.chain.length, 0);
    const message = explainNoCandidates(result);
    assert.match(message, /image_output/);
    assert.match(message, /2 modelos/);
  });
});

describe('cadena de failover', () => {
  beforeEach(() => {
    for (const id of ['groq', 'cerebras', 'openrouter'] as ProviderId[]) {
      saveProviderKey(id, `${id}-test`, { rpm: 100, tpm: null, rpd: null, tpd: null });
    }
  });

  it('deja OpenRouter en último lugar de los reintentos', () => {
    const models = [
      model({ providerId: 'openrouter', id: 'or-1', qualityScore: 60 }),
      model({ providerId: 'groq', id: 'groq-1', qualityScore: 55 }),
      model({ providerId: 'cerebras', id: 'cer-1', qualityScore: 50 }),
    ];
    const result = route(
      {
        profile: 'calidad',
        capabilities: [],
        estimate: estimateTokens({ messages: [{ role: 'user', content: 'hola' }] }),
        usesTools: false,
      },
      models,
    );
    // El primero lo decide la puntuación; el resto se ordena por failoverRank, así que
    // OpenRouter nunca puede quedar por delante de Groq o Cerebras en los reintentos.
    const tail = result.chain.slice(1).map((candidate) => candidate.model.providerId);
    const openrouterIndex = tail.indexOf('openrouter');
    if (openrouterIndex !== -1) {
      assert.equal(openrouterIndex, tail.length - 1);
    }
  });
});

describe('salud', () => {
  it('tres fallos consecutivos ponen el modelo en cuarentena', () => {
    recordFailure('groq', 'm', 'server', 'boom');
    recordFailure('groq', 'm', 'server', 'boom');
    assert.equal(isQuarantined(healthOf('groq', 'm')), false);
    recordFailure('groq', 'm', 'server', 'boom');
    assert.equal(isQuarantined(healthOf('groq', 'm')), true);
  });

  it('un 429 no cuenta como avería: de eso se encarga la cuota', () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure('groq', 'm', 'rate_limit', 'too many requests');
    }
    assert.equal(isQuarantined(healthOf('groq', 'm')), false);
  });

  it('lo que falla sin parar acaba apartado, no reintentándose para siempre', () => {
    // La cuarentena con backoff sirve para caídas pasajeras. Pasado cierto punto el
    // modelo lleva más de media hora fallando y cada reintento es cuota tirada.
    saveProviderKey('groq', 'gsk-test', { rpm: 100, tpm: null, rpd: null, tpd: null });
    replaceModels('groq', [
      {
        providerId: 'groq',
        id: 'insistente',
        displayName: 'insistente',
        contextLength: 8192,
        maxCompletionTokens: null,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        qualityScore: 30,
        qualitySource: 'measured',
      },
    ]);

    for (let i = 0; i < 7; i += 1) recordFailure('groq', 'insistente', 'server', 'boom');
    assert.equal(listModels(false)[0]?.enabled, true, 'todavía se le dan oportunidades');

    recordFailure('groq', 'insistente', 'server', 'boom');
    assert.equal(listModels(false)[0]?.enabled, false, 'al octavo fallo seguido se aparta');
  });

  it('un éxito limpia la cuarentena y suaviza el TTFT', () => {
    recordSuccess('groq', 'm', 1000, null);
    recordSuccess('groq', 'm', 2000, null);
    const state = healthOf('groq', 'm');
    // EWMA con alpha 0.3: 1000 -> 1000*0.7 + 2000*0.3 = 1300
    assert.equal(Math.round(state.ttftMs ?? 0), 1300);
    assert.equal(state.consecutiveFailures, 0);
  });
});

describe('estimación de tokens', () => {
  it('cuenta las imágenes y las marca', () => {
    const estimate = estimateTokens({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: {} }] }],
    });
    assert.equal(estimate.hasImages, true);
    assert.ok(estimate.prompt > 800);
  });

  it('reserva sitio para la respuesta', () => {
    const estimate = estimateTokens({ messages: [{ role: 'user', content: 'hola' }], max_tokens: 500 });
    assert.equal(estimate.total, estimate.prompt + 500);
  });
});

describe('cifrado', () => {
  it('sabe cifrar y descifrar una clave vacía', () => {
    // Los proveedores con clave opcional guardan cadena vacía. Un texto vacío cifra a
    // exactamente IV+tag, que es el caso límite del validador de longitud.
    assert.equal(decrypt(encrypt('')), '');
  });

  it('descifra una clave normal', () => {
    assert.equal(decrypt(encrypt('gsk_prueba_1234')), 'gsk_prueba_1234');
  });
});

describe('credenciales de dos partes', () => {
  it('separa id de cuenta y token', () => {
    assert.deepEqual(splitCredential('cuenta123:tok_abc'), { account: 'cuenta123', token: 'tok_abc' });
  });

  it('corta por el primer dos puntos, porque el token puede llevar más', () => {
    assert.deepEqual(splitCredential('cuenta:a:b:c'), { account: 'cuenta', token: 'a:b:c' });
  });

  it('sin dos puntos lo trata todo como token, para que el error lo dé el proveedor', () => {
    assert.deepEqual(splitCredential('solo-token'), { account: '', token: 'solo-token' });
  });
});

describe('emparejado de modelos con Artificial Analysis', () => {
  const igual = (a: string, b: string) => assert.equal(tokenKey(a), tokenKey(b), `${a} debería casar con ${b}`);
  const distinto = (a: string, b: string) => assert.notEqual(tokenKey(a), tokenKey(b), `${a} NO debe casar con ${b}`);

  it('quita todos los segmentos de ruta, no solo el primero', () => {
    // Cloudflare usa ids con dos: quedarse a medias dejaba `meta/llama…` y no casaba nada.
    assert.equal(normalizeSlug('@cf/meta/llama-3.2-3b-instruct'), 'llama3-2-3b-instruct');
    assert.equal(normalizeSlug('qwen/qwen3.8-27b'), 'qwen3-8-27b');
  });

  it('ignora los sufijos de servido, que no cambian el modelo', () => {
    assert.equal(normalizeSlug('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), 'llama3-3-70b-instruct');
    assert.equal(normalizeSlug('codestral-latest'), 'codestral');
  });

  it('casa aunque el orden de los términos cambie', () => {
    // Artificial Analysis pega el tamaño al sufijo; los proveedores lo ponen antes.
    igual('meta/llama-3.3-70b-instruct', 'llama3-3-instruct70b');
    igual('google/gemma-4-31b-it', 'gemma4-31b');
    igual('claude-haiku-4-5', 'claude4-5-haiku');
  });

  it('trata los dos puntos como separador', () => {
    // Ollama escribe `gemma4:31b` y LLM7 `deepseek-v4-flash:0731`.
    assert.equal(normalizeSlug('gemma4:31b'), 'gemma4-31b');
    assert.equal(normalizeSlug('deepseek-v4-flash:0731'), 'deepseek-v4-flash0731');
    // `:free` se sigue quitando entero, no se convierte en un término más.
    assert.equal(normalizeSlug('z-ai/glm-5.2:free'), 'glm5-2');
  });

  it('no trata `fast` suelto como sufijo de servido', () => {
    // `-fp8-fast` sí es forma de servir; `grok-4-fast` es OTRO modelo, con 10,5 frente
    // a los 26,5 de `grok-4`. Confundirlos daba una nota equivocada según qué página
    // del catálogo llegase la última.
    assert.equal(normalizeSlug('grok-4-fast'), 'grok4-fast');
    assert.notEqual(normalizeSlug('grok-4-fast'), normalizeSlug('grok-4'));
    assert.equal(normalizeSlug('llama-3.3-70b-instruct-fp8-fast'), 'llama3-3-70b-instruct');
  });

  it('no confunde variantes que sí tienen puntuación distinta', () => {
    // `reasoning` y los niveles de esfuerzo son modelos distintos: emparejarlos daría
    // una nota equivocada con aspecto de dato medido, que es peor que no tener nota.
    distinto('qwen3-30b-a3b-instruct', 'qwen3-30b-a3b-instruct-reasoning');
    distinto('gpt-oss-120b', 'gpt-oss-120b-high');
    distinto('llama-3.1-8b-instruct', 'llama-3.1-70b-instruct');
  });
});

describe('metadatos de models.dev', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetModelsDevCache();
  });

  /** Proveedor que solo publica ids, como OpenCode Zen. */
  const descriptor = {
    id: 'prueba',
    label: 'Prueba',
    baseUrl: 'https://ejemplo.test/v1',
    keyHint: '…',
    consoleUrl: 'https://ejemplo.test',
    failoverRank: 5,
    quotaScope: 'account' as const,
    defaultLimits: { rpm: 10, tpm: null, rpd: null, tpd: null },
    freeTier: { renewing: true, note: '' },
    freeOnly: true,
    publicModelList: true,
    modelsDevKey: 'prueba',
  };

  function stub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return new Response(
          JSON.stringify({
            prueba: {
              models: {
                gratis: { cost: { input: 0, output: 0 }, limit: { context: 200000 }, tool_call: true },
                depago: { cost: { input: 1.5, output: 6 }, limit: { context: 200000 }, tool_call: true },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'gratis' }, { id: 'depago' }, { id: 'desconocido' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('deja fuera los modelos de pago que el proveedor no marca como tales', async () => {
    // OpenCode Zen sirve 70 modelos y su listado solo dice el id: sin el precio de
    // models.dev, un Claude de pago entraría en el enrutado y costaría dinero.
    stub();
    const models = await buildProvider(descriptor).listModels('');
    assert.deepEqual(models.map((m) => m.id), ['gratis']);
  });

  it('un modelo sin precio conocido no se cuela por si acaso', async () => {
    // `desconocido` no está en models.dev: mejor perder un modelo que facturar sin querer.
    stub();
    const models = await buildProvider(descriptor).listModels('');
    assert.ok(!models.some((m) => m.id === 'desconocido'));
  });

  it('el catálogo depende de si hay clave: sin ella se descartan los que la exigen', async () => {
    // LLM7 marca con `usage_based_only` los modelos que necesitan cuenta identificada.
    // Su listado es idéntico con clave y sin ella, así que la única señal es ese campo:
    // sin clave está comprobado que responden `model_credentials_unavailable`, y
    // descubrirlo fallando cuesta una petición por modelo.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'abierto', usage_based_only: false },
            { id: 'con-cuenta', usage_based_only: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const abierto = { ...descriptor, freeOnly: false, modelsDevKey: undefined };
    const sinClave = await buildProvider(abierto).listModels('');
    const conClave = await buildProvider(abierto).listModels('un-token');

    assert.deepEqual(sinClave.map((m) => m.id), ['abierto']);
    assert.deepEqual(conClave.map((m) => m.id), ['abierto', 'con-cuenta']);
  });

  it('toma contexto y tool use de models.dev cuando el proveedor no los informa', async () => {
    stub();
    const [model] = await buildProvider(descriptor).listModels('');
    assert.equal(model?.contextLength, 200000);
    assert.equal(model?.supportsTools, true);
  });
});
