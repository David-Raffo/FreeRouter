/**
 * SQLite. Guarda lo que debe sobrevivir a un reinicio:
 *   - claves de proveedor cifradas
 *   - catálogo de modelos descubierto
 *   - las API keys de FreeRouter y su perfil
 *   - el consumo diario (crítico: sin esto, reiniciar regalaría cuota ya gastada,
 *     y con 50 peticiones/día en OpenRouter eso se nota)
 *   - la salud de cada modelo (EWMA de latencia, cuarentenas)
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { dataDir } from './crypto.js';

export type DB = Database.Database;

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  const path = process.env.FREEROUTER_DB ?? join(dataDir(), 'freerouter.db');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Solo para tests: base de datos en memoria. */
export function useInMemoryDb(): DB {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function migrate(database: DB): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_keys (
      provider_id    TEXT PRIMARY KEY,
      encrypted_key  TEXT NOT NULL,
      last4          TEXT NOT NULL,
      added_at       TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      last_error     TEXT,
      limits_json    TEXT
    );

    CREATE TABLE IF NOT EXISTS models (
      provider_id           TEXT NOT NULL,
      model_id              TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      context_length        INTEGER NOT NULL,
      max_completion_tokens INTEGER,
      input_modalities      TEXT NOT NULL,
      output_modalities     TEXT NOT NULL,
      supports_tools        INTEGER NOT NULL,
      quality_score         REAL,
      quality_source        TEXT,
      enabled               INTEGER NOT NULL DEFAULT 1,
      discovered_at         TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id),
      FOREIGN KEY (provider_id) REFERENCES provider_keys(provider_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id            TEXT PRIMARY KEY,
      key_hash      TEXT NOT NULL UNIQUE,
      prefix        TEXT NOT NULL,
      name          TEXT NOT NULL,
      profile       TEXT NOT NULL,
      capabilities  TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL,
      last_used_at  TEXT,
      revoked       INTEGER NOT NULL DEFAULT 0
    );

    -- Consumo por día UTC. La ventana diaria de los tres proveedores es UTC.
    CREATE TABLE IF NOT EXISTS daily_usage (
      provider_id TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      day         TEXT NOT NULL,
      requests    INTEGER NOT NULL DEFAULT 0,
      tokens      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, model_id, day)
    );

    CREATE TABLE IF NOT EXISTS health (
      provider_id          TEXT NOT NULL,
      model_id             TEXT NOT NULL,
      ttft_ewma_ms         REAL,
      tps_ewma             REAL,
      last_ok_at           TEXT,
      last_error_at        TEXT,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      quarantined_until    TEXT,
      samples              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      api_key_id   TEXT,
      provider_id  TEXT,
      model_id     TEXT,
      profile      TEXT,
      ok           INTEGER NOT NULL,
      ttft_ms      REAL,
      total_ms     REAL,
      tokens_in    INTEGER,
      tokens_out   INTEGER,
      error_kind   TEXT,
      attempts     INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  addColumnIfMissing(database, 'models', 'quality_source', 'TEXT');
  addColumnIfMissing(database, 'models', 'requires_identified_account', 'INTEGER');
  addColumnIfMissing(database, 'request_log', 'tps', 'REAL');
  addColumnIfMissing(database, 'request_log', 'prompt', 'TEXT');
  addColumnIfMissing(database, 'request_log', 'response', 'TEXT');
  // Los intentos con su duración, en JSON. Van en una columna y no en una tabla aparte
  // porque solo se leen al abrir una petición concreta, nunca de forma agregada.
  addColumnIfMissing(database, 'request_log', 'attempts_detail', 'TEXT');
  // Cuánto tardó el propio router en decidir, aparte de lo que tardaran los proveedores.
  // Sin esta cifra no hay forma de saber si una petición lenta es culpa nuestra.
  addColumnIfMissing(database, 'request_log', 'router_ms', 'REAL');
}

/** ALTER idempotente: SQLite no tiene `ADD COLUMN IF NOT EXISTS`. */
function addColumnIfMissing(database: DB, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Día UTC en formato YYYY-MM-DD: la ventana de reset diaria de los tres proveedores. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
