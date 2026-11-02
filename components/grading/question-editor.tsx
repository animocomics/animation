"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  CircleAlert,
  Copy,
  GripVertical,
  ListPlus,
  Plus,
  Scale,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { QUESTION_TYPE_LABELS, type Question, type QuestionType } from "../../lib/types";
import { faNumber, rubricScore, uid } from "../../lib/utils";
import { NumberInput } from "../ui/number-input";

function renumber(questions: Question[]): Question[] {
  return questions.map((question, index) => ({ ...question, number: index + 1 }));
}

export function makeQuestion(type: QuestionType = "short_answer", number = 1): Question {
  return {
    id: uid("question"),
    number,
    type,
    prompt: "",
    maxScore: type === "essay" || type === "math" ? 4 : 2,
    answer: "",
    options: ["multiple_choice", "multiple_response"].includes(type) ? ["", "", "", ""] : [],
    acceptedAnswers: [],
    partialCredit: !["multiple_choice", "true_false", "fill_blank"].includes(type),
    errorCarriedForward: type === "math",
    rubric: [{ id: uid("rubric"), label: "", description: "", points: type === "essay" || type === "math" ? 4 : 2 }],
  };
}

export function QuestionEditor({ questions, onChange }: { questions: Question[]; onChange: (questions: Question[]) => void }) {
  const [activeId, setActiveId] = useState(questions[0]?.id ?? "");
  const active = questions.find((question) => question.id === activeId) ?? questions[0];
  const total = useMemo(() => questions.reduce((sum, question) => sum + question.maxScore, 0), [questions]);

  const update = (patch: Partial<Question>) => {
    if (!active) return;
    onChange(questions.map((question) => question.id === active.id ? { ...question, ...patch } : question));
  };

  const addQuestion = () => {
    const question = makeQuestion("short_answer", questions.length + 1);
    onChange([...questions, question]);
    setActiveId(question.id);
  };

  const deleteQuestion = (id: string) => {
    if (questions.length === 1) return;
    const next = renumber(questions.filter((question) => question.id !== id));
    onChange(next);
    if (activeId === id) setActiveId(next[0].id);
  };

  const duplicateQuestion = () => {
    if (!active) return;
    const copy = { ...active, id: uid("question"), rubric: active.rubric.map((criterion) => ({ ...criterion, id: uid("rubric") })), prompt: `${active.prompt} (کپی)` };
    const index = questions.findIndex((question) => question.id === active.id);
    const next = [...questions];
    next.splice(index + 1, 0, copy);
    onChange(renumber(next));
    setActiveId(copy.id);
  };

  const move = (direction: -1 | 1) => {
    if (!active) return;
    const index = questions.findIndex((question) => question.id === active.id);
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(renumber(next));
  };

  const changeType = (type: QuestionType) => {
    if (!active) return;
    const withOptions = ["multiple_choice", "multiple_response"].includes(type);
    update({
      type,
      options: withOptions ? (active.options.length >= 2 ? active.options : ["", "", "", ""]) : [],
      answer: "",
      partialCredit: !["multiple_choice", "true_false", "fill_blank"].includes(type),
      errorCarriedForward: type === "math",
    });
  };

  const updateOption = (index: number, value: string) => {
    if (!active) return;
    const previous = active.options[index];
    const options = active.options.map((option, optionIndex) => optionIndex === index ? value : option);
    let answer = active.answer;
    if (active.type === "multiple_choice" && normalizeSelection(previous) === normalizeSelection(active.answer)) answer = value;
    if (active.type === "multiple_response") {
      const selected = active.answer.split(/[,،]+/).filter((item) => item.trim() && normalizeSelection(item) !== normalizeSelection(previous));
      answer = [...selected, ...(active.answer.split(/[,،]+/).some((item) => normalizeSelection(item) === normalizeSelection(previous)) ? [value] : [])].join("، ");
    }
    update({ options, answer });
  };

  const toggleCorrectOption = (option: string) => {
    if (!active) return;
    if (active.type === "multiple_choice") update({ answer: option });
    else {
      const selected = active.answer.split(/[,،]+/).map((item) => item.trim()).filter(Boolean);
      const exists = selected.some((item) => normalizeSelection(item) === normalizeSelection(option));
      update({ answer: exists ? selected.filter((item) => normalizeSelection(item) !== normalizeSelection(option)).join("، ") : [...selected, option].join("، ") });
    }
  };

  const autoBalanceRubric = () => {
    if (!active) return;
    if (!active.rubric.length) {
      update({ rubric: [{ id: uid("rubric"), label: "", description: "", points: active.maxScore }] });
      return;
    }
    const current = rubricScore(active);
    const ratio = current > 0 ? active.maxScore / current : 1 / active.rubric.length;
    const rubric = active.rubric.map((criterion) => ({ ...criterion, points: Math.round(criterion.points * ratio * 4) / 4 }));
    const sum = rubric.reduce((totalPoints, criterion) => totalPoints + criterion.points, 0);
    rubric[rubric.length - 1].points = Math.round((rubric[rubric.length - 1].points + active.maxScore - sum) * 100) / 100;
    update({ rubric });
  };

  if (!active) return null;
  const currentRubricScore = rubricScore(active);
  const rubricMismatch = Math.abs(currentRubricScore - active.maxScore) > 0.001;
  const hasOptions = ["multiple_choice", "multiple_response"].includes(active.type);

  return (
    <div className="question-builder">
      <aside className="question-list-panel">
        <div className="question-list-head"><span>سؤال‌ها</span><span>{faNumber(questions.length)} سؤال · {faNumber(total)} نمره</span></div>
        <div className="question-list-scroll">
          {questions.map((question) => (
            <button key={question.id} className={`question-list-item ${active.id === question.id ? "active" : ""}`} onClick={() => setActiveId(question.id)}>
              <GripVertical size={14} className="question-grip" />
              <span className="question-list-number">{faNumber(question.number)}</span>
              <span><strong>{question.prompt || "سؤال بدون عنوان"}</strong><small>{QUESTION_TYPE_LABELS[question.type]} · {faNumber(question.maxScore)} نمره</small></span>
              <ChevronLeft size={14} />
            </button>
          ))}
        </div>
        <button className="btn btn-soft add-question-button" onClick={addQuestion}><Plus size={16} /> افزودن سؤال جدید</button>
      </aside>

      <div className="question-editor-panel">
        <div className="question-editor-topbar">
          <div><span>سؤال {faNumber(active.number)}</span><small>تغییرات به‌صورت خودکار در پیش‌نویس ذخیره می‌شود</small></div>
          <div className="question-editor-actions">
            <button className="icon-button btn-icon-small" onClick={() => move(1)} disabled={active.number === 1} title="انتقال به قبل"><ArrowUp size={15} /></button>
            <button className="icon-button btn-icon-small" onClick={() => move(-1)} disabled={active.number === questions.length} title="انتقال به بعد"><ArrowDown size={15} /></button>
            <button className="icon-button btn-icon-small" onClick={duplicateQuestion} title="کپی سؤال"><Copy size={15} /></button>
            <button className="icon-button btn-icon-small danger-hover" onClick={() => deleteQuestion(active.id)} disabled={questions.length === 1} title="حذف سؤال"><Trash2 size={15} /></button>
          </div>
        </div>
        <div className="question-editor-fields">
          <div className="form-grid question-basic-grid">
            <div className="form-field"><label htmlFor={`question-type-${active.id}`}>نوع سؤال</label><select id={`question-type-${active.id}`} className="select" value={active.type} onChange={(event) => changeType(event.target.value as QuestionType)}>{Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div className="form-field"><label htmlFor={`question-score-${active.id}`}>نمرهٔ سؤال <span>*</span></label><NumberInput id={`question-score-${active.id}`} className="input" min={0.25} step={0.25} value={active.maxScore} onValueChange={(maxScore) => update({ maxScore })} /><span className="form-hint">نمرهٔ کامل این سؤال؛ برای بخش‌بندی، معیارهای مستقل در پایین تعریف کنید.</span></div>
          </div>
          <div className="form-field"><label htmlFor={`question-prompt-${active.id}`}>صورت سؤال <span>*</span></label><textarea id={`question-prompt-${active.id}`} className="textarea question-prompt-input" value={active.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="صورت کامل سؤال را همان‌طور که در برگه آمده بنویسید…" /></div>

          {hasOptions && <div className="options-editor">
            <div className="options-editor-head"><div><span className="field-label">گزینه‌ها و کلید</span><small>{active.type === "multiple_choice" ? "گزینهٔ صحیح را انتخاب کنید." : "همهٔ گزینه‌های صحیح را انتخاب کنید."}</small></div><button className="btn btn-ghost btn-sm" onClick={() => update({ options: [...active.options, ""] })}><ListPlus size={15} />افزودن گزینه</button></div>
            <div className="option-rows">{active.options.map((option, index) => {
              const selected = active.type === "multiple_choice"
                ? normalizeSelection(active.answer) === normalizeSelection(option) && option.trim()
                : active.answer.split(/[,،]+/).some((item) => normalizeSelection(item) === normalizeSelection(option)) && option.trim();
              return <div className={`option-row ${selected ? "correct" : ""}`} key={index}>
                <button className="option-selector" onClick={() => toggleCorrectOption(option)} disabled={!option.trim()} aria-label={selected ? "پاسخ صحیح" : "علامت‌گذاری به‌عنوان صحیح"}>{selected ? <Check size={13} /> : <span />}</button>
                <span className="option-letter">{["الف", "ب", "ج", "د", "ه", "و"][index] ?? faNumber(index + 1)}</span>
                <input className="input" aria-label={`گزینهٔ ${index + 1}`} value={option} onChange={(event) => updateOption(index, event.target.value)} placeholder={`گزینهٔ ${faNumber(index + 1)}`} />
                <button className="icon-button btn-icon-small danger-hover" onClick={() => update({ options: active.options.filter((_, optionIndex) => optionIndex !== index), answer: active.type === "multiple_choice" && selected ? "" : active.answer })} disabled={active.options.length <= 2} aria-label="حذف گزینه"><Trash2 size={14} /></button>
              </div>;
            })}</div>
          </div>}

          {active.type === "true_false" ? <div className="form-field"><label htmlFor={`question-answer-${active.id}`}>پاسخ صحیح</label><select id={`question-answer-${active.id}`} className="select" value={active.answer} onChange={(event) => update({ answer: event.target.value })}><option value="">انتخاب کنید</option><option value="درست">درست</option><option value="غلط">غلط</option></select></div>
            : !hasOptions && <div className="form-field"><label htmlFor={`question-answer-${active.id}`}>پاسخ مرجع / کلید <span>*</span></label><span className="form-hint">پاسخ صحیح، گام‌ها و نکات علمی مورد انتظار را اینجا بنویسید؛ این متن مبنای مقایسه با برگه است.</span><textarea id={`question-answer-${active.id}`} className="textarea answer-input" value={active.answer} onChange={(event) => update({ answer: event.target.value })} /></div>}

          {!hasOptions && active.type !== "true_false" && <div className="form-field"><label htmlFor={`question-alternatives-${active.id}`}>پاسخ‌های جایگزین مجاز <span className="optional-label">اختیاری</span></label><input id={`question-alternatives-${active.id}`} className="input" value={active.acceptedAnswers.join("، ")} onChange={(event) => update({ acceptedAnswers: event.target.value.split(/[،\n]+/).map((item) => item.trim()).filter(Boolean) })} placeholder="هر پاسخ مجاز را با «،» جدا کنید" /><span className="form-hint">برای تشریحی می‌توانید روش‌ها یا مثال‌های صحیح دیگر را توضیح دهید.</span></div>}

          <div className="rubric-editor">
            <div className="rubric-editor-head"><div><span className="field-label">معیارهای نمره‌دهی</span><small>هر بخش مستقل نمره می‌گیرد؛ مثلاً معیار «فرمول» می‌تواند ۰٫۵ نمره داشته باشد.</small></div><button className="btn btn-ghost btn-sm" onClick={() => update({ rubric: [...active.rubric, { id: uid("rubric"), label: "", description: "", points: 0 }] })}><Plus size={15} />افزودن معیار</button></div>
            <div className="rubric-rows">{active.rubric.map((criterion, index) => <div className="rubric-row" key={criterion.id}>
              <span className="rubric-row-index">{faNumber(index + 1)}</span>
              <div className="rubric-row-fields"><div className="rubric-field"><label htmlFor={`rubric-label-${criterion.id}`}>عنوان معیار</label><input id={`rubric-label-${criterion.id}`} className="input" value={criterion.label} onChange={(event) => update({ rubric: active.rubric.map((item) => item.id === criterion.id ? { ...item, label: event.target.value } : item) })} /></div><div className="rubric-field"><label htmlFor={`rubric-description-${criterion.id}`}>شرح معیار و شرط کسب نمره</label><input id={`rubric-description-${criterion.id}`} className="input" value={criterion.description} onChange={(event) => update({ rubric: active.rubric.map((item) => item.id === criterion.id ? { ...item, description: event.target.value } : item) })} /></div></div>
              <div className="rubric-points"><NumberInput aria-label={`نمرهٔ معیار ${index + 1}`} className="input" min={0} step={0.25} value={criterion.points} onValueChange={(points) => update({ rubric: active.rubric.map((item) => item.id === criterion.id ? { ...item, points } : item) })} /><span>نمرهٔ این بخش</span></div>
              <button className="icon-button btn-icon-small danger-hover" disabled={active.rubric.length === 1} onClick={() => update({ rubric: active.rubric.filter((item) => item.id !== criterion.id) })} aria-label="حذف معیار"><Trash2 size={14} /></button>
            </div>)}</div>
            <div className={`rubric-total ${rubricMismatch ? "mismatch" : ""}`}><span>{rubricMismatch ? <CircleAlert size={15} /> : <Check size={15} />}جمع معیارها: <strong>{faNumber(currentRubricScore)}</strong> از {faNumber(active.maxScore)} نمره</span>{rubricMismatch && <button onClick={autoBalanceRubric}><WandSparkles size={14} />هم‌ترازکردن خودکار</button>}</div>
          </div>

          <div className="question-rules">
            <label className="switch-field"><span><strong>نمرهٔ جزئی</strong><small>امتیاز بخش‌های صحیح، حتی اگر پاسخ کامل نباشد</small></span><span className="switch"><input type="checkbox" checked={active.partialCredit} onChange={(event) => update({ partialCredit: event.target.checked })} /><span className="switch-slider" /></span></label>
            <label className={`switch-field ${active.type !== "math" ? "muted-rule" : ""}`}><span><strong>لحاظ خطای انتقالی</strong><small>عدم جریمهٔ دوباره در گام‌های بعدی محاسبه</small></span><span className="switch"><input type="checkbox" checked={active.errorCarriedForward} onChange={(event) => update({ errorCarriedForward: event.target.checked })} /><span className="switch-slider" /></span></label>
          </div>
          {rubricMismatch && <div className="notice notice-warning"><Scale size={18} /><div><strong>جمع بارم با نمرهٔ سؤال یکسان نیست</strong><p>پیش از ادامه، نمرهٔ سؤال یا معیارها را اصلاح کنید؛ دکمهٔ «هم‌ترازکردن خودکار» نمرات را متناسب می‌کند.</p></div></div>}
        </div>
      </div>
    </div>
  );
}

function normalizeSelection(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
