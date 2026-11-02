import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readJsonResponse } from "../lib/http-response";
import { invalidProviderJsonMessage, isJsonParserErrorMessage, providerErrorHttpStatus } from "../lib/error-message";

test("valid JSON errors remain available to the caller", async () => {
  const response = new Response(JSON.stringify({ error: "کلید API معتبر نیست." }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
  const payload = await readJsonResponse<{ error: string }>(response, "آزمایش اتصال");
  assert.equal(payload.error, "کلید API معتبر نیست.");
});

test("raw JSON parser errors forwarded by a server are sanitized before display", async () => {
  const response = new Response(JSON.stringify({ error: 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON' }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
  const payload = await readJsonResponse<{ error: string }>(response, "آزمایش اتصال");
  assert.match(payload.error, /پاسخ JSON معتبر نداد/);
  assert.match(payload.error, /۵۰۲/);
  assert.doesNotMatch(payload.error, /Unexpected token|<!DOCTYPE|not valid JSON/);
});

test("server-side JSON parser failures have a stable safe provider message", () => {
  assert.equal(isJsonParserErrorMessage(new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON')), true);
  assert.equal(isJsonParserErrorMessage("کلید API معتبر نیست."), false);
  assert.doesNotMatch(invalidProviderJsonMessage(), /Unexpected token|<!DOCTYPE/);
});

test("provider authorization failures stay JSON instead of becoming host HTML error pages", () => {
  assert.equal(providerErrorHttpStatus(401), 400);
  assert.equal(providerErrorHttpStatus(403), 400);
  assert.equal(providerErrorHttpStatus(429), 429);
  assert.equal(providerErrorHttpStatus(502), 502);
});

test("HTML gateway errors become a safe message with the HTTP status", async () => {
  const response = new Response("<!DOCTYPE html><html><body>Bad gateway</body></html>", {
    status: 502,
    headers: { "Content-Type": "text/html" },
  });
  await assert.rejects(
    readJsonResponse(response, "آزمایش اتصال"),
    (error: Error) => {
      assert.match(error.message, /آزمایش اتصال/);
      assert.match(error.message, /۵۰۲/);
      assert.match(error.message, /HTML/);
      assert.doesNotMatch(error.message, /Unexpected token|<!DOCTYPE|Bad gateway/);
      return true;
    },
  );
});

test("HTML access denials preserve their distinct meaning", async () => {
  const response = new Response("<html><body>Forbidden</body></html>", { status: 403 });
  await assert.rejects(readJsonResponse(response, "دریافت مدل‌های حساب"), /دسترسی به سرویس رد شد.*۴۰۳/);
});

test("empty successful responses do not become raw JSON parser errors", async () => {
  const response = new Response("", { status: 200 });
  await assert.rejects(readJsonResponse(response, "ذخیرهٔ اتصال"), /پاسخ نامعتبر سرور.*پاسخ خالی.*۲۰۰/);
});

test("Plesk-facing mutations use POST while authenticated PUT compatibility remains", async () => {
  const [providerRoute, providerClient, networkRoute, networkClient, workspaceRoute, workspaceClient] = await Promise.all([
    readFile("app/api/provider/route.ts", "utf8"),
    readFile("components/api-connection.tsx", "utf8"),
    readFile("app/api/admin/api-network/route.ts", "utf8"),
    readFile("components/api-network-connection.tsx", "utf8"),
    readFile("app/api/workspace/route.ts", "utf8"),
    readFile("lib/app-context.tsx", "utf8"),
  ]);
  assert.match(providerRoute, /saveProvider as POST, saveProvider as PUT/);
  assert.match(networkRoute, /saveApiNetwork as POST, saveApiNetwork as PUT/);
  assert.match(workspaceRoute, /updateWorkspace as POST, updateWorkspace as PUT/);
  for (const client of [providerClient, networkClient, workspaceClient]) {
    assert.match(client, /method: "POST"/);
    assert.doesNotMatch(client, /method: "PUT"/);
  }
});
