#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");

const ORIGIN = "https://nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_AI_ACCEPTANCE_OUTPUT || "";
const RUN_HANDWRITING = process.env.NOMREH_RUN_HANDWRITING === "1";
const SKIP_PROVIDER_TEST = process.env.NOMREH_SKIP_PROVIDER_TEST === "1";
const lines = ["# Nomreh live AI acceptance", "", "Authorized test accounts are used in memory. No API key, cookie, student paper, or credential is printed. The handwriting fixture is a generated, controlled handwriting-style sample, not a human-written exam.", ""];
let admin;
let teacher;

function clean(value) {
  return String(value ?? "")
    .split(/\r?\n\s*Call log:/i)[0]
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, "[کلید]")
    .replace(/Bearer\s+\S+/gi, "Bearer [حذف‌شده]")
    .replace(/(?:nomreh_session|next-auth\.session-token)=[^\s;]+/gi, "[جلسهٔ حذف‌شده]")
    .replace(/(?:cookie|authorization|set-cookie):\s*[^\s]+/gi, "[سرآیند محرمانه]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function report() {
  const text = lines.join("\n");
  if (OUTPUT) fs.writeFileSync(OUTPUT, text, { mode: 0o600 });
  return text;
}

async function api(context, method, pathname, body) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await context.fetch(`${ORIGIN}${pathname}`, {
        method,
        data: body,
        headers: { Accept: "application/json" },
        timeout: method === "POST" && pathname === "/api/grade" ? 330000 : 45000,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* Keep only status and content type for HTML/non-JSON responses. */ }
      return { response, status: response.status(), contentType: response.headers()["content-type"] || "none", payload, text };
    } catch (error) {
      lastError = error;
      if (method !== "GET" || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  throw lastError;
}

function errorText(result) {
  if (result.payload && typeof result.payload.error === "string") return clean(result.payload.error);
  if (!result.payload && result.text) {
    const title = result.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    return `پاسخ غیر JSON (نوع محتوا: ${clean(result.contentType)}${title ? `؛ عنوان: ${clean(title)}` : ""})`;
  }
  return "خطای نامشخص";
}

async function login(context, username, password) {
  const result = await api(context, "POST", "/api/auth/login", { username, password });
  if (!result.response.ok() || !result.payload?.user) throw new Error(`ورود حساب آزمایشی با HTTP ${result.status} رد شد: ${errorText(result)}`);
  return result.payload.user;
}

function usageSummary(payload) {
  const summary = payload?.summary || {};
  return {
    jobs: number(summary.jobs),
    input: number(summary.input_tokens),
    output: number(summary.output_tokens),
    failures: number(summary.failures),
    averageLatency: number(summary.average_latency),
  };
}

function usageLine(summary, label) {
  return `- ${label}: ${summary.jobs} job(s); input tokens ${summary.input}; output tokens ${summary.output}; total ${summary.input + summary.output}; failed ${summary.failures}; average successful latency ${Math.round(summary.averageLatency)} ms.`;
}

function emptyWorkspace(provider, model) {
  return {
    exams: [],
    classes: [],
    settings: { provider, model, gradingMode: "fast", reviewThreshold: 0.8, anonymize: false, requireApproval: true },
  };
}

function makeExam(provider, model, id) {
  const now = new Date().toISOString();
  const question = {
    id: `${id}-q1`,
    number: 1,
    type: "short_answer",
    prompt: "واحد ساختمان و عملکرد سلول‌های زنده چه نامیده می‌شود؟",
    maxScore: 1,
    answer: "سلول",
    options: [],
    acceptedAnswers: ["یاخته"],
    partialCredit: false,
    errorCarriedForward: false,
    rubric: [{ id: `${id}-r1`, label: "پاسخ صحیح", description: "نوشتن سلول یا یاخته در پاسخ", points: 1 }],
  };
  return {
    id,
    title: "آزمون موقت خواندن دست‌نویس فارسی",
    subject: "زیست‌شناسی",
    className: "آزمون فنی موقت",
    date: now,
    passScore: 0.5,
    duration: 5,
    status: "ready",
    questions: [question],
    questionsNeedReview: false,
    settings: { gradingMode: "fast", reviewThreshold: 0.8, anonymize: false, requireApproval: true, instructions: "فقط متن قابل مشاهده را بخوان؛ هیچ حدسی نزن." },
    submissions: [],
    createdAt: now,
    updatedAt: now,
    isDemo: false,
  };
}

async function saveWorkspace(data, revision) {
  const result = await api(teacher, "POST", "/api/workspace", { data, expectedRevision: revision });
  if (!result.response.ok() || typeof result.payload?.revision !== "number") throw new Error(`ذخیرهٔ آزمون موقت با HTTP ${result.status} ناموفق بود: ${errorText(result)}`);
  return result.payload.revision;
}

async function removeTemporaryExam(id) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await api(teacher, "GET", "/api/workspace");
    if (!current.response.ok()) throw new Error(`خواندن فضای کاری برای پاک‌سازی با HTTP ${current.status} ناموفق بود.`);
    const data = current.payload?.data;
    if (!data || !Array.isArray(data.exams)) return "فضای کاری خالی بود؛ آزمون موقتی برای حذف باقی نماند.";
    if (!data.exams.some((exam) => exam.id === id)) return "آزمون موقت دیگر وجود نداشت.";
    data.exams = data.exams.filter((exam) => exam.id !== id);
    try {
      await saveWorkspace(data, number(current.payload.revision));
      return "آزمون موقت حذف شد؛ سایر داده‌های فضای کاری حفظ شد.";
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return "پاک‌سازی آزمون موقت انجام نشد.";
}

async function run() {
  const browserHeaders = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
  };
  admin = await request.newContext({ extraHTTPHeaders: browserHeaders });
  teacher = await request.newContext({ extraHTTPHeaders: browserHeaders });
  const adminUsername = process.env.NOMREH_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.NOMREH_ADMIN_PASSWORD || "Admin@1405";
  const teacherUsername = process.env.NOMREH_TEACHER_USERNAME || "teacher";
  const teacherPassword = process.env.NOMREH_TEACHER_PASSWORD || "Teacher@1405";
  await login(admin, adminUsername, adminPassword);

  const providerResult = await api(admin, "GET", "/api/provider");
  if (!providerResult.response.ok() || !providerResult.payload?.status) throw new Error(`وضعیت اتصال خوانده نشد: HTTP ${providerResult.status} ${errorText(providerResult)}`);
  const provider = providerResult.payload.status;
  lines.push("## Current provider and recorded usage", "");
  lines.push(`- Configured: ${provider.configured ? "yes" : "no"}; provider: ${clean(provider.providerLabel)}; model: ${clean(provider.model)}.`);
  if (!provider.configured) lines.push("- No stored provider key is configured; no external AI grading request can be made.");
  const networkResult = await api(admin, "GET", "/api/admin/api-network");
  if (networkResult.response.ok() && networkResult.payload?.status) {
    const network = networkResult.payload.status;
    lines.push(`- Shecan status (read-only): configured ${network.configured ? "yes" : "no"}; enabled ${network.enabled ? "yes" : "no"}; plan ${clean(network.plan)}; last test ${clean(network.lastTestStatus)}; message: ${clean(network.lastTestMessage)}.`);
  } else {
    lines.push(`- Shecan status could not be read: HTTP ${networkResult.status} ${errorText(networkResult)}.`);
  }
  const publicResponse = await admin.get(`${ORIGIN}/`, { timeout: 20000 }).catch(() => undefined);
  lines.push(`- Public home response during this check: ${publicResponse ? `HTTP ${publicResponse.status()}` : "unavailable"}.`);

  const beforeUsageResult = await api(admin, "GET", "/api/admin/usage");
  if (!beforeUsageResult.response.ok()) throw new Error(`گزارش مصرف خوانده نشد: HTTP ${beforeUsageResult.status} ${errorText(beforeUsageResult)}`);
  const beforeUsage = usageSummary(beforeUsageResult.payload);
  lines.push(usageLine(beforeUsage, "Recorded usage before this check"));

  if (provider.configured && !SKIP_PROVIDER_TEST) {
    const schemaProbe = await api(admin, "POST", "/api/provider/test", { provider: provider.provider, model: "" });
    lines.push(`- Schema-only provider route probe (no provider call): HTTP ${schemaProbe.status}; ${schemaProbe.payload ? "JSON response" : errorText(schemaProbe)}.`);
    const testResult = await api(admin, "POST", "/api/provider/test", { provider: provider.provider, model: provider.model });
    lines.push(`- Stored-key provider test: HTTP ${testResult.status}; ${testResult.response.ok() ? "provider accepted the model/key test" : `failed: ${errorText(testResult)}`}.`);
    if (testResult.status === 429) lines.push("- The provider returned HTTP 429; this is a quota/rate-limit signal, not a measurement of the remaining quota.");
    const modelsResult = await api(admin, "POST", "/api/provider/models", { provider: provider.provider });
    const models = Array.isArray(modelsResult.payload?.models) ? modelsResult.payload.models : [];
    lines.push(`- Stored-key account model discovery: HTTP ${modelsResult.status}; ${modelsResult.response.ok() ? `${models.length} compatible model(s) returned; selected model present: ${models.includes(provider.model) ? "yes" : "no"}` : errorText(modelsResult)}.`);
  } else if (SKIP_PROVIDER_TEST) {
    lines.push("- Stored-key provider test skipped for this read-only network check.");
  }

  let handwritingAttempted = false;
  let handwritingSucceeded = false;
  let temporaryExamId = "";
  if (RUN_HANDWRITING && provider.configured) {
    handwritingAttempted = true;
    await login(teacher, teacherUsername, teacherPassword);
    temporaryExamId = `tmp-persian-handwriting-${Date.now()}`;
    const workspaceResult = await api(teacher, "GET", "/api/workspace");
    if (!workspaceResult.response.ok()) throw new Error(`فضای کاری معلم برای آزمون موقت خوانده نشد: HTTP ${workspaceResult.status}.`);
    const originalData = workspaceResult.payload?.data || emptyWorkspace(provider.provider, provider.model);
    const temporaryExam = makeExam(provider.provider, provider.model, temporaryExamId);
    const temporaryData = { ...originalData, exams: [...originalData.exams, temporaryExam] };
    await saveWorkspace(temporaryData, number(workspaceResult.payload?.revision));
    lines.push("- A one-question temporary exam was created in the teacher workspace; no existing exam was edited.");

    try {
      const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "persian-handwriting-test.png")).toString("base64");
      const gradeResult = await api(teacher, "POST", "/api/grade", {
        examId: temporaryExamId,
        exam: {
          title: temporaryExam.title,
          subject: temporaryExam.subject,
          passScore: temporaryExam.passScore,
          settings: temporaryExam.settings,
          questions: temporaryExam.questions,
        },
        student: { name: "", code: "" },
        files: [{ name: "persian-handwriting-test.png", type: "image/png", data: fixture }],
      });
      lines.push(`- Persian handwriting grading request: HTTP ${gradeResult.status}.`);
      if (!gradeResult.response.ok()) {
        lines.push(`- Handwriting grading failed safely: ${errorText(gradeResult)}.`);
      } else {
        const result = gradeResult.payload?.result;
        const question = result?.questions?.[0];
        const transcript = clean(question?.transcript || "");
        const extracted = clean(question?.extractedAnswer || "");
        const inputTokens = number(result?.usage?.inputTokens);
        const outputTokens = number(result?.usage?.outputTokens);
        const mentionsExpected = /سلول|یاخته/.test(`${transcript} ${extracted}`);
        handwritingSucceeded = Boolean(result && question && mentionsExpected && inputTokens + outputTokens > 0);
        lines.push(`- Structured result: ${result ? "yes" : "no"}; question result: ${question ? "yes" : "no"}; expected word سلول/یاخته visible in transcript or extracted answer: ${mentionsExpected ? "yes" : "no"}.`);
        lines.push(`- Reported transcription: ${transcript || "[empty]"}; extracted answer: ${extracted || "[empty]"}.`);
        lines.push(`- Score returned by the model: ${number(question?.score)} / ${number(question?.maxScore)}; needs teacher review: ${question?.needsReview ? "yes" : "no"}; overall confidence: ${number(result?.overallConfidence)}.`);
        lines.push(`- Tokens reported by this grading call: input ${inputTokens}; output ${outputTokens}; total ${inputTokens + outputTokens}.`);
        if (!handwritingSucceeded) lines.push("- The response did not meet the controlled success criterion; this is not counted as a successful handwriting read.");
      }
    } finally {
      try { lines.push(`- Cleanup: ${await removeTemporaryExam(temporaryExamId)}`); }
      catch (error) { lines.push(`- Cleanup failed and requires attention: ${clean(error.message)}`); }
    }
  } else if (RUN_HANDWRITING) {
    lines.push("- Handwriting test skipped because no provider key is configured.");
  } else {
    lines.push("- Handwriting test was not requested in this run.");
  }

  let afterUsage;
  try {
    const afterUsageResult = await api(admin, "GET", "/api/admin/usage");
    if (!afterUsageResult.response.ok()) throw new Error(`HTTP ${afterUsageResult.status}: ${errorText(afterUsageResult)}`);
    afterUsage = usageSummary(afterUsageResult.payload);
    lines.push(usageLine(afterUsage, "Recorded usage after this check"));
    lines.push(`- Delta during this check: jobs ${afterUsage.jobs - beforeUsage.jobs}; input tokens ${afterUsage.input - beforeUsage.input}; output tokens ${afterUsage.output - beforeUsage.output}; total ${afterUsage.input + afterUsage.output - beforeUsage.input - beforeUsage.output}.`);
  } catch (error) {
    lines.push(`- Recorded usage after this check: unavailable after three safe read attempts (${clean(error.message)}); the delta is unknown, not zero.`);
  }
  lines.push("", "## Quota boundary", "", "- The application records tokens from completed/failed grading jobs, but the provider status and usage APIs do not expose the account's remaining quota, daily reset, or free-tier balance. An exact remaining allowance cannot be inferred from these numbers.");
  lines.push("- A successful provider test is not a quota guarantee. Only the provider dashboard/account can confirm the current plan and remaining/rate-limited allowance; HTTP 429 is the reliable live signal when a limit is reached.");
  lines.push("", "## Result", "", `- Handwriting attempted: ${handwritingAttempted ? "yes" : "no"}; controlled handwriting success: ${handwritingSucceeded ? "yes" : "no"}.`);
}

run().catch((error) => {
  lines.push("", "## Stopped", "", clean(error.message));
  process.exitCode = 1;
}).finally(async () => {
  if (teacher) await teacher.post(`${ORIGIN}/api/auth/logout`).catch(() => undefined);
  if (admin) await admin.post(`${ORIGIN}/api/auth/logout`).catch(() => undefined);
  if (teacher) await teacher.dispose();
  if (admin) await admin.dispose();
  console.log(report());
});
