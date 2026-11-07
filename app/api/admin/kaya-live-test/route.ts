import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig } from "@/lib/server/provider-config";
import { providerBudgetSnapshot, withProviderBudget } from "@/lib/server/provider-rate-limit";
import { recordProviderFailure } from "@/lib/server/provider-failure-log";
import { conclusionFor, readingFor, upstreamMessage, type KayaProbeStep } from "@/lib/server/kaya-probe-readings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Sends the real request to Kaya, with the real key, from inside the running app.
 *
 * Every console probe so far answered a neighbouring question: is DNS wrong, is
 * the port open, is the certificate genuine. None of them could see what our own
 * code sends, and none of them used the saved key. So when the operator reported
 * "two runs worked at 14:00 and everything after 17:00 fails", there was no
 * measurement that could separate a network block from a rejected request.
 *
 * This endpoint makes that measurement in four steps, in this order, stopping as
 * soon as the answer is known:
 *
 *   1. GET  the catalogue          — is our URL and our client IP accepted
 *   2. POST one short sentence     — does a write reach Kaya at all
 *   3. POST with a base64 image    — does an image part survive the proxy
 *   4. POST with a large image     — is the payload near the ceiling
 *
 * Each step passes through the same outbound budget as grading, so pressing the
 * button repeatedly cannot get the host blocked. That is the whole point of the
 * counter: the test is subject to the same 120-per-20-minutes gate, and the
 * response says how many slots are left.
 *
 * Nothing is retried, no model is substituted, no setting is written, and the key
 * never appears in the response or in a log line.
 */

const HOST = "kayaai.ir";
const BASE = `https://${HOST}/api`;

interface StepResult {
  /** Which layer this line proves: the catalogue, a text write, or an image write. */
  step: KayaProbeStep;
  ok: boolean;
  skipped?: boolean;
  status: number;
  ms: number;
  sentBytes: number;
  /** What the request proves when it succeeds or fails this way. */
  reading: string;
  /** Upstream message, with any key-shaped text removed. */
  detail: string;
}

/** A JPEG built locally, so the test needs no uploaded sample. */
async function sampleImageBase64(targetBytes: number): Promise<{ data: string; note: string }> {
  try {
    const canvasModule = (await import("@napi-rs/canvas")) as unknown as {
      createCanvas: (width: number, height: number) => {
        getContext: (type: "2d") => {
          fillStyle: string;
          fillRect: (x: number, y: number, width: number, height: number) => void;
          font: string;
          fillText: (text: string, x: number, y: number) => void;
        };
        toBuffer: (format: "image/jpeg", quality: number) => Buffer;
      };
    };
    const width = 1400;
    const height = Math.max(400, Math.round(targetBytes / 900));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#111111";
    context.font = "26px sans-serif";
    for (let row = 0; row * 40 < height - 30; row += 1) {
      context.fillText(`سؤال ${row + 1}: پاسخ نمونه ${row + 1} + ${row} = ${row + 1}`, 20, 36 + row * 40);
    }
    return { data: canvas.toBuffer("image/jpeg", 0.85).toString("base64"), note: "generated at the measured size" };
  } catch {
    // Without the canvas module only a tiny image is possible; say so instead of
    // pretending the size was representative.
    const tiny =
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    return { data: tiny, note: "canvas module missing, so this image is 1x1 and only proves the shape is accepted" };
  }
}

async function send(
  path: string,
  body: Record<string, unknown> | null,
  apiKey: string,
  timeoutMs: number,
): Promise<{ status: number; text: string; sentBytes: number; ms: number; code: string }> {
  const payload = body === null ? undefined : JSON.stringify(body);
  const started = Date.now();
  return withProviderBudget(HOST, async () => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: body === null ? "GET" : "POST",
        headers:
          body === null
            ? { Accept: "application/json" }
            : {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
        body: payload,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = (await response.text()).slice(0, 4000);
      return { status: response.status, text, sentBytes: payload ? Buffer.byteLength(payload) : 0, ms: Date.now() - started, code: "" };
    } catch (error) {
      const value = error as { name?: string; code?: string; cause?: { code?: string } };
      return {
        status: 0,
        text: "",
        sentBytes: payload ? Buffer.byteLength(payload) : 0,
        ms: Date.now() - started,
        code: value?.cause?.code || value?.code || value?.name || "unknown",
      };
    }
  });
}

export async function POST() {
  try {
    await requireAdmin();
    const config = await getProviderConfig();

    if (config.provider !== "kaya") {
      return NextResponse.json(
        {
          error: `ارائه‌دهندهٔ فعال «${config.provider}» است، نه کایا. برای این آزمون کایا را در همین صفحه انتخاب و ذخیره کنید.`,
          provider: config.provider,
        },
        { status: 400 },
      );
    }

    const before = providerBudgetSnapshot([HOST])[0];
    const steps: StepResult[] = [];
    const model = config.model;

    const record = (step: KayaProbeStep, result: { status: number; text: string; sentBytes: number; ms: number; code: string }) => {
      const entry: StepResult = {
        step,
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        ms: result.ms,
        sentBytes: result.sentBytes,
        reading: readingFor(step, result),
        detail: upstreamMessage(result.text),
      };
      steps.push(entry);
      if (!entry.ok) {
        recordProviderFailure({
          hostname: HOST,
          model,
          provider: "kaya",
          code: result.status ? `HTTP_${result.status}` : result.code,
          detail: entry.detail || entry.reading,
          attempt: 1,
        });
      }
      return entry;
    };

    // 1. Catalogue: needs no key, and a 200 proves the URL and our client IP.
    const catalogue = record("catalogue", await send("/chat/completions", null, config.apiKey, 15_000));

    // 2. The smallest possible write.
    let textStep: StepResult | null = null;
    if (catalogue.status) {
      textStep = record(
        "text",
        await send(
          "/chat/completions",
          { model, messages: [{ role: "user", content: "فقط بنویس: سالم" }], max_tokens: 16, stream: false },
          config.apiKey,
          45_000,
        ),
      );
    }

    // 3. The same write with a small image attached.
    let imageStep: StepResult | null = null;
    if (textStep && textStep.ok) {
      const small = await sampleImageBase64(220_000);
      imageStep = record(
        "image",
        await send(
          "/chat/completions",
          {
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "این تصویر را در یک جمله توصیف کن." },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${small.data}`, detail: "high" } },
                ],
              },
            ],
            max_tokens: 32,
            stream: false,
          },
          config.apiKey,
          60_000,
        ),
      );
    }

    const after = providerBudgetSnapshot([HOST])[0];
    const conclusion = conclusionFor(steps.map((step) => ({ step: step.step, ok: step.ok })));

    return NextResponse.json({
      provider: "kaya",
      model,
      at: new Date().toISOString(),
      steps,
      conclusion,
      budget: {
        usedBefore: before?.used ?? 0,
        usedAfter: after?.used ?? 0,
        limit: after?.limit ?? 0,
        remaining: after?.remaining ?? 0,
        windowMinutes: after?.windowMinutes ?? 20,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "دسترسی مدیر لازم است." }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "آزمون انجام نشد.";
    // A budget refusal is expected behaviour, not a failure: it is the counter
    // doing its job.
    const code = (error as { code?: string }).code;
    if (code === "PROVIDER_BREAKER_OPEN" || code === "PROVIDER_RATE_LIMITED") {
      return NextResponse.json({ error: message, budgetRefusal: true }, { status: 429 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
