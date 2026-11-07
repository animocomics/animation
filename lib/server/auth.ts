import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { verifyPassword } from "./password";
import { sessionCookieOptions } from "./session-cookie";
import type { AuthUser, UserRole } from "@/lib/types";

export const SESSION_COOKIE = "nomreh_session";
const SESSION_DAYS = 7;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  active: number;
  created_at: string;
  last_login_at: string | null;
}

interface SessionRow extends UserRow {
  session_id: string;
  expires_at: string;
  last_seen_at: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message = "برای ادامه وارد حساب شوید.", status = 401) {
    super(message);
    this.status = status;
  }
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || undefined,
  };
}

export async function authenticate(username: string, password: string): Promise<AuthUser | null> {
  const db = (await import("./db")).getDb();
  const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.trim()) as UserRow | undefined;
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, row.id);
  return toAuthUser({ ...row, last_login_at: now });
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const values = [randomBytes(16).toString("hex"), createHash("sha256").update(token).digest("hex"), userId, expires.toISOString(), now.toISOString(), now.toISOString()];
  (await import("./db")).getDb().prepare(`INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(...values);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions(expires));
  return token;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const hash = createHash("sha256").update(token).digest("hex");
    (await import("./db")).getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const sql = `SELECT u.*, s.id AS session_id, s.expires_at, s.last_seen_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`;
  const row = (await import("./db")).getDb().prepare(sql).get(tokenHash, now) as SessionRow | undefined;
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
    (await import("./db")).getDb().prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.session_id);
  }
  return toAuthUser(row);
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError();
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new AuthError("این بخش فقط برای مدیر سامانه است.", 403);
  return user;
}

/** Teacher and reviewer content is never exposed to management accounts. */
export async function requireWorkspaceUser(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role === "admin") {
    throw new AuthError("حساب مدیریت فقط به کاربران، مصرف و تنظیمات اتصال دسترسی دارد.", 403);
  }
  return user;
}
