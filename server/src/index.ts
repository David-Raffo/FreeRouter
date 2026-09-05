/**
 * Arranque del servidor.
 *
 * Por defecto escucha solo en 127.0.0.1. En Docker se pone FREEROUTER_HOST=0.0.0.0 y es
 * el mapeo de puertos quien decide desde dónde se llega.
 *
 * Publicar el puerto es seguro —el panel va con contraseña y /v1 con las API keys—, pero
 * en internet hace falta HTTPS delante: sin él la cookie de sesión viaja en claro. El
 * docker-compose trae los dos perfiles (`https` con Caddy, `tunnel` con Cloudflare).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { getDb } from './db.js';
import { allProviders } from './providers/registry.js';
import { refreshAllProviders } from './providers/connect.js';
import { startProbeLoop, warmupAll } from './routing/probe.js';
import { syncQualityScores } from './catalog/sync.js';
import { authDisabled, configurationProblem } from './auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthGuard, registerAuthRoutes } from './routes/auth.js';
import { registerV1Routes } from './routes/v1.js';
import { pruneOldUsage, retireMissingModels } from './store.js';

const PORT = Number(process.env.FREEROUTER_PORT ?? 8787);
const HOST = process.env.FREEROUTER_HOST ?? '127.0.0.1';
const MODEL_REFRESH_MS = 6 * 60 * 60 * 1000;
const QUALITY_SYNC_MS = 24 * 60 * 60 * 1000;

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Las peticiones con imágenes en base64 se van fácilmente por encima del megabyte.
    bodyLimit: 32 * 1024 * 1024,
  });

  // Un cuerpo vacío con `content-type: application/json` es un 400 en Fastify por
  // defecto. Varios clientes (el nuestro incluido, hasta que se corrigió) mandan esa
  // cabecera en peticiones sin cuerpo, así que se trata como cuerpo ausente en vez de
  // como error: la alternativa es que acciones sin parámetros fallen sin motivo real.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  getDb();
  pruneOldUsage();
  const retirados = retireMissingModels();
  if (retirados > 0) app.log.info({ retirados }, 'Modelos anunciados pero no servidos, apartados del enrutado');

  await app.register(fastifyCookie);
  registerAuthRoutes(app);
  registerAuthGuard(app);

  registerV1Routes(app);
  registerAdminRoutes(app);

  if (authDisabled()) {
    app.log.warn(
      'FREEROUTER_DISABLE_AUTH activo: el panel no pide contraseña. Solo para uso local; nunca en un servidor accesible.',
    );
  }

  app.get('/health', async () => ({ ok: true }));

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/app/' });
    // El panel es una SPA: cualquier ruta bajo /app devuelve el index.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/app')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'No encontrado' });
    });
    app.get('/', async (_request, reply) => reply.redirect('/app/'));
  } else {
    app.get('/', async (_request, reply) =>
      reply
        .code(200)
        .type('text/plain; charset=utf-8')
        .send('El panel no está compilado. Ejecuta `npm run build --workspace=web` o usa `npm run dev` en web/.'),
    );
  }

  return app;
}

async function main(): Promise<void> {
  // Antes de nada: sin contraseña no se arranca. Que el fallo ocurra aquí, y no en un
  // panel abierto, es lo que hace segura una contraseña por variable de entorno.
  const problem = configurationProblem();
  if (problem) {
    console.error(`
${problem}
`);
    process.exit(1);
  }

  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });

  app.log.info(`Panel en http://${HOST}:${PORT}/app/ · API en http://${HOST}:${PORT}/v1`);

  // El catálogo de los proveedores gratuitos cambia a menudo: enrutar hacia un modelo
  // retirado es un 404 seguro, así que se refresca al arrancar y cada 6 horas.
  // Calibración inicial: sin medidas de TTFT y tok/s el router decide casi solo por
  // calidad, así que se mide todo lo que falte nada más tener el catálogo al día.
  void refreshAllProviders(allProviders())
    .then(() => warmupAll())
    .then((result) => {
      if (result.total > 0) app.log.info({ result }, 'Calibración inicial terminada');
    })
    .catch((err) => app.log.warn({ err }, 'Fallo al refrescar o calibrar'));
  setInterval(() => {
    void refreshAllProviders(allProviders()).catch(() => undefined);
  }, MODEL_REFRESH_MS).unref();

  void syncQualityScores().catch(() => undefined);
  setInterval(() => {
    void syncQualityScores().catch(() => undefined);
  }, QUALITY_SYNC_MS).unref();

  startProbeLoop();
}

// `import.meta.main` no existe en Node 22; se compara la ruta del módulo principal.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error('No se pudo arrancar FreeRouter:', err);
    process.exit(1);
  });
}
