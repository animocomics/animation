export const SHECAN_DNS = {
  free: ["178.22.122.100", "185.51.200.2"],
  pro: ["178.22.122.101", "185.51.200.1"],
} as const;

export function displayShecanAccountLogin(value: string): string {
  const normalized = value.trim()
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const compact = normalized.replace(/[\s()-]/g, "");
  return /^\+?\d{8,15}$/.test(compact) ? "" : normalized.slice(0, 160);
}

export interface ProviderNetworkConfig {
  enabled: boolean;
  plan: "free" | "pro";
  servers: [string, string];
  /** Official desktop guest is opt-in; legacy DNS remains only for compatibility. */
  transport?: "dns" | "official-vm" | "v2ray";
}
