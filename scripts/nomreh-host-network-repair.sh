#!/usr/bin/env bash
# Nomreh host network inspection.
#
# Read-only: this script prints the host's network state and an exact repair
# recipe. It does not modify DNS, firewall rules or services, because a wrong
# automatic change here takes the site offline. Run it, read the verdict, then run
# the one printed command that matches your case.
#
#   bash scripts/nomreh-host-network-repair.sh
#
# Nothing in this script prints a secret; it never reads the application .env.

set -u

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
info() { printf '  ..   %s\n' "$1"; }

TIME_BUDGET=8
VERDICTS=()

bold "== 1. resolver configuration"
if [ -r /etc/resolv.conf ]; then
  RESOLV_NAMESERVERS=$(grep -E '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ' ')
  info "nameservers: ${RESOLV_NAMESERVERS:-none}"
  if [ -z "${RESOLV_NAMESERVERS}" ]; then
    bad "resolv.conf has no nameserver"
    VERDICTS+=("resolv.conf-nameserver")
  fi
  for ns in ${RESOLV_NAMESERVERS}; do
    case "$ns" in
      127.*|::1|0.0.0.0)
        bad "nameserver $ns is a local address: DNS depends on a local proxy being alive"
        VERDICTS+=("localhost-dns:$ns")
        ;;
      *)
        ok "nameserver $ns is a real resolver"
        ;;
    esac
  done
  # systemd-resolved with a dead upstream looks identical to a broken network.
  if [ -L /etc/resolv.conf ]; then
    info "resolv.conf is a symlink -> $(readlink -f /etc/resolv.conf)"
  fi
else
  bad "cannot read /etc/resolv.conf"
fi

bold "== 2. local proxy / VPN listeners"
if command -v ss >/dev/null 2>&1; then
  LISTENERS=$( (ss -lntup 2>/dev/null || ss -lntu 2>/dev/null) | grep -E ':(53|5353|1080|1081|8080|8081|7300|8400|6099|10808|10809)\b' || true)
  if [ -n "$LISTENERS" ]; then
    info "listening proxy/DNS ports:"
    printf '%s\n' "$LISTENERS" | sed 's/^/       /'
  else
    ok "no local proxy or DNS proxy is listening"
  fi
else
  info "ss not available; skipping listener check"
fi

bold "== 3. processes that commonly rewrite routing"
PROCS=$(ps ax -o pid=,comm=,args= 2>/dev/null | grep -Ei 'v2ray|xray|sing-box|shecan|dns2socks|psiphon|tun2socks|warp|openvpn|wireguard' | grep -v grep || true)
if [ -n "$PROCS" ]; then
  info "matching processes:"
  printf '%s\n' "$PROCS" | cut -c1-150 | sed 's/^/       /'
  VERDICTS+=("proxy-process")
else
  ok "no proxy/VPN process is running"
fi

bold "== 4. firewall (needs root to read; skipped otherwise)"
if [ "$(id -u)" = "0" ]; then
  if command -v iptables >/dev/null 2>&1; then
    RULES=$(iptables -S 2>/dev/null | grep -Ec 'REDIRECT|TPROXY|DNAT|REJECT|DROP' || true)
    if [ "${RULES:-0}" -gt 0 ]; then
      bad "$RULES firewall rules reference REDIRECT/TPROXY/DNAT/REJECT/DROP"
      iptables -S 2>/dev/null | grep -E 'REDIRECT|TPROXY|DNAT|REJECT|DROP' | head -12 | sed 's/^/       /'
      VERDICTS+=("firewall-rules")
    else
      ok "no redirect/drop rules in iptables"
    fi
  fi
else
  info "run with sudo to inspect firewall rules"
fi

