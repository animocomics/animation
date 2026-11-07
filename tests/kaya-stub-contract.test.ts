import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The local stand-in exists so the grading pipeline can be proven in a sandbox
 * with no route to the vendor. That is only worth anything if the answer it
 * produces passes the same schema the real vendor's answer must pass — otherwise
 * a green run would hide a shape mismatch.
 */
test("the local Kaya stand-in answers with a schema-valid grading result", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const port = 4399;
  const child = spawn(process.execPath, [path.join(root, "scripts/nomreh-kaya-stub.cjs")], {
    cwd: root,
    env: { ...process.env, NOMREH_STUB_PORT: String(port), NOMREH_STUB_LOG: path.join(root, "..", "nomreh-data-test", "stub.log") },
    stdio: "ignore",
  });
  try {
    // Wait for the listener rather than sleeping a fixed time.
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "the stand-in must start");

    // A placeholder key must be refused, so a green test can never mean auth was skipped.
    const refused = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer placeholder-key-123456", "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/grading-model", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(refused.status, 401);

    const exam = { questions: [{ id: "q1", number: 1, maxScore: 2, rubric: [] }, { id: "q2", number: 2, maxScore: 3, rubric: [] }] };
    const prompt = `تصحیح اولیه:\nآزمون و بارم:\n${JSON.stringify(exam)}\n\nفایل‌های پیوست`;
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-live-contract-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/grading-model", messages: [{ role: "user", content: prompt }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    const content = payload.choices?.[0]?.message?.content || "";
    assert.ok(payload.usage?.total_tokens, "usage must be reported, as the panel expects");

    // Validate against the application's own schema, not a copy of it.
    const { modelResultSchema } = await import("../lib/server/grading-schema");
    const parsed = modelResultSchema.parse(JSON.parse(content));
    assert.equal(parsed.questions.length, 2);
    assert.equal(parsed.questions[0].questionId, "q1");
    assert.ok(parsed.questions[0].score <= parsed.questions[0].maxScore);
  } finally {
    child.kill();
  }
});
