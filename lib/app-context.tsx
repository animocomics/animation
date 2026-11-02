"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createDemoExams, createDemoWorkspace, DEFAULT_WORKSPACE_SETTINGS } from "./demo";
import type { AuthUser, Exam, ProviderPublicStatus, SchoolClass, Submission, ToastMessage, WorkspaceData, WorkspaceSettings } from "./types";
import { safeJsonParse, uid } from "./utils";

const LEGACY_DATA_KEY = "nomreh:workspace:v1";
const LEGACY_SETTINGS_KEY = "nomreh:settings:v1";

type SaveState = "loading" | "saved" | "saving" | "error";

interface AppContextValue {
  user: AuthUser;
  exams: Exam[];
  classes: SchoolClass[];
  settings: WorkspaceSettings;
  providerStatus: ProviderPublicStatus;
  storageReady: boolean;
  saveState: SaveState;
  toasts: ToastMessage[];
  saveExam: (exam: Exam) => void;
  deleteExam: (examId: string) => void;
  saveClass: (schoolClass: SchoolClass) => void;
  deleteClass: (classId: string) => void;
  updateSubmission: (examId: string, submissionId: string, update: Partial<Submission>) => void;
  saveSettings: (settings: WorkspaceSettings) => void;
  syncWorkspace: (data?: WorkspaceData) => Promise<void>;
  refreshProviderStatus: () => Promise<void>;
  notify: (toast: Omit<ToastMessage, "id">) => void;
  dismissToast: (id: string) => void;
  resetDemo: () => void;
  clearWorkspace: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function deriveExamStatus(exam: Exam): Exam["status"] {
  if (!exam.submissions.length) return exam.status === "completed" ? "ready" : exam.status;
  if (exam.submissions.some((submission) => submission.status === "processing")) return "grading";
  if (exam.submissions.every((submission) => submission.status === "approved")) return "completed";
  if (exam.submissions.some((submission) => submission.status === "needs_review" || submission.status === "graded")) return "review";
  return "ready";
}

function migrateLegacyWorkspace(): WorkspaceData | null {
  const exams = safeJsonParse<Exam[] | null>(localStorage.getItem(LEGACY_DATA_KEY), null);
  if (!exams) return null;
  const storedSettings = safeJsonParse<WorkspaceSettings | null>(localStorage.getItem(LEGACY_SETTINGS_KEY), null);
  const classes: SchoolClass[] = [];
  const now = new Date().toISOString();
  const migratedExams = exams.map((exam) => {
    let schoolClass = classes.find((item) => item.name === exam.className);
    if (!schoolClass) {
      schoolClass = { id: uid("class"), name: exam.className || "کلاس بدون عنوان", grade: "", subject: exam.subject, academicYear: "۱۴۰۵–۱۴۰۶", students: [], createdAt: now, updatedAt: now };
      classes.push(schoolClass);
    }
    for (const submission of exam.submissions) {
      if (submission.studentName && !schoolClass.students.some((student) => student.code === submission.studentCode && student.name === submission.studentName)) {
        schoolClass.students.push({ id: submission.studentId || uid("student"), name: submission.studentName, code: submission.studentCode, active: true });
      }
    }
    return { ...exam, classId: schoolClass.id };
  });
  return { exams: migratedExams, classes, settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...storedSettings } };
}

