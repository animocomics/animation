"use client";

import { type FormEvent, useState } from "react";
import { ArrowLeft, Check, CheckCheck, Eye, EyeOff, FileCheck2, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles, UserRound, UsersRound } from "lucide-react";

export function LoginForm({ showDemoAccounts }: { showDemoAccounts: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!username.trim() || !password) { setError("نام کاربری و رمز عبور را وارد کنید."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "ورود ناموفق بود.");
      window.location.assign("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ورود ناموفق بود.");
      setBusy(false);
    }
  }

  function fillAccount(role: "admin" | "teacher") {
    setUsername(role);
    setPassword(role === "admin" ? "Admin@1405" : "Teacher@1405");
    setError("");
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="معرفی نمره">
        <div className="login-story-glow" />
        <div className="login-brand"><span className="brand-mark"><CheckCheck size={27} /></span><span className="brand-name">نمره<span className="brand-dot">.</span></span></div>
        <div className="login-story-content">
          <span className="login-eyebrow"><Sparkles size={15} /> تصحیح منصف، از برگه تا کارنامه</span>
          <h1>هر پاسخ، با شاهد.<br /><em>هر نمره، با اطمینان.</em></h1>
          <p>فضای شخصی شما برای ساخت بارم، تصحیح چندوجهی و مدیریت نتایج همهٔ کلاس‌ها؛ با کنترل نهایی همیشه در دست معلم.</p>
          <div className="login-benefits">
            <div><span><FileCheck2 size={20} /></span><p><strong>تصحیح با مدرک</strong><small>رونوشت، شاهد تصویر و دلیل نمره برای هر سؤال</small></p></div>
            <div><span><UsersRound size={20} /></span><p><strong>کارنامهٔ خودکار کلاس</strong><small>تطبیق هویت و تجمیع نتایج، با هشدار برای موارد مبهم</small></p></div>
            <div><span><ShieldCheck size={20} /></span><p><strong>حریم خصوصی واقعی</strong><small>حساب جدا برای هر معلم و کلید API محفوظ نزد مدیر</small></p></div>
          </div>
        </div>
        <div className="login-story-foot"><span className="status-dot" /> هوش مصنوعی پیشنهاد می‌دهد؛ معلم تصمیم می‌گیرد.</div>
      </section>

      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="login-mobile-brand"><span className="brand-mark"><CheckCheck size={24} /></span><span className="brand-name">نمره<span className="brand-dot">.</span></span></div>
          <span className="login-lock"><LockKeyhole size={23} /></span>
          <h2>به فضای کاری خود وارد شوید</h2>
          <p className="login-subtitle">برای ورود، نام کاربری و رمز حساب خود را وارد کنید؛ حساب معلم‌ها را مدیر سامانه می‌سازد.</p>
          <form onSubmit={submit} className="login-form">
            <div className="form-field">
              <label htmlFor="login-username">نام کاربری</label>
              <div className="input-with-icon"><UserRound size={18} /><input id="login-username" className="input" dir="ltr" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" disabled={busy} /></div>
            </div>
            <div className="form-field">
              <label htmlFor="login-password">رمز عبور</label>
              <div className="input-with-icon input-with-action"><LockKeyhole size={18} /><input id="login-password" className="input" dir="ltr" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••••" disabled={busy} /><button type="button" className="input-action" aria-label={showPassword ? "پنهان‌کردن رمز" : "نمایش رمز"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
            </div>
            {error && <div className="login-error" role="alert">{error}</div>}
            <button className="btn btn-primary btn-lg login-submit" disabled={busy}>{busy ? <LoaderCircle className="spin-icon" size={18} /> : <ArrowLeft size={18} />}{busy ? "در حال ورود…" : "ورود به نمره"}</button>
          </form>

          {showDemoAccounts && <div className="demo-accounts">
            <div className="demo-accounts-heading"><span>دسترسی اولیهٔ نصب</span><i /></div>
            <p>برای شروع، یکی از حساب‌های اولیه را انتخاب کنید:</p>
            <div className="demo-account-grid">
              <button onClick={() => fillAccount("teacher")}><span><UserRound size={17} /></span><strong>معلم نمونه</strong><small dir="ltr">teacher</small><Check size={14} /></button>
              <button onClick={() => fillAccount("admin")}><span><ShieldCheck size={17} /></span><strong>مدیر سامانه</strong><small dir="ltr">admin</small><Check size={14} /></button>
            </div>
            <small className="demo-security-note">رمزهای اولیه پیش از استقرار واقعی باید با متغیرهای محیطی تغییر کنند.</small>
          </div>}
          <div className="login-privacy"><ShieldCheck size={15} /><span>نشست شما با کوکی HttpOnly و رمزنگاری رمز عبور محافظت می‌شود.</span></div>
        </div>
      </section>
    </main>
  );
}
