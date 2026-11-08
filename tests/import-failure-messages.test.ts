import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * "پیش‌نویس ساخته نشد / خواندن سؤال و کلید کامل نشد" was a dead end.
 *
 * That sentence only ever appeared when the server's reply was not JSON — which in
 * practice means a reverse proxy answered instead of the app (a 504 for a request
 * that ran too long, or an HTML error page). The panel read it as an empty object and
 * produced the generic line, so the teacher had no idea whether to change the file,
 * the key, the model or the host. These assertions keep the two real cases named.
 */
const importer = readFileSync(new URL("../components/grading/question-source-importer.tsx", import.meta.url), "utf8");

test("a non-JSON gateway failure is named, not swallowed", () => {
  assert.match(importer, /response\.text\(\)/, "the body must be read as text, not assumed to be JSON");
  assert.match(importer, /پروکسی هاست/, "the proxy case must be named");
  assert.match(importer, /گزارش هیچ|HTTP \$\{response\.status\}/, "the real status must reach the operator");
  assert.doesNotMatch(importer, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/, "an unparseable body must not become an empty object");
});

test("a provider call is shorter than a typical proxy timeout and configurable", () => {
  const providers = readFileSync(new URL("../lib/server/providers.ts", import.meta.url), "utf8");
  assert.match(providers, /function providerTimeoutMs\(\)/);
  assert.match(providers, /NOMREH_PROVIDER_TIMEOUT_MS/);
  assert.match(providers, /return 120_000;/, "the default must answer before a 180 s proxy gives up");
  assert.doesNotMatch(providers, /timeout = 240_000/, "the old default outlived the proxy in front of the app");
});
