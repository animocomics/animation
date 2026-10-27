import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";

export async function GET() {
  try {
    await requireAdmin();
    const db = getDb();
    const summary = db.prepare(`SELECT COUNT(*) AS jobs,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failures,
      COALESCE(AVG(CASE WHEN status = 'succeeded' THEN latency_ms END), 0) AS average_latency
      FROM ai_jobs`).get();
    const recent = db.prepare(`SELECT j.id, j.provider, j.model, j.status, j.input_tokens, j.output_tokens,
      j.latency_ms, j.error, j.created_at, u.display_name, u.username
      FROM ai_jobs j JOIN users u ON u.id = j.user_id ORDER BY j.created_at DESC LIMIT 60`).all();
    const providers = db.prepare(`SELECT provider, model, COUNT(*) AS jobs,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM ai_jobs GROUP BY provider, model ORDER BY jobs DESC`).all();
    return NextResponse.json({ summary, recent, providers });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "گزارش مصرف در دسترس نیست." }, { status });
  }
}
