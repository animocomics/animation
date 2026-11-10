#!/usr/bin/env node
"use strict";

/**
 * A local stand-in for the Kaya API — for validating Nomreh inside a sandbox that
 * cannot reach the real vendor.
 *
 * Why this exists, in plain words: this sandbox has no route to kayaai.ir (TCP
 * opens, TLS is torn down) and no route to any AI vendor at all, so an end-to-end
 * grading test would always end at "the network is closed". This server speaks the
 * same OpenAI-compatible contract Kaya speaks, on 127.0.0.1, so the *application*
 * can be proven: the key is decrypted, the request is built, the images are
 * attached, the JSON is parsed, normalised, scored and stored.
 *
 * What it deliberately does NOT do:
 *   * it never answers for the real host unless the operator points the app at it
 *     (`http://127.0.0.1:4010/api` in the Kaya egress field), so a misconfigured
 *     deployment cannot silently reach it;
 *   * it refuses a placeholder key, so "the test passed" cannot mean "auth was
 *     skipped";
 *   * it never echoes the key back in any response or log line.
 *
 * What it is not: real grading. The scores come from the prompt's question ids and
 * a simple rule, which is enough to prove the pipeline while being obvious in the
 * output that no model judged anything.
 *
 * Run:  node scripts/nomreh-kaya-stub.cjs [--port 4010]
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.NOMREH_STUB_PORT || 4010);
// NOMREH_STUB_DELAY_MS makes the stand-in answer as slowly as a real model reading a
// sheet. Without it, a timeout bug can never be reproduced: the stub answers instantly
// and every proxy looks patient. This is the only way to test that a sixty-second
// proxy limit no longer loses a two-minute read.
const DELAY_MS = Number(process.env.NOMREH_STUB_DELAY_MS || 0);
const HOST = process.env.NOMREH_STUB_HOST || "0.0.0.0";
// A key name, never the key: the stub accepts anything long enough to be a real
// key and rejects the fixtures we know are placeholders.
const PLACEHOLDER = /^(test|dummy|invalid|changeme|placeholder|example)/i;
const LOG_FILE = process.env.NOMREH_STUB_LOG || path.join(process.cwd(), "data", "kaya-stub.log");

function log(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}`;
  console.log(text);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${text}\n`);
  } catch {
    /* logging is best effort; the response matters more */
  }
}

