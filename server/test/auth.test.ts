/**
 * Autenticación del panel.
 *
 * Lo que se protege aquí es la administración: las claves de todos los proveedores.
 * `/v1` no entra en estas pruebas porque va autenticado con las API keys de FreeRouter.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closeDb, useInMemoryDb } from '../src/db.js';
import { configurationProblem, resetLoginThrottle } from '../src/auth.js';
import { buildServer } from '../src/index.js';

const PASSWORD = 'contraseña-de-prueba';
let app: FastifyInstance;

beforeEach(async () => {
  useInMemoryDb();
  resetLoginThrottle();
  delete process.env.FREEROUTER_DISABLE_AUTH;
  process.env.FREEROUTER_PASSWORD = PASSWORD;
  app = await buildServer();
});

afterEach(async () => {
  await app.close();
  closeDb();
  delete process.env.FREEROUTER_PASSWORD;
  delete process.env.FREEROUTER_DISABLE_AUTH;
});

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

/** Extrae la cookie de sesión de una respuesta, como haría el navegador. */
function sessionCookie(response: Awaited<ReturnType<typeof post>>): string {
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first ?? '').split(';')[0] ?? '';
}

describe('configuración obligatoria', () => {
  it('sin contraseña, el arranque se rechaza', () => {
    // Es la propiedad que hace segura una contraseña por variable de entorno: olvidarla
    // no deja un panel abierto, impide arrancar.
    delete process.env.FREEROUTER_PASSWORD;
    const problema = configurationProblem();
    assert.ok(problema, 'debe haber un motivo para no arrancar');
    assert.match(problema, /FREEROUTER_PASSWORD/);
  });

  it('rechaza contraseñas demasiado cortas', () => {
    process.env.FREEROUTER_PASSWORD = 'corta';
    assert.match(configurationProblem() ?? '', /al menos 8/);
  });

  it('acepta una contraseña razonable', () => {
    process.env.FREEROUTER_PASSWORD = PASSWORD;
    assert.equal(configurationProblem(), null);
  });

  it('permite arrancar sin contraseña solo si se desactiva la autenticación a propósito', () => {
    delete process.env.FREEROUTER_PASSWORD;
    process.env.FREEROUTER_DISABLE_AUTH = 'true';
    assert.equal(configurationProblem(), null);
  });
});

describe('autenticación del panel', () => {
  it('la administración está cerrada sin sesión', async () => {
    assert.equal((await get('/api/providers')).statusCode, 401);
  });

  it('entra con la contraseña correcta y rechaza la incorrecta', async () => {
    assert.equal((await post('/api/auth/login', { password: 'equivocada' })).statusCode, 401);

    const ok = await post('/api/auth/login', { password: PASSWORD });
    assert.equal(ok.statusCode, 200);
    assert.equal((await get('/api/providers', sessionCookie(ok))).statusCode, 200);
  });

  it('una cookie manipulada no vale', async () => {
    const falsa = `freerouter_session=${Date.now()}.1.firmainventada`;
    assert.equal((await get('/api/providers', falsa)).statusCode, 401);
  });

  it('cambiar la contraseña en el entorno invalida las sesiones anteriores', async () => {
    const ok = await post('/api/auth/login', { password: PASSWORD });
    const cookie = sessionCookie(ok);
    assert.equal((await get('/api/providers', cookie)).statusCode, 200);

    // La contraseña vigente entra en la firma de la cookie: cambiarla en el .env y
    // reiniciar echa a quien tuviera sesión abierta, que es lo que se espera si se
    // cambia justamente porque alguien más la conocía.
    process.env.FREEROUTER_PASSWORD = 'otra-contraseña-distinta';
    assert.equal((await get('/api/providers', cookie)).statusCode, 401);
  });

  it('bloquea tras varios intentos fallidos seguidos', async () => {
    for (let i = 0; i < 8; i += 1) await post('/api/auth/login', { password: 'no' });

    const bloqueado = await post('/api/auth/login', { password: PASSWORD });
    assert.equal(bloqueado.statusCode, 429, 'ni siquiera con la buena, mientras dura el bloqueo');
  });

  it('cerrar sesión invalida la cookie', async () => {
    const ok = await post('/api/auth/login', { password: PASSWORD });
    const cookie = sessionCookie(ok);
    await post('/api/auth/logout-all', {}, cookie);
    assert.equal((await get('/api/providers', cookie)).statusCode, 401);
  });

  it('el estado de sesión y la salud son consultables sin entrar', async () => {
    assert.equal((await get('/api/auth/state')).statusCode, 200);
    assert.equal((await get('/health')).statusCode, 200);
  });
});
