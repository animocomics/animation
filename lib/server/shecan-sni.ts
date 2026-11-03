import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";

// Current official https://my.shecan.ir/proxies.json entries. These are
// transport candidates only: the original hostname, SNI and certificate checks
// stay intact. No operating-system DNS or unrelated request uses this list.
export const SHECAN_SNI_FALLBACK_IPV4 = [
  "144.76.1.88", // de1
  "94.130.70.160", // de11
  "65.109.34.234", // fi2
  "5.202.75.100", // mahan
  "88.218.19.178", // mizban
] as const;

export function fixedShecanIpv4Lookup(address: string): NonNullable<TcpSocketConnectOpts["lookup"]> {
  return (_hostname, options: LookupOptions, callback) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}
