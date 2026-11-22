import { EventEmitter } from "node:events";
import type { Db } from "./db.ts";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type ConsoleEventType =
  | "incident"
  | "message"
  | "rollcall"
  | "api"
  | "callback"
  | "people"
  | "stats";

export interface ConsoleEvent {
  type: ConsoleEventType;
  id?: number;
  summary?: string;
}

/** In-process event bus. The console and the simulator listen to it over SSE. */
export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publish(event: ConsoleEvent): void {
    this.emit("console", event);
  }
}

export interface Ctx {
  db: Db;
  bus: Bus;
  log: Logger;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
