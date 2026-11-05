// Harmless Nomreh QEMU compatibility probe. No Shecan code or credentials.
#include <stdio.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  mount("proc", "/proc", "proc", 0, NULL);
  mount("sysfs", "/sys", "sysfs", 0, NULL);

  struct utsname identity;
  puts("NOMREH_VM_PROBE_BEGIN");
  if (uname(&identity) == 0) {
    printf("NOMREH_VM_PROBE_KERNEL %s\n", identity.release);
    printf("NOMREH_VM_PROBE_ARCH %s\n", identity.machine);
  }
  puts("NOMREH_VM_PROBE_NO_NETWORK yes");
  puts("NOMREH_VM_PROBE_SHECAN_INCLUDED no");
  puts("NOMREH_VM_PROBE_PASS");
  sync();
  reboot(RB_POWER_OFF);
  for (;;) pause();
}
