import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const script = path.resolve(__dirname, "..", "scripts", "plesk-api-diagnostics.cjs");
const { normalizePanelUrl, redact, selectCliInfo, selectedFields } = require(script);

test("Plesk diagnostics require credential-free HTTPS panel URLs", () => {
  assert.equal(normalizePanelUrl("https://panel.example.com:8443/login_up.php"), "https://panel.example.com:8443");
  assert.throws(() => normalizePanelUrl("http://panel.example.com:8443"), /HTTPS/);
  assert.throws(() => normalizePanelUrl("https://panel.example.com"), /port/);
  assert.throws(() => normalizePanelUrl("https://user:secret@panel.example.com:8443"), /separate secrets/);
});

test("Plesk diagnostics redact credentials and expose only selected domain fields", () => {
  process.env.PLESK_API_USERNAME = "diagnostic-user";
  process.env.PLESK_API_PASSWORD = "diagnostic-password";
  process.env.PLESK_API_KEY = "diagnostic-key";
  try {
    const sanitized = redact("diagnostic-user diagnostic-password diagnostic-key Authorization: Basic abc123 FTP Password: visible");
    assert.doesNotMatch(sanitized, /diagnostic-user|diagnostic-password|diagnostic-key|abc123|visible/);
    const cli = selectCliInfo([
      "Domain status:                          OK",
      "FTP Login:                              private-login",
      "FTP Password:                           private-password",
      "Hosting type:                           Physical hosting",
    ].join("\n"));
    assert.deepEqual(cli, [
      "Domain status:                          OK",
      "Hosting type:                           Physical hosting",
    ]);
    assert.deepEqual(selectedFields({ id: 7, name: "nomreh.arounidea.com", ftp_password: "hidden" }, ["id", "name"]), {
      id: 7,
      name: "nomreh.arounidea.com",
    });
  } finally {
    delete process.env.PLESK_API_USERNAME;
    delete process.env.PLESK_API_PASSWORD;
    delete process.env.PLESK_API_KEY;
  }
});
