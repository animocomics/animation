"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, BrainCircuit, CheckCircle2, CircleUserRound, Clock3, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, ToggleLeft, ToggleRight, TriangleAlert, UserPlus, UserRoundCog, UsersRound, X, Zap } from "lucide-react";
import { ApiConnection } from "./api-connection";
import { OfficialShecanConsole } from "./official-shecan-console";
import { useApp } from "@/lib/app-context";
import type { AuthUser } from "@/lib/types";
import { faDate, faNumber } from "@/lib/utils";

interface AdminUser extends AuthUser { jobCount: number; tokenCount: number; workspaceUpdatedAt?: string }
interface UsageData {
  summary: { jobs: number; input_tokens: number; output_tokens: number; failures: number; average_latency: number };
  recent: Array<{ id: string; provider: string; model: string; status: string; input_tokens: number; output_tokens: number; latency_ms: number; error?: string; created_at: string; display_name: string; username: string }>;
  providers: Array<{ provider: string; model: string; jobs: number; input_tokens: number; output_tokens: number }>;
}

export function AdminPanel() {
  const { notify, user: currentUser } = useApp();
  const [tab, setTab] = useState<"connection" | "users" | "usage">("connection");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "teacher" });
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const openCreateUser = () => { setTab("users"); setShowPassword(false); setCreateOpen(true); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersResponse, usageResponse] = await Promise.all([fetch("/api/admin/users"), fetch("/api/admin/usage")]);
      const usersPayload = await usersResponse.json() as { users?: AdminUser[]; error?: string };
      const usagePayload = await usageResponse.json() as UsageData & { error?: string };
      if (!usersResponse.ok) throw new Error(usersPayload.error || "فهرست کاربران خوانده نشد.");
      setUsers(usersPayload.users || []);
      if (usageResponse.ok) setUsage(usagePayload);
    } catch (error) {
      notify({ title: "اطلاعات مدیریت بارگذاری نشد", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  const totals = useMemo(() => ({ teachers: users.filter((user) => user.role !== "admin").length, active: users.filter((user) => user.active && user.role !== "admin").length }), [users]);

  async function createUser(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const payload = await response.json() as { users?: AdminUser[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "ساخت حساب ناموفق بود.");
      setUsers(payload.users || []); setCreateOpen(false); setShowPassword(false); setForm({ username: "", displayName: "", password: "", role: "teacher" });
      notify({ title: form.role === "teacher" ? "حساب معلم ساخته شد" : "حساب بازبین ساخته شد", description: "اکنون می‌توانید نام کاربری و رمز را به‌صورت امن تحویل دهید.", variant: "success" });
    } catch (error) { notify({ title: "ساخت حساب ناموفق بود", description: error instanceof Error ? error.message : "اطلاعات را بررسی کنید.", variant: "error" }); }
    finally { setBusy(false); }
  }

  async function toggleUser(user: AdminUser) {
    const response = await fetch("/api/admin/users", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: user.id, active: !user.active }) });
    const payload = await response.json() as { users?: AdminUser[]; error?: string };
    if (!response.ok) { notify({ title: "تغییر وضعیت ناموفق بود", description: payload.error, variant: "error" }); return; }
    setUsers(payload.users || []);
    notify({ title: user.active ? "حساب غیرفعال شد" : "حساب فعال شد", description: user.displayName, variant: "success" });
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault(); if (!resetUser) return; setBusy(true);
    const response = await fetch("/api/admin/users", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: resetUser.id, password: newPassword }) });
    const payload = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) { notify({ title: "تغییر رمز ناموفق بود", description: payload.error, variant: "error" }); return; }
    notify({ title: "رمز عبور تغییر کرد", description: `نشست‌های قبلی ${resetUser.displayName} بسته شدند.`, variant: "success" });
    if (resetUser.id === currentUser.id) { window.location.assign("/login"); return; }
    setResetUser(null); setNewPassword("");
  }

  return <div className="admin-page">
    <section className="admin-overview">
      <div><span className="admin-shield"><ShieldCheck size={26} /></span><div><span className="eyebrow">کنترل متمرکز، دسترسی کنترل‌شده</span><h2>مدیریت سامانهٔ نمره</h2><p>کلیدها و کاربران را مدیریت کنید؛ محتوای آزمون و برگه‌های معلم‌ها در این بخش نمایش داده نمی‌شود.</p></div></div>
      <div className="admin-overview-actions"><button className="btn btn-primary" onClick={openCreateUser}><UserPlus size={17} /> ساخت حساب معلم</button><span className="admin-role-badge"><ShieldCheck size={15} /> دسترسی مدیر</span></div>
    </section>
    <div className="admin-stat-grid">
      <div><span className="stat-icon teal"><UsersRound size={20} /></span><p>معلم‌ها و بازبین‌ها<strong>{faNumber(totals.teachers)}</strong><small>{faNumber(totals.active)} حساب فعال</small></p></div>
      <div><span className="stat-icon violet"><BrainCircuit size={20} /></span><p>درخواست‌های هوش مصنوعی<strong>{faNumber(usage?.summary.jobs || 0)}</strong><small>همهٔ حساب‌ها</small></p></div>
      <div><span className="stat-icon amber"><Zap size={20} /></span><p>توکن مصرف‌شده<strong>{faNumber((usage?.summary.input_tokens || 0) + (usage?.summary.output_tokens || 0))}</strong><small>ورودی و خروجی</small></p></div>
      <div><span className="stat-icon green"><Clock3 size={20} /></span><p>میانگین زمان پاسخ<strong>{faNumber(Math.round((usage?.summary.average_latency || 0) / 1000))}<small> ثانیه</small></strong><small>{faNumber(usage?.summary.failures || 0)} اجرای ناموفق</small></p></div>
    </div>
    <div className="admin-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "connection"} className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}><KeyRound size={17} /> اتصال هوش مصنوعی</button>
      <button role="tab" aria-selected={tab === "users"} className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><UsersRound size={17} /> حساب‌های کاربران</button>
      <button role="tab" aria-selected={tab === "usage"} className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}><Activity size={17} /> مصرف و رویدادها</button>
      <button className="admin-refresh" onClick={() => void load()} aria-label="به‌روزرسانی"><RefreshCw size={16} /></button>
    </div>

    {tab === "connection" && <section className="card settings-card admin-connection-card"><div className="settings-card-heading"><span className="settings-heading-icon teal"><KeyRound size={20} /></span><div><h3>پیکربندی سراسری مدل</h3><p>تنها مدیر می‌تواند این مقادیر را ببیند یا تغییر دهد.</p></div></div><div className="settings-card-body"><ApiConnection /><div className="admin-network-divider"><span className="settings-heading-icon violet"><Zap size={19} /></span><div><h3>برنامهٔ رسمی شکن و مسیر اختصاصی AI</h3><p>اجرای واقعی برنامه، ورود در رابط خود شکن و اتصال فقط Providerها؛ بدون تغییر DNS کل هاست.</p></div></div><OfficialShecanConsole /><div className="admin-security-note"><ShieldCheck size={18} /><div><strong>مرز امنیتی نقش‌ها</strong><p>معلم فقط وضعیت «متصل / غیرفعال» را می‌بیند. نام مدل برای اجرای لازم است، اما کلید، آزمایش اتصال و صفحهٔ مدیریت هرگز در دسترس او نیست.</p></div></div></div></section>}

    {tab === "users" && <section className="card admin-users-card">
      <div className="admin-section-heading"><div><h3>حساب‌های معلم و بازبین</h3><p>هر کاربر فقط به کلاس‌ها و آزمون‌های فضای کاری خودش دسترسی دارد.</p></div><button className="btn btn-primary" onClick={openCreateUser}><UserPlus size={16} /> ساخت حساب معلم</button></div>
      {loading ? <div className="admin-loading"><LoaderCircle className="spin-icon" /> در حال خواندن کاربران…</div> : <div className="table-scroll"><table className="admin-table"><thead><tr><th>کاربر</th><th>نقش</th><th>وضعیت</th><th>آخرین ورود</th><th>مصرف</th><th>عملیات</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><div className="admin-user-cell"><span>{user.displayName.charAt(0)}</span><p><strong>{user.displayName}</strong><small dir="ltr">@{user.username}</small></p></div></td><td>{user.role === "admin" ? "مدیر سامانه" : user.role === "reviewer" ? "بازبین" : "معلم"}</td><td><span className={`status-badge ${user.active ? "success" : "neutral"}`}>{user.active ? "فعال" : "غیرفعال"}</span></td><td>{user.lastLoginAt ? faDate(user.lastLoginAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td><td><strong>{faNumber(user.jobCount)}</strong><small className="table-subline">{faNumber(user.tokenCount)} توکن</small></td><td>{user.role === "admin" ? <div className="admin-row-actions"><button className="btn btn-ghost btn-sm" onClick={() => { setResetUser(user); setNewPassword(""); }}><KeyRound size={14} /> رمز جدید</button><span className="locked-admin"><ShieldCheck size={14} /> محافظت‌شده</span></div> : <div className="admin-row-actions"><button className="btn btn-ghost btn-sm" onClick={() => { setResetUser(user); setNewPassword(""); }}><KeyRound size={14} /> رمز جدید</button><button className={`btn btn-sm ${user.active ? "btn-danger-soft" : "btn-secondary"}`} onClick={() => void toggleUser(user)}>{user.active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}{user.active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button></div>}</td></tr>)}</tbody></table></div>}
    </section>}

    {tab === "usage" && <section className="card admin-usage-card"><div className="admin-section-heading"><div><h3>رویدادهای اخیر موتور تصحیح</h3><p>فقط متادیتای فنی؛ بدون نام دانش‌آموز، تصویر برگه یا محتوای پاسخ.</p></div></div>{usage?.recent.length ? <div className="table-scroll"><table className="admin-table"><thead><tr><th>زمان / کاربر</th><th>مدل</th><th>وضعیت</th><th>توکن ورودی</th><th>توکن خروجی</th><th>مدت</th></tr></thead><tbody>{usage.recent.map((job) => <tr key={job.id}><td><strong>{faDate(job.created_at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</strong><small className="table-subline">{job.display_name}</small></td><td><span dir="ltr">{job.provider} · {job.model}</span></td><td><span className={`status-badge ${job.status === "succeeded" ? "success" : "danger"}`}>{job.status === "succeeded" ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />}{job.status === "succeeded" ? "موفق" : "ناموفق"}</span>{job.error && <small className="table-subline error-text">{job.error}</small>}</td><td>{faNumber(job.input_tokens)}</td><td>{faNumber(job.output_tokens)}</td><td>{faNumber((job.latency_ms / 1000).toFixed(1))} ثانیه</td></tr>)}</tbody></table></div> : <div className="admin-empty"><Activity size={34} /><h3>هنوز رویدادی ثبت نشده</h3><p>پس از نخستین تصحیح واقعی، مصرف هر حساب اینجا دیده می‌شود.</p></div>}</section>}

    {createOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title"><div className="modal-header"><div className="modal-heading"><span className="modal-heading-icon"><UserPlus size={21} /></span><div><h2 id="create-user-title">{form.role === "teacher" ? "ساخت حساب معلم" : "ساخت حساب بازبین"}</h2><p>دسترسی مستقل با فضای کاری کاملاً جدا</p></div></div><button className="icon-button" onClick={() => setCreateOpen(false)} aria-label="بستن"><X size={19} /></button></div><form onSubmit={createUser}><div className="modal-body form-grid"><div className="form-field full"><label htmlFor="new-display-name">نام و نام‌خانوادگی</label><input id="new-display-name" className="input" required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="مثلاً مریم احمدی" /></div><div className="form-field"><label htmlFor="new-username">نام کاربری</label><input id="new-username" className="input" dir="ltr" required autoComplete="off" spellCheck={false} pattern={"[a-z0-9._\\-]{3,40}"} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="m.ahmadi" /><span className="form-hint">فقط حروف انگلیسی کوچک، عدد، نقطه یا خط تیره؛ ۳ تا ۴۰ نویسه.</span></div><div className="form-field"><label htmlFor="new-role">نقش</label><select id="new-role" className="select" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}><option value="teacher">معلم</option><option value="reviewer">بازبین نمرات</option></select></div><div className="form-field full"><label htmlFor="new-password">رمز عبور اولیه</label><div className="input-with-icon input-with-action"><LockKeyhole size={17} /><input id="new-password" className="input" dir="ltr" type={showPassword ? "text" : "password"} required minLength={8} autoComplete="new-password" spellCheck={false} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="حداقل ۸ نویسه، شامل حرف و عدد" /><button className="input-action" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "پنهان‌کردن رمز" : "نمایش رمز"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="form-hint">رمز با scrypt و نمک تصادفی ذخیره می‌شود؛ پس از تحویل، قابل بازیابی نیست.</span></div><div className="credential-handoff-note full"><ShieldCheck size={19} /><div><strong>تحویل امن به معلم</strong><p>پس از ساخت، نام کاربری و رمز اولیه را از مسیر امن به معلم برسانید. او با همین اطلاعات وارد می‌شود و کلاس‌ها و دانش‌آموزان خودش را مدیریت می‌کند.</p></div></div></div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setCreateOpen(false)}>انصراف</button><button className="btn btn-primary" disabled={busy}>{busy ? <LoaderCircle className="spin-icon" size={16} /> : <CircleUserRound size={16} />} {form.role === "teacher" ? "ساخت حساب معلم" : "ساخت حساب بازبین"}</button></div></form></div></div>}

    {resetUser && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-password-title"><div className="modal-header"><div><h2 id="reset-password-title">تعیین رمز جدید</h2><p>{resetUser.displayName} · همهٔ نشست‌های قبلی بسته می‌شوند</p></div><button className="icon-button" onClick={() => setResetUser(null)} aria-label="بستن"><X size={19} /></button></div><form onSubmit={resetPassword}><div className="modal-body"><div className="form-field"><label htmlFor="reset-password">رمز عبور جدید</label><input id="reset-password" className="input" dir="ltr" type="password" required minLength={8} autoFocus value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><span className="form-hint">حداقل ۸ نویسه و ترکیبی از حرف و عدد.</span></div></div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setResetUser(null)}>انصراف</button><button className="btn btn-primary" disabled={busy}>{busy ? <LoaderCircle className="spin-icon" size={16} /> : <UserRoundCog size={16} />} تأیید رمز جدید</button></div></form></div></div>}
  </div>;
}
