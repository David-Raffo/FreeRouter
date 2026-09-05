/**
 * Autenticación del panel.
 *
 * La contraseña se pasa por `FREEROUTER_PASSWORD` y **el servidor no arranca sin ella**.
 * Ahí está la clave: una contraseña por variable de entorno solo es peligrosa si
 * olvidarla deja el panel abierto, y aquí olvidarla impide arrancar. Es el mismo trato
 * que hace Postgres con `POSTGRES_PASSWORD`.
 *
 * A cambio no hay asistente de instalación, ni código de un solo uso, ni ventana en la
 * que alguien pueda reclamar la instancia antes que su dueño: cuando el puerto se abre,
 * la contraseña ya existe.
 *
 * Las sesiones van en una cookie firmada, sin tabla de sesiones: el estado se reduce a
 * una época guardada en ajustes, y subirla invalida todas las sesiones de golpe.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const SETTING_EPOCH = 'admin_session_epoch';
const SETTING_SECRET = 'admin_session_secret';

export const SESSION_COOKIE = 'freerouter_session';
/** Duración de la sesión. Larga a propósito: es una herramienta de uso diario. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export const MIN_PASSWORD_LENGTH = 8;

export function authDisabled(): boolean {
  return process.env.FREEROUTER_DISABLE_AUTH === 'true';
}

function configuredPassword(): string {
  return process.env.FREEROUTER_PASSWORD ?? '';
}

/**
 * Motivo por el que la configuración no sirve, o `null` si está en orden.
 *
 * El servidor la consulta ANTES de escuchar: sin contraseña válida no llega a abrir el
 * puerto, así que no existe un estado «arrancado y desprotegido».
 */
export function configurationProblem(): string | null {
  if (authDisabled()) return null;
  const password = configuredPassword();
  if (password.length === 0) {
    return (
      'Falta FREEROUTER_PASSWORD.\n\n' +
      'El panel gestiona las claves de todos tus proveedores, así que no arranca sin\n' +
      'contraseña. Crea un fichero .env junto al docker-compose.yml con:\n\n' +
      '    FREEROUTER_PASSWORD=la-que-quieras\n\n' +
      'Si solo lo usas en local y no quieres contraseña: FREEROUTER_DISABLE_AUTH=true'
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `FREEROUTER_PASSWORD es demasiado corta: necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

export function passwordMatches(candidate: string): boolean {
  const expected = configuredPassword();
  if (expected.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Comparación en tiempo constante: comparar con `===` filtra información a través del
  // tiempo que tarda en fallar.
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionSecret(): string {
  let secret = getSetting(SETTING_SECRET);
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    setSetting(SETTING_SECRET, secret);
  }
  return secret;
}

function sessionEpoch(): string {
  return getSetting(SETTING_EPOCH) ?? '1';
}

/** Invalida todas las sesiones abiertas. */
export function bumpSessionEpoch(): void {
  setSetting(SETTING_EPOCH, String(Number(sessionEpoch()) + 1));
}

/** Cookie de sesión: `emitidaEn.época.firma`. */
export function issueSession(): string {
  const payload = `${Date.now()}.${sessionEpoch()}`;
  return `${payload}.${sign(payload)}`;
}

function sign(payload: string): string {
  // La contraseña vigente entra en la firma, así que cambiarla en el .env invalida por
  // sí sola las sesiones anteriores. Si se cambia porque alguien más la conocía, dejar
  // su sesión viva no habría arreglado nada.
  return createHmac('sha256', `${sessionSecret()}:${configuredPassword()}`).update(payload).digest('base64url');
}

export function sessionIsValid(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [issuedAt, epoch, signature] = parts as [string, string, string];

  const expected = sign(`${issuedAt}.${epoch}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  if (epoch !== sessionEpoch()) return false;

  const age = (Date.now() - Number(issuedAt)) / 1000;
  return Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE_S;
}

/**
 * Freno a la fuerza bruta. En memoria y por IP: para un panel de una sola cuenta no
 * hace falta más, y no persistirlo evita que reiniciar deje a alguien bloqueado.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60_000;

export function loginBlockedFor(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry || entry.until < Date.now()) return 0;
  return entry.count >= MAX_ATTEMPTS ? entry.until - Date.now() : 0;
}

export function recordLoginFailure(ip: string): void {
  const entry = attempts.get(ip);
  const now = Date.now();
  if (!entry || entry.until < now) {
    attempts.set(ip, { count: 1, until: now + LOCKOUT_MS });
    return;
  }
  entry.count += 1;
  entry.until = now + LOCKOUT_MS;
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

/** Solo para tests. */
export function resetLoginThrottle(): void {
  attempts.clear();
}