export function AppProvider({ children, initialUser, initialProvider }: { children: ReactNode; initialUser: AuthUser; initialProvider: ProviderPublicStatus }) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings>({ ...DEFAULT_WORKSPACE_SETTINGS, provider: initialProvider.provider, model: initialProvider.model });
  const [providerStatus, setProviderStatus] = useState(initialProvider);
  const [storageReady, setStorageReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const loaded = useRef(false);
  const revision = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const conflictNotified = useRef(false);
  const latestData = useRef<WorkspaceData | null>(null);
  latestData.current = { exams, classes, settings: { ...settings, provider: providerStatus.provider, model: providerStatus.model } };

  const notify = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = uid("toast");
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 5000);
  }, []);

  const persist = useCallback((data: WorkspaceData, expectedRevision?: number) => {
    if (initialUser.role === "admin") return saveChain.current;
    saveChain.current = saveChain.current.then(async () => {
      setSaveState("saving");
      try {
        const response = await fetch("/api/workspace", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data, expectedRevision: expectedRevision ?? revision.current }),
        });
        const payload = await response.json() as { revision?: number; error?: string };
        if (!response.ok) {
          if (response.status === 401) window.location.assign("/login");
          throw new Error(payload.error || "ذخیرهٔ فضای کاری ناموفق بود.");
        }
        revision.current = payload.revision ?? revision.current;
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        if (!conflictNotified.current) {
          conflictNotified.current = true;
          notify({ title: "ذخیرهٔ خودکار نیازمند توجه است", description: error instanceof Error ? error.message : "اتصال را بررسی کنید.", variant: "error" });
        }
      }
    });
    return saveChain.current;
  }, [initialUser.role, notify]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (initialUser.role === "admin") {
        loaded.current = false;
        setStorageReady(true);
        setSaveState("saved");
        return;
      }
      try {
        const response = await fetch("/api/workspace", { cache: "no-store" });
        if (response.status === 401) { window.location.assign("/login"); return; }
        const payload = await response.json() as { data: WorkspaceData | null; revision: number; error?: string };
        if (!response.ok) throw new Error(payload.error || "خواندن فضای کاری ناموفق بود.");
        if (cancelled) return;
        revision.current = payload.revision;
        let data = payload.data;
        let shouldPersist = false;
        if (!data) {
          data = migrateLegacyWorkspace() || createDemoWorkspace();
          shouldPersist = true;
          localStorage.removeItem(LEGACY_DATA_KEY);
          localStorage.removeItem(LEGACY_SETTINGS_KEY);
          sessionStorage.removeItem("nomreh:provider-key");
        }
        setExams(data.exams);
        setClasses(data.classes || []);
        setSettings({ ...DEFAULT_WORKSPACE_SETTINGS, ...data.settings, provider: initialProvider.provider, model: initialProvider.model });
        loaded.current = true;
        setStorageReady(true);
        setSaveState("saved");
        if (shouldPersist) await persist(data, 0);
      } catch (error) {
        if (!cancelled) {
          setSaveState("error");
          notify({ title: "فضای کاری بارگذاری نشد", description: error instanceof Error ? error.message : "صفحه را تازه‌سازی کنید.", variant: "error" });
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [initialProvider.model, initialProvider.provider, initialUser.role, notify, persist]);

  useEffect(() => {
    if (!loaded.current) return;
    const timer = window.setTimeout(() => {
      void persist({ exams, classes, settings: { ...settings, provider: providerStatus.provider, model: providerStatus.model } });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [exams, classes, settings, providerStatus.provider, providerStatus.model, persist]);

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const saveExam = useCallback((exam: Exam) => {
    setExams((current) => {
      const exists = current.some((item) => item.id === exam.id);
      const nextExam = { ...exam, updatedAt: new Date().toISOString(), status: deriveExamStatus(exam) };
      return exists ? current.map((item) => (item.id === exam.id ? nextExam : item)) : [nextExam, ...current];
    });
  }, []);
  const deleteExam = useCallback((examId: string) => setExams((current) => current.filter((exam) => exam.id !== examId)), []);
  const saveClass = useCallback((schoolClass: SchoolClass) => {
    const next = { ...schoolClass, updatedAt: new Date().toISOString() };
    setClasses((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]);
  }, []);
  const deleteClass = useCallback((classId: string) => setClasses((current) => current.filter((item) => item.id !== classId)), []);
  const updateSubmission = useCallback((examId: string, submissionId: string, update: Partial<Submission>) => {
    setExams((current) => current.map((exam) => {
      if (exam.id !== examId) return exam;
      const nextExam = { ...exam, updatedAt: new Date().toISOString(), submissions: exam.submissions.map((submission) => submission.id === submissionId ? { ...submission, ...update } : submission) };
      return { ...nextExam, status: deriveExamStatus(nextExam) };
    }));
  }, []);
  const saveSettings = useCallback((nextSettings: WorkspaceSettings) => setSettings({ ...nextSettings, provider: providerStatus.provider, model: providerStatus.model }), [providerStatus.model, providerStatus.provider]);
  const syncWorkspace = useCallback(async (data?: WorkspaceData) => {
    const payload = data ?? latestData.current;
    if (payload) await persist(payload);
  }, [persist]);
  const refreshProviderStatus = useCallback(async () => {
    const response = await fetch("/api/provider", { cache: "no-store" });
    const payload = await response.json() as { status?: ProviderPublicStatus; error?: string };
    if (!response.ok || !payload.status) throw new Error(payload.error || "وضعیت اتصال خوانده نشد.");
    setProviderStatus(payload.status);
    setSettings((current) => ({ ...current, provider: payload.status!.provider, model: payload.status!.model }));
  }, []);
  const resetDemo = useCallback(() => {
    const demo = createDemoWorkspace();
    setExams(demo.exams);
    setClasses(demo.classes);
    setSettings({ ...demo.settings, provider: providerStatus.provider, model: providerStatus.model });
    notify({ title: "داده‌های نمایشی بازیابی شد", description: "کلاس‌ها، آزمون‌ها و نتایج نمونه دوباره ساخته شدند.", variant: "success" });
  }, [notify, providerStatus.model, providerStatus.provider]);
  const clearWorkspace = useCallback(() => {
    setExams([]);
    setClasses([]);
    notify({ title: "فضای کاری پاک شد", description: "آزمون‌ها، کلاس‌ها و نتایج این حساب حذف شدند.", variant: "success" });
  }, [notify]);

  const value = useMemo<AppContextValue>(() => ({
    user: initialUser, exams, classes, settings, providerStatus, storageReady, saveState, toasts,
    saveExam, deleteExam, saveClass, deleteClass, updateSubmission, saveSettings, syncWorkspace, refreshProviderStatus,
    notify, dismissToast, resetDemo, clearWorkspace,
  }), [initialUser, exams, classes, settings, providerStatus, storageReady, saveState, toasts, saveExam, deleteExam, saveClass, deleteClass, updateSubmission, saveSettings, syncWorkspace, refreshProviderStatus, notify, dismissToast, resetDemo, clearWorkspace]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
