import { randomUUID } from "crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
