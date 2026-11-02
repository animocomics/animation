"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { BarChart3, Bell, Check, CheckCheck, ChevronLeft, CircleHelp, ClipboardCheck, Cloud, FileStack, KeyRound, LayoutDashboard, LoaderCircle, LogOut, Menu, Plus, Settings, ShieldCheck, Sparkles, TriangleAlert, UsersRound, X } from "lucide-react";
import { useApp } from "../lib/app-context";
import { faDate, faNumber } from "../lib/utils";

const navigation = [
  { href: "/", label: "داشبورد", icon: LayoutDashboard },
  { href: "/classes", label: "کلاس‌ها و دانش‌آموزان", icon: UsersRound },
  { href: "/exams", label: "آزمون‌های من", icon: FileStack },
  { href: "/grading", label: "آزمون جدید", icon: Sparkles },
  { href: "/review", label: "بازبینی نمرات", icon: ClipboardCheck, badge: true },
  { href: "/reports", label: "گزارش و تحلیل", icon: BarChart3 },
];

const pageTitles: Array<{ match: (path: string) => boolean; title: string; subtitle: string }> = [
  { match: (path) => path === "/", title: "داشبورد", subtitle: "نمای کلی آزمون‌ها و تصحیح‌ها" },
  { match: (path) => path.startsWith("/classes"), title: "کلاس‌ها و دانش‌آموزان", subtitle: "فهرست کلاس، تطبیق هویت و کارنامهٔ تجمیعی" },
  { match: (path) => path.startsWith("/exams"), title: "آزمون‌های من", subtitle: "مدیریت سؤال‌ها، برگه‌ها و وضعیت تصحیح" },
  { match: (path) => path.startsWith("/grading"), title: "آزمون جدید", subtitle: "از ساخت بارم تا دریافت نتیجه، در چهار گام" },
  { match: (path) => path.startsWith("/review"), title: "بازبینی نمرات", subtitle: "بررسی شواهد و تأیید نهایی توسط معلم" },
  { match: (path) => path.startsWith("/reports"), title: "گزارش و تحلیل", subtitle: "عملکرد کلاس و نقاط نیازمند توجه" },
  { match: (path) => path.startsWith("/admin"), title: "مدیریت سامانه", subtitle: "کاربران، اتصال امن مدل و مصرف سرویس" },
  { match: (path) => path.startsWith("/settings"), title: "تنظیمات", subtitle: "سیاست‌های تصحیح و مدیریت فضای کاری" },
  { match: (path) => path.startsWith("/help"), title: "راهنمای نمره", subtitle: "مسیر درست برای یک تصحیح قابل اتکا" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, providerStatus, saveState, storageReady, exams, toasts, dismissToast } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const isAdmin = user.role === "admin";

  useEffect(() => { setMobileOpen(false); setNotificationsOpen(false); }, [pathname]);
  const reviewCount = useMemo(() => exams.reduce((sum, exam) => sum + exam.submissions.filter((submission) => submission.status === "needs_review").length, 0), [exams]);
  const currentPage = pageTitles.find((page) => page.match(pathname)) ?? pageTitles[0];
  const firstReviewExam = exams.find((exam) => exam.submissions.some((submission) => submission.status === "needs_review"));

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <div className="app-layout">
      {mobileOpen && <button className="sidebar-overlay" aria-label="بستن منو" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="ناوبری اصلی">
        <div className="brand-row">
          <Link href={isAdmin ? "/admin" : "/"} className="brand" aria-label="نمره، صفحهٔ اصلی"><span className="brand-mark"><CheckCheck size={25} strokeWidth={2.5} /></span><span className="brand-name">نمره</span></Link>
          <button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} aria-label="بستن منو"><X size={20} /></button>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">{user.displayName.trim().charAt(0) || "ن"}</span>
          <span><strong>{user.displayName}</strong><small>{user.role === "admin" ? "مدیر سامانه" : user.role === "reviewer" ? "بازبین نمرات" : "فضای شخصی معلم"}</small></span>
          <ShieldCheck size={16} />
        </div>
        <nav className="main-nav">
          {isAdmin ? (
            <>
              <span className="nav-caption">مدیریت سامانه</span>
              <Link href="/admin" className={`nav-item ${pathname.startsWith("/admin") ? "active" : ""}`} aria-current={pathname.startsWith("/admin") ? "page" : undefined}><ShieldCheck size={20} strokeWidth={2} /><span>کاربران، اتصال و مصرف</span></Link>
            </>
          ) : (
            <>
              <span className="nav-caption">فضای کاری</span>
              {navigation.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                const Icon = item.icon;
                return <Link key={item.href} href={item.href} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><Icon size={20} strokeWidth={active ? 2.3 : 1.8} /><span>{item.label}</span>{item.badge && reviewCount > 0 && <span className="nav-badge">{faNumber(reviewCount)}</span>}</Link>;
              })}
              <span className="nav-caption nav-caption-second">مدیریت</span>
              <Link href="/settings" className={`nav-item ${pathname.startsWith("/settings") ? "active" : ""}`}><Settings size={20} strokeWidth={1.8} /><span>تنظیمات تصحیح</span></Link>
              <Link href="/help" className={`nav-item ${pathname.startsWith("/help") ? "active" : ""}`}><CircleHelp size={20} strokeWidth={1.8} /><span>راهنما و بهترین روش</span></Link>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          {isAdmin ? <div className="sidebar-tip"><span className="tip-icon"><ShieldCheck size={18} /></span><strong>دسترسی‌ها جدا هستند</strong><p>این حساب فقط کاربران، مصرف و اتصال سرویس را مدیریت می‌کند و به کلاس‌ها و برگه‌ها دسترسی ندارد.</p></div> : <div className="sidebar-tip"><span className="tip-icon"><Sparkles size={18} /></span><strong>تصحیح دقیق‌تر می‌خواهید؟</strong><p>برای هر سؤال، معیارهای بارم را جدا و کوتاه بنویسید.</p><Link href="/help">راهنمای بارم‌نویسی <ChevronLeft size={14} /></Link></div>}
          <div className="privacy-note">{saveState === "saving" || saveState === "loading" ? <LoaderCircle size={12} className="spin-icon" /> : <Cloud size={12} />}<span>{saveState === "error" ? "ذخیرهٔ سرور نیازمند بررسی" : saveState === "saving" ? "در حال ذخیرهٔ امن…" : isAdmin ? "مدیریت امن سامانه" : "ذخیره‌شده در فضای امن شما"}</span></div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-title"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="باز کردن منو"><Menu size={22} /></button><div><h1>{currentPage.title}</h1><p>{currentPage.subtitle}</p></div></div>
          <div className="topbar-actions">
            <span className="topbar-date">{faDate(new Date(), { weekday: "long", day: "numeric", month: "long" })}</span>
            <Link href={user.role === "admin" ? "/admin" : "/settings"} className={`connection-pill ${providerStatus.configured ? "connected" : ""}`} title={user.role === "admin" ? "مدیریت اتصال مدل" : "وضعیت سرویس تصحیح"}><KeyRound size={15} /><span>{providerStatus.configured ? "سرویس متصل است" : "سرویس غیرفعال"}</span><span className="connection-dot" /></Link>
            {!isAdmin && <div className="notification-wrap">
              <button className="icon-button notification-button" aria-label={`اعلان‌ها، ${reviewCount} مورد`} onClick={() => setNotificationsOpen((open) => !open)}><Bell size={20} />{reviewCount > 0 && <span className="notification-dot" />}</button>
              {notificationsOpen && <div className="notification-popover card-popover"><div className="popover-heading"><strong>اعلان‌ها</strong><span>{faNumber(reviewCount)} مورد</span></div>{reviewCount ? <Link href={`/review?exam=${firstReviewExam?.id ?? ""}`} className="notification-item"><span className="notification-icon warning"><TriangleAlert size={18} /></span><span><strong>برگه‌هایی منتظر نظر شما هستند</strong><small>{faNumber(reviewCount)} برگه با هشدار ناخوانایی یا نمرهٔ مرزی</small></span></Link> : <div className="notification-empty"><Check size={20} /><p>همه‌چیز مرتب است؛ موردی برای بازبینی ندارید.</p></div>}</div>}
            </div>}
            <div className="topbar-user"><span className="user-avatar" title={user.displayName}>{user.displayName.trim().charAt(0) || "م"}</span><button className="icon-button logout-button" onClick={logout} aria-label="خروج از حساب" title="خروج از حساب"><LogOut size={18} /></button></div>
          </div>
        </header>
        <main className="page-content">{storageReady ? children : <div className="workspace-loading"><span className="brand-mark"><CheckCheck size={25} /></span><strong>{isAdmin ? "مدیریت سامانه آماده می‌شود" : "فضای کاری امن شما آماده می‌شود"}</strong><LoaderCircle className="spin-icon" size={21} /><p>{isAdmin ? "در حال خواندن وضعیت سرویس و حساب‌ها…" : "در حال خواندن کلاس‌ها، آزمون‌ها و نتایج…"}</p></div>}</main>
      </div>

      {!isAdmin && <Link href="/grading" className="floating-create" title="آزمون جدید"><Plus size={22} /><span>آزمون جدید</span></Link>}
      <div className="toast-viewport" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.variant}`}><span className="toast-icon">{toast.variant === "success" ? <Check size={18} /> : toast.variant === "error" ? <TriangleAlert size={18} /> : <Sparkles size={18} />}</span><div><strong>{toast.title}</strong>{toast.description && <p>{toast.description}</p>}</div><button onClick={() => dismissToast(toast.id)} aria-label="بستن پیام"><X size={16} /></button></div>)}</div>
    </div>
  );
}