bold "== 5. live connectivity (raw IP, no DNS involved)"
probe_tcp() {
  local host="$1" port="$2"
  if timeout "$TIME_BUDGET" bash -c "cat < /dev/null > /dev/tcp/$host/$port" 2>/dev/null; then
    ok "tcp $host:$port connected"
    return 0
  fi
  bad "tcp $host:$port no answer in ${TIME_BUDGET}s"
  return 1
}
probe_tcp 1.1.1.1 443; TCP_CF=$?
probe_tcp 213.176.6.243 443; TCP_KAYA=$?
probe_tcp 140.82.121.6 443; TCP_GH=$?
if [ $TCP_CF -ne 0 ]; then VERDICTS+=("no-egress"); fi

bold "== 6. is the application answering locally?"
if command -v curl >/dev/null 2>&1; then
  LOCAL=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/login 2>/dev/null || echo "000")
  if [ "$LOCAL" = "200" ] || [ "$LOCAL" = "302" ]; then
    ok "application answers on 127.0.0.1:3000 (HTTP $LOCAL)"
  else
    info "application on 127.0.0.1:3000 returned $LOCAL (it may run on another port)"
  fi
fi

bold "== verdict"
if [ ${#VERDICTS[@]} -eq 0 ]; then
  echo "  Nothing local is broken. If the provider still fails, run:"
  echo "      node scripts/nomreh-network-check.cjs"
  exit 0
fi

for item in "${VERDICTS[@]}"; do
  case "$item" in
    localhost-dns:*)
      echo "  DNS points at a local address (${item#localhost-dns:}). A local DNS proxy was"
      echo "  installed and is not running any more, so every lookup fails and every"
      echo "  connection times out. That also explains git clone failing."
      echo
      echo "  Fix (as root), after backing up:"
      echo "      cp /etc/resolv.conf /root/resolv.conf.backup-\$(date +%F-%H%M)"
      echo "      printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf"
      echo "      getent hosts kayaai.ir && curl -sS -o /dev/null -w '%{http_code}\\n' https://kayaai.ir/api/chat/completions"
      echo
      echo "  If the file is managed by systemd-resolved or NetworkManager, revert it there"
      echo "  instead so the change survives a restart:"
      echo "      systemctl status systemd-resolved --no-pager | head -5"
      echo "      nmcli device show | grep -i dns"
      ;;
    proxy-process)
      echo "  A V2Ray/Xray/Shecan-style process is running. Those tools can install"
      echo "  transparent-proxy rules or a TUN device that capture ALL outbound traffic;"
      echo "  when the upstream dies, everything times out including GitHub."
      echo
      echo "  Fix (as root), in this order, testing after each step:"
      echo "      systemctl list-units --type=service | grep -Ei 'v2ray|xray|sing-box|shecan|tun2socks'"
      echo "      systemctl stop  <the service you installed>"
      echo "      systemctl disable <the service you installed>"
      echo "      ip rule show ; ip route show table all | grep -Ei 'tun|default' | head"
      echo "      curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 8 https://api.github.com"
      echo
      echo "  A TUN device left behind survives the process: 'ip link show' will list a"
      echo "  tun interface. Remove it with 'ip link delete <name>' after stopping the service."
      ;;
    firewall-rules)
      echo "  Firewall rules redirect or drop traffic. Dump them before changing anything:"
      echo "      iptables-save > /root/iptables.backup-\$(date +%F-%H%M)"
      echo "      iptables -S | grep -E 'REDIRECT|TPROXY|DNAT|REJECT|DROP'"
      echo "  Delete only the rules created by the VPN tool; never flush the whole table,"
      echo "  the hosting firewall may live there too."
      ;;
    no-egress)
      echo "  No outbound connection works at all, even to 1.1.1.1 with no DNS. Either the"
      echo "  rules above are dropping traffic, or the provider closed egress. Clear the"
      echo "  local rules first; only then contact the hosting."
      ;;
    resolv.conf-nameserver)
      echo "  /etc/resolv.conf has no nameserver at all. Restore one:"
      echo "      printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf"
      ;;
  esac
  echo
done

echo "Nomreh has no tunnel, no VPN and no DNS override: every provider request leaves this host directly"
echo "from Iran. This host only needs its normal outbound connection back."
