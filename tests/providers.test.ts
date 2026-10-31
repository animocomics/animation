import assert from "node:assert/strict";
import test from "node:test";
import { buildGradingPrompt, callProvider, ProviderError } from "../lib/server/providers";
import type { GradeApiRequest, ProviderId } from "../lib/types";

const modelResult = {
  detectedStudentName: "سارا محمدی", detectedClassName: "یازدهم تجربی", identityConfidence: 0.94,
  summary: "پاسخ‌ها بررسی شد.", strengths: [], improvements: [], overallConfidence: 0.9, questions: [], flags: [],
};
const files: GradeApiRequest["files"] = [
  { name: "page.png", type: "image/png", data: "cG5nLXRlc3QtZGF0YQ==" },
  { name: "pages.pdf", type: "application/pdf", data: "cGRmLXRlc3QtZGF0YQ==" },
];

async function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init || {})) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("OpenAI adapter sends multimodal Responses input, strict schema and parses usage", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-openai");
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    const content = body.input[0].content;
    assert.ok(content.some((part: { type: string }) => part.type === "input_image"));
    assert.ok(content.some((part: { type: string }) => part.type === "input_file"));
    return Response.json({ output_text: JSON.stringify(modelResult), usage: { input_tokens: 120, output_tokens: 30 } });
  }, async () => {
    const response = await callProvider({ provider: "openai", model: "gpt-4.1", apiKey: "secret-openai", prompt: "prompt", files });
    assert.equal(response.result.detectedStudentName, "سارا محمدی");
    assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 30 });
  });
});

test("DeepSeek adapter uses its Responses endpoint and accepts image content", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.deepseek.com/responses");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek-flash");
    assert.ok(!("store" in body));
    return Response.json({ output: [{ content: [{ text: JSON.stringify(modelResult) }] }] });
  }, async () => {
    const response = await callProvider({ provider: "deepseek", model: "deepseek-flash", apiKey: "secret-deepseek", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.identityConfidence, 0.94);
  });
});

test("Z.AI GLM adapter uses Chat Completions, native image parts, JSON mode and usage", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.z.ai/api/paas/v4/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-zai");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /JSON Schema/);
    const content = body.messages[1].content;
    assert.ok(content.some((part: { type: string }) => part.type === "text"));
    const image = content.find((part: { type: string }) => part.type === "image_url");
    assert.equal(image.image_url.url, "data:image/png;base64,cG5nLXRlc3QtZGF0YQ==");
    assert.ok(!content.some((part: { type: string }) => part.type === "input_file"));
    return Response.json({
      choices: [{ message: { content: JSON.stringify(modelResult) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 140, completion_tokens: 35 },
    });
  }, async () => {
    const response = await callProvider({ provider: "zai", model: "glm-5.3-flash", apiKey: "secret-zai", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.detectedStudentName, "سارا محمدی");
    assert.deepEqual(response.usage, { inputTokens: 140, outputTokens: 35 });
  });
});

test("MiniMax adapter uses M3.1 multimodal Chat Completions without unsupported JSON mode", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.minimax.io/v1/chat/completions");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-minimax");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "MiniMax-M3.1-Flash");
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.reasoning_split, true);
    assert.equal(body.max_completion_tokens, 32768);
    assert.ok(!("response_format" in body));
    const image = body.messages[1].content.find((part: { type: string }) => part.type === "image_url");
    assert.equal(image.image_url.url, "data:image/png;base64,cG5nLXRlc3QtZGF0YQ==");
    assert.equal(image.image_url.detail, "high");
    return Response.json({
      choices: [{ message: { content: `<think>reasoning</think>\n${JSON.stringify(modelResult)}`, reasoning_content: "reasoning" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 210, completion_tokens: 55 },
    });
  }, async () => {
    const response = await callProvider({ provider: "minimax", model: "MiniMax-M3.1-Flash", apiKey: "secret-minimax", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.detectedStudentName, "سارا محمدی");
    assert.deepEqual(response.usage, { inputTokens: 210, outputTokens: 55 });
  });
});

