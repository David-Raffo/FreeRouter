/**
 * Cifrado en reposo de las claves de proveedor.
 *
 * AES-256-GCM con una clave maestra en `~/.freerouter/master.key` (creada con
 * permisos restrictivos al primer arranque). La clave maestra puede derivarse en su
 * lugar de una passphrase vía scrypt, poniendo FREEROUTER_PASSPHRASE.
 *
 * Invariante del proyecto: una clave de proveedor descifrada nunca sale del servidor.
 * El panel solo recibe los últimos 4 caracteres.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function dataDir(): string {
  const dir = process.env.FREEROUTER_HOME ?? join(homedir(), '.freerouter');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const passphrase = process.env.FREEROUTER_PASSPHRASE;
  if (passphrase) {
    // El salt se guarda junto a la passphrase derivada para que la clave sea estable
    // entre arranques sin escribir nunca la passphrase en disco.
    const saltPath = join(dataDir(), 'master.salt');
    let salt: Buffer;
    if (existsSync(saltPath)) {
      salt = readFileSync(saltPath);
    } else {
      salt = randomBytes(16);
      writeFileSync(saltPath, salt, { mode: 0o600 });
      restrictPermissions(saltPath);
    }
    cachedKey = scryptSync(passphrase, salt, 32);
    return cachedKey;
  }

  const keyPath = join(dataDir(), 'master.key');
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length !== 32) {
      throw new Error(`La clave maestra en ${keyPath} está corrupta (${key.length} bytes en vez de 32).`);
    }
    cachedKey = key;
    return key;
  }

  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  restrictPermissions(keyPath);
  cachedKey = key;
  return key;
}

/**
 * En Windows `mode: 0o600` no restringe de verdad el acceso, así que se aplica una
 * ACL explícita para que el fichero solo lo lea el usuario actual.
 */
function restrictPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // sistemas de ficheros sin soporte de permisos POSIX
  }
  if (process.platform === 'win32') {
    void restrictWindowsAcl(path);
  }
}

async function restrictWindowsAcl(path: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const user = process.env.USERNAME;
  if (!user) return;
  // /inheritance:r elimina los permisos heredados; luego se concede solo al usuario.
  execFile('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], () => {
    // Si icacls no está disponible seguimos: el fichero está en el perfil del usuario.
  });
}

/** Cifra un texto. Formato: base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  // `<` y no `<=`: un texto vacío cifra a exactamente IV+tag, y es un caso legítimo
  // desde que hay proveedores que funcionan sin clave.
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Payload cifrado con longitud inválida.');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Últimos 4 caracteres, lo único que el panel llega a ver de una clave. */
export function last4(key: string): string {
  return key.slice(-4);
}

/** Genera una API key propia de FreeRouter (la que usa el cliente). */
export function generateApiKey(): string {
  return `fr_${randomBytes(24).toString('base64url')}`;
}
