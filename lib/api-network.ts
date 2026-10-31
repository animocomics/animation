export const SHECAN_DNS = {
  free: ["178.22.122.100", "185.51.200.2"],
  pro: ["178.22.122.101", "185.51.200.1"],
} as const;

export interface ProviderNetworkConfig {
  enabled: boolean;
  plan: "free" | "pro";
  servers: [string, string];
}
