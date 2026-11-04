export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { resumeV2RayIfEnabled } = await import("./lib/server/v2ray-runtime");
  // Restore the selected AI-only tunnel after a Passenger/Node restart without
  // delaying the web server or changing any host-wide network configuration.
  void resumeV2RayIfEnabled();
}
