import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin, toAuthUser } from "@/lib/server/auth";
import { createId } from "@/lib/server/ids";
import { hashPassword, isStrongEnoughPassword } from "@/lib/server/password";
import type { UserRole } from "@/lib/types";

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, "نام کاربری باید ۳ تا ۴۰ نویسهٔ انگلیسی، عدد یا نقطه باشد."),
  displayName: z.string().trim().min(2).max(100),
  password: z.string().min(8).max(300),
  role: z.enum(["teacher", "reviewer"]).default("teacher"),
});
const updateSchema = z.object({
  id: z.string().min(1),
  active: z.boolean().optional(),
  displayName: z.string().trim().min(2).max(100).optional(),
  password: z.string().min(8).max(300).optional(),
});

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  active: number;
  created_at: string;
  last_login_at: string | null;
  job_count: number;
  token_count: number;
  workspace_updated_at: string | null;
}

async function localDb() {
  return (await import("@/lib/server/db")).getDb();
}

async function listUsers() {
  const sql = `SELECT u.*,
    (SELECT COUNT(*) FROM ai_jobs j WHERE j.user_id = u.id) AS job_count,
    (SELECT COALESCE(SUM(j.input_tokens + j.output_tokens), 0) FROM ai_jobs j WHERE j.user_id = u.id) AS token_count,
    (SELECT w.updated_at FROM workspaces w WHERE w.user_id = u.id) AS workspace_updated_at
    FROM users u ORDER BY u.created_at`;
  const rows = (await localDb()).prepare(sql).all() as AdminUserRow[];
  return rows.map((row) => ({
    ...toAuthUser(row),
    jobCount: row.job_count,
    tokenCount: row.token_count,
    workspaceUpdatedAt: row.workspace_updated_at || undefined,
  }));
}

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطای مدیریت کاربران" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = createSchema.parse(await request.json());
    if (!isStrongEnoughPassword(input.password)) throw new Error("رمز عبور باید دست‌کم ۸ نویسه و شامل حرف و عدد باشد.");
    const values = [createId("user"), input.username, input.displayName, hashPassword(input.password), input.role, new Date().toISOString()];
    const sql = `INSERT INTO users (id, username, display_name, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`;
    (await localDb()).prepare(sql).run(...values);
    return NextResponse.json({ users: await listUsers() }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message || "اطلاعات کاربر معتبر نیست." }, { status: 400 });
    const duplicate = error instanceof Error && error.message.includes("UNIQUE");
    const status = error instanceof AuthError ? error.status : duplicate ? 409 : 400;
    return NextResponse.json({ error: duplicate ? "این نام کاربری قبلاً ثبت شده است." : error instanceof Error ? error.message : "ساخت کاربر ناموفق بود." }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = updateSchema.parse(await request.json());
    const db = await localDb();
    const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(input.id) as { id: string; role: UserRole } | undefined;
    if (!target) return NextResponse.json({ error: "کاربر پیدا نشد." }, { status: 404 });
    if (input.active === false && (input.id === admin.id || target.role === "admin")) {
      return NextResponse.json({ error: "حساب مدیر را نمی‌توان غیرفعال کرد." }, { status: 400 });
    }
    if (input.password && !isStrongEnoughPassword(input.password)) throw new Error("رمز جدید باید شامل حرف و عدد باشد.");
    if (input.displayName) db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(input.displayName, input.id);
    if (input.active !== undefined) db.prepare("UPDATE users SET active = ? WHERE id = ?").run(input.active ? 1 : 0, input.id);
    if (input.password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(input.password), input.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(input.id);
    }
    if (input.active === false) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(input.id);
    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "اطلاعات ویرایش معتبر نیست." }, { status: 400 });
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "ویرایش ناموفق بود." }, { status });
  }
}
