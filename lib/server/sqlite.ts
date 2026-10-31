import { DatabaseSync } from "node:sqlite";

/**
 * Small compatibility layer for the synchronous better-sqlite3 methods used
 * by Nomreh. Node's built-in SQLite opens the same database files without a
 * platform-specific native addon.
 */
export class Database extends DatabaseSync {
  // Match the existing call sites, which bind values through spread arrays.
  // Runtime validation remains in SQLite and the application's input schemas.
  prepare(source: string): any {
    return super.prepare(source);
  }

  pragma(source: string): unknown {
    return this.prepare(`PRAGMA ${source}`).get();
  }

  transaction<TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      this.exec("BEGIN");
      try {
        const result = callback(...args);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    };
  }
}

export type DatabaseConnection = Database;
