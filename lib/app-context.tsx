"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createDemoExams, DEFAULT_WORKSPACE_SETTINGS } from "./demo";
import type { Exam, Submission, ToastMessage, WorkspaceSettings } from "./types";
import { safeJsonParse, uid } from "./utils";

const DATA_KEY = "nomreh:workspace:v1";
const SETTINGS_KEY = "nomreh:settings:v1";
const API_KEY_SESSION_KEY = "nomreh:provider-key";

interface AppContextValue {
  exams: Exam[];
  settings: WorkspaceSettings;
  apiKey: string;
  storageReady: boolean;
  toasts: ToastMessage[];
  saveExam: (exam: Exam) => void;
  deleteExam: (examId: string) => void;
  updateSubmission: (examId: string, submissionId: string, update: Partial<Submission>) => void;
  saveSettings: (settings: WorkspaceSettings) => void;
  setApiKey: (key: string) => void;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [exams, setExams] = useState<Exam[]>(createDemoExams);
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_WORKSPACE_SETTINGS);
  const [apiKey, setApiKeyState] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const hasLoaded = useRef(false);

  useEffect(() => {
    const storedExams = safeJsonParse<Exam[] | null>(localStorage.getItem(DATA_KEY), null);
    const storedSettings = safeJsonParse<WorkspaceSettings | null>(localStorage.getItem(SETTINGS_KEY), null);
    if (storedExams !== null) setExams(storedExams);
    if (storedSettings) setSettings({ ...DEFAULT_WORKSPACE_SETTINGS, ...storedSettings });
    setApiKeyState(sessionStorage.getItem(API_KEY_SESSION_KEY) ?? "");
    hasLoaded.current = true;
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!hasLoaded.current) return;
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(exams));
    } catch {
      // File blobs are kept in IndexedDB; a full localStorage should not block grading.
    }
  }, [exams]);

  useEffect(() => {
    if (!hasLoaded.current) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = uid("toast");
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => dismissToast(id), 5000);
  }, [dismissToast]);

  const saveExam = useCallback((exam: Exam) => {
    setExams((current) => {
      const exists = current.some((item) => item.id === exam.id);
      const nextExam = { ...exam, updatedAt: new Date().toISOString(), status: deriveExamStatus(exam) };
      return exists
        ? current.map((item) => (item.id === exam.id ? nextExam : item))
        : [nextExam, ...current];
    });
  }, []);

  const deleteExam = useCallback((examId: string) => {
    setExams((current) => current.filter((exam) => exam.id !== examId));
  }, []);

  const updateSubmission = useCallback((examId: string, submissionId: string, update: Partial<Submission>) => {
    setExams((current) => current.map((exam) => {
      if (exam.id !== examId) return exam;
      const nextExam = {
        ...exam,
        updatedAt: new Date().toISOString(),
        submissions: exam.submissions.map((submission) =>
          submission.id === submissionId ? { ...submission, ...update } : submission,
        ),
      };
      return { ...nextExam, status: deriveExamStatus(nextExam) };
    }));
  }, []);

  const saveSettings = useCallback((nextSettings: WorkspaceSettings) => {
    setSettings(nextSettings);
  }, []);

  const setApiKey = useCallback((key: string) => {
    const trimmed = key.trim();
    setApiKeyState(trimmed);
    if (trimmed) sessionStorage.setItem(API_KEY_SESSION_KEY, trimmed);
    else sessionStorage.removeItem(API_KEY_SESSION_KEY);
  }, []);

  const resetDemo = useCallback(() => {
    setExams(createDemoExams());
    setSettings(DEFAULT_WORKSPACE_SETTINGS);
    notify({ title: "داده‌های نمایشی بازیابی شد", description: "آزمون‌ها و نتایج نمونه دوباره ساخته شدند.", variant: "success" });
  }, [notify]);

  const clearWorkspace = useCallback(() => {
    setExams([]);
    setApiKeyState("");
    sessionStorage.removeItem(API_KEY_SESSION_KEY);
    notify({ title: "فضای کاری پاک شد", description: "آزمون‌ها، نتایج و کلید این نشست حذف شدند.", variant: "success" });
  }, [notify]);

  const value = useMemo<AppContextValue>(() => ({
    exams,
    settings,
    apiKey,
    storageReady,
    toasts,
    saveExam,
    deleteExam,
    updateSubmission,
    saveSettings,
    setApiKey,
    notify,
    dismissToast,
    resetDemo,
    clearWorkspace,
  }), [exams, settings, apiKey, storageReady, toasts, saveExam, deleteExam, updateSubmission, saveSettings, setApiKey, notify, dismissToast, resetDemo, clearWorkspace]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