test("Mistral Large 4 adapter uses high reasoning, JSON mode, string image URLs and text chunks", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.mistral.ai/v1/chat/completions");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-mistral");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "mistral-large-4");
    assert.equal(body.reasoning_effort, "high");
    assert.deepEqual(body.response_format, { type: "json_object" });
    const image = body.messages[1].content.find((part: { type: string }) => part.type === "image_url");
    assert.equal(image.image_url, "data:image/png;base64,cG5nLXRlc3QtZGF0YQ==");
    return Response.json({
      choices: [{ message: { content: [{ type: "thinking", thinking: [{ type: "text", text: "reasoning" }] }, { type: "text", text: JSON.stringify(modelResult) }] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 180, completion_tokens: 44 },
    });
  }, async () => {
    const response = await callProvider({ provider: "mistral", model: "mistral-large-4", apiKey: "secret-mistral", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.identityConfidence, 0.94);
    assert.deepEqual(response.usage, { inputTokens: 180, outputTokens: 44 });
  });
});

test("Inkling adapter uses official Tinker Messages image blocks, high effort and usage", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/messages");
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "secret-inkling");
    assert.equal((init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4");
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.match(body.system, /JSON Schema/);
    const image = body.messages[0].content.find((part: { type: string }) => part.type === "image");
    assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data: "cG5nLXRlc3QtZGF0YQ==" });
    return Response.json({
      content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: JSON.stringify(modelResult) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 160, output_tokens: 40 },
    });
  }, async () => {
    const response = await callProvider({ provider: "inkling", model: "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4", apiKey: "secret-inkling", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.detectedStudentName, "سارا محمدی");
    assert.deepEqual(response.usage, { inputTokens: 160, outputTokens: 40 });
  });
});

test("Gemini adapter sends inline PDF/image data and parses fenced JSON", async () => {
  await mockFetch((url, init) => {
    assert.match(url, /gemini-2\.5-pro:generateContent$/);
    assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "secret-gemini");
    const body = JSON.parse(String(init.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.contents[0].parts.filter((part: { inline_data?: unknown }) => part.inline_data).length, 2);
    return Response.json({ candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(modelResult)}\n\`\`\`` }] } }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 } });
  }, async () => {
    const response = await callProvider({ provider: "gemini", model: "gemini-2.5-pro", apiKey: "secret-gemini", prompt: "prompt", files });
    assert.deepEqual(response.usage, { inputTokens: 80, outputTokens: 20 });
  });
});

test("provider errors and malformed model output never become grades", async () => {
  for (const [provider, payload] of [["openai", { error: { message: "bad key" } }], ["gemini", { candidates: [{ content: { parts: [{ text: "not-json" }] } }] }], ["zai", { choices: [{ message: { content: "not-json" } }] }], ["minimax", { choices: [{ message: { content: "not-json" } }] }], ["mistral", { choices: [{ message: { content: "not-json" } }] }], ["inkling", { content: [{ type: "text", text: "not-json" }] }]] as Array<[ProviderId, unknown]>) {
    await mockFetch(() => Response.json(payload, { status: provider === "openai" ? 401 : 200 }), async () => {
      await assert.rejects(callProvider({ provider, model: "test", apiKey: "bad", prompt: "prompt", files: files.slice(0, 1) }), ProviderError);
    });
  }
});

test("anonymous prompt excludes roster identity while non-anonymous mode labels it for matching only", () => {
  const request: GradeApiRequest = {
    examId: "exam_1",
    exam: { title: "آزمون", subject: "زیست", passScore: 10, settings: { gradingMode: "fast", reviewThreshold: 0.8, anonymize: true, requireApproval: true, instructions: "" }, questions: [{ id: "q1", number: 1, type: "short_answer", prompt: "سؤال", maxScore: 2, answer: "پاسخ", options: [], acceptedAnswers: [], partialCredit: true, errorCarriedForward: false, rubric: [] }] },
    student: { name: "نام محرمانه دانش‌آموز", code: "123" }, files: files.slice(0, 1),
  };
  assert.ok(!buildGradingPrompt(request).includes("نام محرمانه دانش‌آموز"));
  request.exam.settings.anonymize = false;
  const visible = buildGradingPrompt(request);
  assert.ok(visible.includes("نام محرمانه دانش‌آموز"));
  assert.match(visible, /فقط برای تطبیق/);
});
