import { EventEmitter } from "node:events";

export interface KatEvent {
  run_id: string;
  definition_id: string;
  branch_path: string;
  iteration: number;
  scope_id?: number;
  kind: string;
  content: Record<string, unknown> | null;
}

/**
 * EventEmitter-based logger that implements grandma-kat's { log(event) }
 * interface. Subscribe with .on('event', listener) to receive structured
 * events in real-time.
 *
 * Used by the debug REPL. Checkpoint operations are handled by
 * grandma-kat's SqliteLogger — EventLogger only handles log().
 */
export class EventLogger extends EventEmitter {
  log(event: KatEvent): void {
    this.emit("event", event);
  }

  close(): void {
    this.removeAllListeners();
  }
}
