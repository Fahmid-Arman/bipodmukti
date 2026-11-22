/**
 * SQLite storage (Node's built-in node:sqlite). One file, no server.
 *
 * Everything the scheduler needs (pending escalations, roll-call deadlines,
 * outbound retries) lives here, so a restart loses nothing.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS areas (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  district    TEXT NOT NULL,
  shelter     TEXT NOT NULL,
  lat         REAL,
  lng         REAL
);

CREATE TABLE IF NOT EXISTS people (
  id                   INTEGER PRIMARY KEY,
  subscriber_id        TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL DEFAULT '',
  area_id              TEXT REFERENCES areas(id),
  home_place           TEXT NOT NULL DEFAULT '',
  is_member            INTEGER NOT NULL DEFAULT 0,
  is_volunteer         INTEGER NOT NULL DEFAULT 0,
  subscription_status  TEXT NOT NULL DEFAULT 'NONE',
  subscription_at      TEXT,
  consent_channel      TEXT,
  consent_text         TEXT,
  consent_at           TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES people(id),
  guardian_id  INTEGER NOT NULL REFERENCES people(id),
  priority     INTEGER NOT NULL,
  relation     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'invited',   -- invited | active | declined
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(member_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id                  INTEGER PRIMARY KEY,
  ref                 TEXT NOT NULL UNIQUE,
  member_id           INTEGER NOT NULL REFERENCES people(id),
  kind                TEXT NOT NULL,          -- safe | help | moving | missing
  need                TEXT NOT NULL DEFAULT '',
  place               TEXT NOT NULL DEFAULT '',
  channel             TEXT NOT NULL,          -- ussd | sms | web | rollcall
  roll_call_id        INTEGER,
  status              TEXT NOT NULL,          -- open | acknowledged | resolved | info
  acknowledged_by     INTEGER REFERENCES people(id),
  acknowledged_at     TEXT,
  resolved_at         TEXT,
  resolution          TEXT,
  escalation_step     INTEGER NOT NULL DEFAULT 0,
  next_escalation_at  TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS incidents_due ON incidents(status, next_escalation_at);

CREATE TABLE IF NOT EXISTS incident_events (
  id           INTEGER PRIMARY KEY,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type         TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  incident_id     INTEGER REFERENCES incidents(id),
  roll_call_id    INTEGER,
  person_id       INTEGER REFERENCES people(id),
  address         TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | delivered | failed
  request_id      TEXT,
  message_id      TEXT,
  status_code     TEXT,
  status_detail   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_queue ON messages(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS messages_request ON messages(request_id);

CREATE TABLE IF NOT EXISTS roll_calls (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  area_id      TEXT REFERENCES areas(id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | closed
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deadline_at  TEXT NOT NULL,
  closed_at    TEXT
);

CREATE TABLE IF NOT EXISTS roll_call_targets (
  roll_call_id  INTEGER NOT NULL REFERENCES roll_calls(id),
  person_id     INTEGER NOT NULL REFERENCES people(id),
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | safe | help | no_response | confirmed_safe
  responded_at  TEXT,
  incident_id   INTEGER REFERENCES incidents(id),
  PRIMARY KEY (roll_call_id, person_id)
);

CREATE TABLE IF NOT EXISTS inbound_seen (
  key   TEXT PRIMARY KEY,
  at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS ussd_sessions (
  session_id     TEXT PRIMARY KEY,
  subscriber_id  TEXT NOT NULL,
  state          TEXT NOT NULL,
  data           TEXT NOT NULL DEFAULT '{}',
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_sessions (
  token          TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  reference_no   TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  area_id        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  verified_at    TEXT,
  subscriber_id  TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_key ON rate_limits(key, at);

CREATE TABLE IF NOT EXISTS api_calls (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  service       TEXT NOT NULL,
  status_code   TEXT NOT NULL,
  status_detail TEXT NOT NULL,
  request_id    TEXT,
  duration_ms   INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  summary       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS callbacks_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind    TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastId: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Record an inbound event key. Returns false when it was already seen, which
   * is how callbacks stay idempotent when Applink retries or a request is replayed.
   */
  firstTime(key: string): boolean {
    const r = this.run("INSERT OR IGNORE INTO inbound_seen(key) VALUES (?)", key);
    return r.changes === 1;
  }

  getKv(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }

  setKv(key: string, value: string): void {
    this.run(
      "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  close(): void {
    this.raw.close();
  }
}

export const nowIso = (): string => new Date().toISOString();
export const isoIn = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();
