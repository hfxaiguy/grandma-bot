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
 */
export class EventLogger extends EventEmitter {
  log(event: KatEvent): void {
    this.emit("event", event);
  }

  close(): void {
    this.removeAllListeners();
  }

  // Checkpoint methods — SqliteLogger handles persistence.
  saveCheckpoint(): void {}
  getCheckpoint(): null {
    return null;
  }
  deleteCheckpoint(): void {}
  getEvents(): KatEvent[] {
    return [];
  }
}
