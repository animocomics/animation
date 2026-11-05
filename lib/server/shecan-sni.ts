import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";

// Pin only the transport address for an already-scoped Shecan request. The
// caller's original hostname remains the URL, SNI and certificate identity.
// This helper never changes operating-system DNS or selects another host.
export function fixedShecanIpv4Lookup(address: string): NonNullable<TcpSocketConnectOpts["lookup"]> {
  return (_hostname, options: LookupOptions, callback) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}
