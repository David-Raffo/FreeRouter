/**
 * Rutas del panel.
 *
 * Lo que se prueba aquí sobre todo es que el id de un modelo no viaje en la ruta. Los
 * ids llevan barras —`deepseek-ai/deepseek-v4-pro-0813`, `@cf/meta/llama-3.2-3b-instruct`—
 * y eso convirtió el botón de desactivar en un adorno para media docena de proveedores:
 * el panel las escapaba bien, pero el proxy inverso de delante las decodificaba antes de
 * reenviar y a Fastify le llegaba una ruta que no existe.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closeDb, useInMemoryDb } from '../src/db.js';
import { resetLoginThrottle } from '../src/auth.js';
import { listModels, replaceModels, saveProviderKey } from '../src/store.js';
import type { ModelInfo } from '../src/providers/types.js';
import { buildServer } from '../src/index.js';

const PASSWORD = 'contraseña-de-prueba';

/** Ids reales de proveedores que tenemos conectados, con todo lo que rompe una ruta. */
const IDS_DIFICILES = [
  'deepseek-ai/deepseek-v4-pro-0813',
  '@cf/meta/llama-3.2-3b-instruct',
  'z-ai/glm-5.2:free',
  'sin-barra-ninguna',
];

let app: FastifyInstance;
let cookie: string;

function model(id: string): ModelInfo {
  return {
    providerId: 'nvidia',
    id,
    displayName: id,
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    qualityScore: 40,
    qualitySource: 'measured',
    requiresIdentifiedAccount: false,
  };
}

beforeEach(async () => {
  useInMemoryDb();
  resetLoginThrottle();
  process.env.FREEROUTER_PASSWORD = PASSWORD;
  app = await buildServer();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { password: PASSWORD },
  });
  const raw = login.headers['set-cookie'];
  cookie = String((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '';

  saveProviderKey('nvidia', 'clave-falsa', { rpm: 30, tpm: null, rpd: null, tpd: null });
  replaceModels('nvidia', IDS_DIFICILES.map(model));
});

afterEach(async () => {
  await app.close();
  closeDb();
  delete process.env.FREEROUTER_PASSWORD;
});

const estado = (id: string): boolean | undefined =>
  listModels(false).find((m) => m.id === id)?.enabled;

describe('activar y desactivar modelos', () => {
  it('funciona con cualquier id, lleve barras, arrobas o dos puntos', async () => {
    for (const id of IDS_DIFICILES) {
      assert.equal(estado(id), true, `${id} debería empezar activo`);

      const apagar = await app.inject({
        method: 'POST',
        url: '/api/models/enabled',
        headers: { cookie, 'content-type': 'application/json' },
        payload: { providerId: 'nvidia', modelId: id, enabled: false },
      });

      assert.equal(apagar.statusCode, 200, `no se pudo desactivar ${id}`);
      assert.equal(estado(id), false, `${id} sigue activo tras desactivarlo`);
    }
  });

  it('vuelve a activarlos', async () => {
    const id = IDS_DIFICILES[0]!;
    await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'nvidia', modelId: id, enabled: false },
    });
    const encender = await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'nvidia', modelId: id, enabled: true },
    });
    assert.equal(encender.statusCode, 200);
    assert.equal(estado(id), true);
  });

  it('la ruta vieja se rompe si un proxy decodifica la barra, que es el fallo original', async () => {
    // Así es exactamente como le llegaba a Fastify en el servidor del usuario: el panel
    // mandaba `%2F` y el proxy de delante lo devolvía a `/` antes de reenviar. Ninguna
    // ruta encaja con eso, así que 404 y el botón parecía no hacer nada.
    const comoLoDejaUnProxy = await app.inject({
      method: 'POST',
      url: '/api/models/deepseek-ai/deepseek-v4-pro-0813/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'nvidia', enabled: false },
    });
    assert.equal(comoLoDejaUnProxy.statusCode, 404);
    assert.equal(estado('deepseek-ai/deepseek-v4-pro-0813'), true, 'y el modelo se queda como estaba');

    // Con el id en el cuerpo no hay ruta que normalizar, así que da igual lo que haya
    // delante.
    const enElCuerpo = await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'nvidia', modelId: 'deepseek-ai/deepseek-v4-pro-0813', enabled: false },
    });
    assert.equal(enElCuerpo.statusCode, 200);
    assert.equal(estado('deepseek-ai/deepseek-v4-pro-0813'), false);
  });

  it('rechaza lo que no identifica un modelo', async () => {
    const sinModelo = await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'nvidia' },
    });
    assert.equal(sinModelo.statusCode, 400);

    const proveedorInventado = await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { providerId: 'no-existe', modelId: 'x' },
    });
    assert.equal(proveedorInventado.statusCode, 400);
  });

  it('sigue estando detrás del login', async () => {
    const sinSesion = await app.inject({
      method: 'POST',
      url: '/api/models/enabled',
      headers: { 'content-type': 'application/json' },
      payload: { providerId: 'nvidia', modelId: IDS_DIFICILES[0], enabled: false },
    });
    assert.equal(sinSesion.statusCode, 401);
    assert.equal(estado(IDS_DIFICILES[0]!), true);
  });
});

describe('el cliente del panel', () => {
  it('nunca mete el id de un modelo en la ruta', () => {
    // Este es el guardián que faltaba. El fallo original no lo cazó ninguna prueba porque
    // con `app.inject()` y contra localhost el `%2F` llega intacto y todo pasa: solo se
    // rompía con un proxy inverso delante, es decir, únicamente en producción. Revisar
    // la forma de la URL en el propio código es lo que cierra esa puerta.
    const fuente = readFileSync(fileURLToPath(new URL('../../web/src/api.ts', import.meta.url)), 'utf8');

    const idInterpolado = /`\/api\/models\/\$\{/;
    assert.ok(
      !idInterpolado.test(fuente),
      'el id de un modelo no puede ir en un segmento de ruta: los proxys decodifican el %2F y el servidor recibe una ruta que no existe',
    );
    assert.match(fuente, /'\/api\/models\/enabled'/, 'debe llamar a la ruta que lleva el id en el cuerpo');
  });
});
