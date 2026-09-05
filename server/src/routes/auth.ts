/**
 * Rutas de sesión del panel y el guardián que protege la administración.
 *
 * `/v1` no pasa por aquí: va autenticado con las API keys de FreeRouter, que es lo que
 * usan los clientes. Esto protege únicamente el panel y su API de administración.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  authDisabled,
  bumpSessionEpoch,
  clearLoginFailures,
  issueSession,
  loginBlockedFor,
  passwordMatches,
  recordLoginFailure,
  sessionIsValid,
} from '../auth.js';

/** Rutas accesibles sin sesión: las de la propia sesión y la salud del proceso. */
const OPEN_PATHS = ['/api/auth/state', '/api/auth/login', '/health'];

function isOpen(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return OPEN_PATHS.includes(path);
}

/**
 * Solo se protege `/api`. Los ficheros del panel (`/app`) se sirven abiertos a
 * propósito: son JavaScript y CSS públicos, y sin datos detrás no revelan nada. Poner
 * la barrera en la API y no en los estáticos es lo que permite que la pantalla de login
 * sea la propia aplicación.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? '';
    if (!url.startsWith('/api')) return;
    if (isOpen(url)) return;
    if (authDisabled()) return;

    if (!sessionIsValid(request.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'Sesión no válida o caducada.' });
    }
  });
}

function setSessionCookie(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, issueSession(), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_S,
    // `secure` solo con HTTPS: activarlo siempre rompería el acceso por HTTP en una red
    // local, que es como se usa esto la mayor parte del tiempo.
    secure: process.env.FREEROUTER_HTTPS === 'true',
  });
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/state', async (request) => ({
    authenticated: authDisabled() || sessionIsValid(request.cookies[SESSION_COOKIE]),
    disabled: authDisabled(),
  }));

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    const blocked = loginBlockedFor(request.ip);
    if (blocked > 0) {
      return reply.code(429).send({
        error: `Demasiados intentos fallidos. Vuelve a probar en ${Math.ceil(blocked / 1000)} segundos.`,
      });
    }
    if (!passwordMatches(request.body?.password ?? '')) {
      recordLoginFailure(request.ip);
      return reply.code(401).send({ error: 'Contraseña incorrecta.' });
    }
    clearLoginFailures(request.ip);
    setSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout-all', async (_request, reply) => {
    bumpSessionEpoch();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}

export type { FastifyRequest };
