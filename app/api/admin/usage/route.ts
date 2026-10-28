import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { cloudflareAll, cloudflareFirst, getCloudflareDb } from "@/lib/server/cloudflare";

export async function GET() {
  try {
    await requireAdmin();
    const summarySql = `SELECT COUNT(*) AS jobs,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failures,
      COALESCE(AVG(CASE WHEN status = 'succeeded' THEN latency_ms END), 0) AS average_latency
      FROM ai_jobs`;
    const recentSql = `SELECT j.id, j.provider, j.model, j.status, j.input_tokens, j.output_tokens,
      j.latency_ms, j.error, j.created_at, u.display_name, u.username
      FROM ai_jobs j JOIN users u ON u.id = j.user_id ORDER BY j.created_at DESC LIMIT 60`;
    const providersSql = `SELECT provider, model, COUNT(*) AS jobs,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM ai_jobs GROUP BY provider, model ORDER BY jobs DESC`;
    const cloud = await getCloudflareDb();
    if (cloud) {
      const [summary, recent, providers] = await Promise.all([
        cloudflareFirst(cloud, summarySql),
        cloudflareAll(cloud, recentSql),
        cloudflareAll(cloud, providersSql),
      ]);
      return NextResponse.json({ summary, recent, providers });
    }
    const db = (await import("@/lib/server/db")).getDb();
    const summary = db.prepare(summarySql).get();
    const recent = db.prepare(recentSql).all();
    const providers = db.prepare(providersSql).all();
    return NextResponse.json({ summary, recent, providers });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "گزارش مصرف در دسترس نیست." }, { status });
  }
}