/** The catalogue an OpenAI-compatible client expects at GET /models. */
const MODELS = [
  "stub/grading-model",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3-vl-32b",
  "openai/gpt-4.1-mini",
];

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Reads the body, with a cap so a broken client cannot exhaust memory. */
function readBody(request, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("BODY_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Builds a result that satisfies the application's own Zod schema. The shapes here
 * are copied from lib/server/grading-schema.ts on purpose: if that schema changes,
 * this stub must change too, and a mismatch is exactly the failure worth seeing.
 */
function gradingResult(promptText) {
  // The application sends the exam (including question ids and marks) inside the
  // prompt, so the stub can answer for the questions that were actually asked.
  let exam = null;
  const start = promptText.indexOf("آزمون و بارم:");
  if (start !== -1) {
    const jsonStart = promptText.indexOf("{", start);
    // The exam object is followed by a blank line in buildGradingPrompt.
    const tail = promptText.slice(jsonStart);
    let depth = 0;
    let end = -1;
    for (let index = 0; index < tail.length; index += 1) {
      const char = tail[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end > 0) {
      try {
        exam = JSON.parse(tail.slice(0, end));
      } catch {
        exam = null;
      }
    }
  }

  const questions = Array.isArray(exam?.questions) && exam.questions.length
    ? exam.questions
    : [{ id: "q1", number: 1, maxScore: 1, rubric: [] }];

  const answered = questions.map((question, index) => {
    const maxScore = Number(question.maxScore) || 1;
    // Deterministic, and visibly not a judgement: every third answer loses half a
    // mark so the review/threshold paths get exercised as well.
    const score = index % 3 === 2 ? Math.round(maxScore * 50) / 100 : maxScore;
    return {
      questionId: String(question.id || `q${index + 1}`),
      transcript: `پاسخ خوانده‌شدهٔ سؤال ${question.number || index + 1} — از آزمون آزمایشی داخلی`,
      extractedAnswer: `پاسخ نمونه ${index + 1}`,
      score,
      maxScore,
      confidence: index % 3 === 2 ? 0.55 : 0.93,
      needsReview: index % 3 === 2,
      rationale: index % 3 === 2
        ? "نیمی از بارم داده شد؛ این نمره از آزمون آزمایشی داخلی است، نه داوری مدل."
        : "پاسخ کامل تشخیص داده شد؛ آزمون آزمایشی داخلی.",
      evidence: { page: 1, excerpt: `سطر ${index + 1} از برگه` },
      criteria: (Array.isArray(question.rubric) ? question.rubric : []).map((criterion) => ({
        criterionId: String(criterion.id || "c1"),
        score: Number(criterion.points) || maxScore,
        maxScore: Number(criterion.points) || maxScore,
        note: "آزمون آزمایشی داخلی",
      })),
      flags: index % 3 === 2 ? ["grade_boundary"] : [],
    };
  });

  const total = answered.reduce((sum, item) => sum + item.score, 0);
  return {
    detectedStudentName: "دانش‌آموز نمونه",
    detectedStudentCode: "",
    detectedClassName: "",
    identityConfidence: 0.6,
    summary: `آزمون آزمایشی داخلی: ${answered.length} سؤال بررسی شد و مجموع ${total} نمره ثبت شد. این خروجی از مدل نیست.`,
    strengths: ["همهٔ سؤال‌ها پاسخ داشتند"],
    improvements: ["یک سؤال در مرز نمره بود"],
    overallConfidence: 0.8,
    questions: answered,
    flags: [],
  };
}

/**
 * Answers the question-import task.
 *
 * Shaped on purpose the way a real model drifts: `rubric` omitted, a score sent as a
 * string, and a trailing extra field. That is exactly the payload that used to be
 * rejected wholesale after the tokens had been spent, so the stub is the regression
 * fixture for the tolerant parser. `NOMREH_STUB_BAD_IMPORT=1` makes it drop one
 * unreadable question as well, to exercise the salvage path.
 */
function questionImportResult() {
  // Deliberately sloppier than the schema: question 1 omits rubric / complete /
  // issues / acceptedAnswers entirely and sends maxScore as a string plus an
  // unknown field, which is exactly what real gateways do. The importer must
  // still keep it instead of discarding the whole (already billed) answer.
  const base = [
    {
      number: 1,
      type: "short_answer",
      prompt: "۱+۱ چند است؟",
      maxScore: "2",
      answer: "۲",
      options: [],
      note: "فیلد ناشناخته که مدل خودش اضافه کرده",
    },
    {
      number: 2,
      type: "multiple_choice",
      prompt: "پایتخت فرانسه کدام است؟",
      maxScore: 2,
      // NOMREH_STUB_MISSING_KEY=1 reproduces the operator's report: a multiple-choice
      // question whose key was not read. The importer must keep the question, name the
      // missing key, and still return a draft.
      answer: process.env.NOMREH_STUB_MISSING_KEY === "1" ? "" : "پاریس",
      options: ["لندن", "پاریس", "رم"],
      acceptedAnswers: [],
      rubric: [{ label: "پاسخ درست", description: "انتخاب پاریس", points: 2 }],
      complete: true,
      issues: [],
    },
  ];
  if (process.env.NOMREH_STUB_BAD_IMPORT === "1") {
    base.push({ number: 3, type: "not-a-real-type", prompt: "سؤال سه", maxScore: 1, answer: "", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] });
  }
  return { questions: base, warnings: [] };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const route = url.pathname.replace(/\/+$/, "");

  // Health: no credential, no budget cost, used by the panel and by scripts.
  if (request.method === "GET" && (route === "/api/health" || route === "/health")) {
    return send(response, 200, { ok: true, service: "nomreh-kaya-stub", models: MODELS.length });
  }

  if (request.method === "GET" && (route === "/api/models" || route === "/api/chat/completions" || route === "/api/v1/models")) {
    return send(response, 200, {
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", owned_by: "nomreh-stub" })),
    });
  }

  if (request.method === "POST" && (route === "/api/chat/completions" || route === "/api/v1/chat/completions")) {
    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    const authorization = String(request.headers.authorization || "");
    const key = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!key) {
      log("POST rejected: no key");
      return send(response, 401, { error: { message: "No API key supplied." } });
    }
    if (key.length < 12 || PLACEHOLDER.test(key)) {
      // Deliberately the same surface message Kaya uses for a bad key.
      log("POST rejected: placeholder key");
      return send(response, 401, { error: { message: "API key is not valid." } });
    }

    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      return send(response, 400, { error: { message: "Body is not valid JSON." } });
    }

    // Some real gateways reject a single optional field with a 400 and burn the
    // input anyway. `NOMREH_STUB_REJECT_PARAMS=1` reproduces that so the plain-body
    // retry is exercised end to end instead of only in a unit test.
    if (process.env.NOMREH_STUB_REJECT_PARAMS === "1") {
      const offending = ["response_format", "temperature", "stream"]
        .find((field) => field in body && field !== "stream");
      if (offending) {
        log(`POST rejected: unsupported parameter ${offending}`);
        return send(response, 400, { error: { message: `Unsupported parameter: '${offending}' is not supported for this model.` } });
      }
      const hasDetail = JSON.stringify(body).includes('"detail"');
      if (hasDetail) {
        log("POST rejected: unsupported image detail");
        return send(response, 400, { error: { message: "Invalid value: 'detail' is not supported for this model." } });
      }
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = messages
      .map((message) => (typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join(" ")
          : ""))
      .join("\n");
    const imageParts = messages.reduce((count, message) => count + (Array.isArray(message.content)
      ? message.content.filter((part) => part && part.type === "image_url").length
      : 0), 0);

    const model = typeof body.model === "string" ? body.model : MODELS[0];
    // The importer and the grader share this endpoint, so the task is read from the
    // system instructions the application itself sent — not guessed.
    const isImport = /خوانندهٔ سؤال و کلید/.test(text);
    const result = isImport ? questionImportResult() : gradingResult(text);
    const content = JSON.stringify(result);
    log(`POST ok model=${model} task=${isImport ? "question-import" : "grading"} images=${imageParts} keyFingerprint=${key.length}chars`);

    return send(response, 200, {
      id: `stub-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1200 + imageParts * 100, completion_tokens: 900, total_tokens: 2100 + imageParts * 100 },
    });
  }

  send(response, 404, { error: { message: `Unknown route ${request.method} ${route}` } });
});

server.listen(PORT, HOST, () => {
  const line = `Nomreh Kaya stub ready on http://${HOST}:${PORT}/api (models: ${MODELS.length})`;
  console.log(line);
  log(line);
});
