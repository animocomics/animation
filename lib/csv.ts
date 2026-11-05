export type CsvValue = string | number | boolean | null | undefined;

/** Escape a CSV cell and neutralize spreadsheet formulas in user/model text. */
export function csvCell(value: CsvValue): string {
  const raw = String(value ?? "");
  const safe = typeof value === "string" && (/^\s*[=+\-@]/.test(raw) || /^[\t\r]/.test(raw)) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function createCsv(rows: CsvValue[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
