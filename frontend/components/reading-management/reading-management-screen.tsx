"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { BellRing, BookHeart, CalendarClock, Check, Clock3, Heart, ListChecks, RefreshCw, Target, Trash2 } from "lucide-react";

import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingManagementService } from "@/hooks/use-reading-management-service";
import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { BookCollectionType, ChildBookCollectionDTO, ReadingGoalDTO, ReadingGoalMetric, ReadingGoalPeriod, ReadingGoalStatus, ReadingReminderDTO, ReadingReminderOccurrenceDTO } from "@/types/reading-management";

const weekdayOptions = [{ label: "T2", value: 0 }, { label: "T3", value: 1 }, { label: "T4", value: 2 }, { label: "T5", value: 3 }, { label: "T6", value: 4 }, { label: "T7", value: 5 }, { label: "CN", value: 6 }];
const inputClass = "min-h-12 rounded-control border border-border bg-white px-3 text-label text-ink focus-visible:outline-3 focus-visible:outline-primary";
const actionClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-3 py-2 text-label font-bold";

function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function statusText(status: ReadingGoalStatus): string {
  const labels: Record<ReadingGoalStatus, string> = { ACTIVE: "Đang thực hiện", PAUSED: "Tạm dừng", COMPLETED: "Đã hoàn thành", ENDED: "Đã kết thúc" };
  return labels[status];
}
function clock(value: string): string { return value.slice(0, 5); }

interface Props { requestedChildId?: string }

export function ReadingManagementScreen({ requestedChildId }: Props) {
  const childService = useChildService();
  const bookService = useBookService();
  const service = useReadingManagementService();
  const [children, setChildren] = useState<ChildProfileDTO[]>([]);
  const [childId, setChildId] = useState(requestedChildId ?? "");
  const [goals, setGoals] = useState<ReadingGoalDTO[]>([]);
  const [collections, setCollections] = useState<ChildBookCollectionDTO[]>([]);
  const [reminders, setReminders] = useState<ReadingReminderDTO[]>([]);
  const [due, setDue] = useState<ReadingReminderOccurrenceDTO[]>([]);
  const [books, setBooks] = useState<BookListItemDTO[]>([]);
  const [loadingChildren, setLoadingChildren] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedForChild, setLoadedForChild] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [goalMetric, setGoalMetric] = useState<ReadingGoalMetric>("MINUTES");
  const [goalPeriod, setGoalPeriod] = useState<ReadingGoalPeriod>("DAILY");
  const [goalTarget, setGoalTarget] = useState("20");
  const [goalStart, setGoalStart] = useState(localToday());
  const [goalEnd, setGoalEnd] = useState("");
  const [editingGoalId, setEditingGoalId] = useState("");
  const [editingTarget, setEditingTarget] = useState("20");
  const [reminderTime, setReminderTime] = useState("19:00");
  const [reminderDays, setReminderDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [reminderTimezone, setReminderTimezone] = useState("Asia/Ho_Chi_Minh");
  const [editingReminderId, setEditingReminderId] = useState("");

  const selectedChild = useMemo(() => children.find((child) => child.id === childId) ?? null, [children, childId]);
  const favorites = collections.filter((entry) => entry.collection_type === "FAVORITE");
  const readingList = collections.filter((entry) => entry.collection_type === "WANT_TO_READ");

  useEffect(() => {
    let active = true;
    setLoadingChildren(true);
    childService.list().then((items) => {
      if (!active) return;
      setChildren(items);
      const requested = requestedChildId ? items.find((child) => child.id === requestedChildId) : undefined;
      setChildId((current) => current && items.some((child) => child.id === current) ? current : (requested?.id ?? items[0]?.id ?? ""));
    }).catch(() => {
      if (active) setError("Không tải được hồ sơ bé. Vui lòng thử lại.");
    }).finally(() => { if (active) setLoadingChildren(false); });
    return () => { active = false; };
  }, [childService, requestedChildId]);

  useEffect(() => {
    if (!childId) {
      setGoals([]); setCollections([]); setReminders([]); setDue([]); setBooks([]);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true); setLoadedForChild(""); setError(""); setSuccess("");
    setGoals([]); setCollections([]); setReminders([]); setDue([]); setBooks([]);
    Promise.all([
      service.listGoals(childId, controller.signal),
      service.listCollections(childId, controller.signal),
      service.listReminders(childId, controller.signal),
      bookService.list({ grade: selectedChild?.grade }),
    ]).then(([goalRows, savedRows, reminderRows, bookRows]) => {
      if (!active) return;
      setGoals(goalRows); setCollections(savedRows); setReminders(reminderRows); setBooks(bookRows); setLoadedForChild(childId);
      void service.dueReminders(childId, controller.signal).then((items) => { if (active) setDue(items); }).catch(() => {});
    }).catch(() => {
      if (active) setError("Chưa tải được dữ liệu quản lý đọc. Kiểm tra backend và migration Reading Management rồi thử lại.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [bookService, childId, reloadKey, selectedChild?.grade, service]);

  async function runAction(key: string, operation: () => Promise<unknown>, message: string) {
    if (busyKey) return;
    setBusyKey(key); setError(""); setSuccess("");
    try {
      await operation();
      setSuccess(message);
      setReloadKey((value) => value + 1);
    } catch {
      setError("Không thực hiện được thao tác. Dữ liệu chưa được xác nhận đã lưu; vui lòng thử lại.");
    } finally { setBusyKey(""); }
  }

  async function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId) return;
    const target = Number(goalTarget);
    if (!Number.isInteger(target) || target <= 0) { setError("Giá trị mục tiêu phải là số nguyên lớn hơn 0."); return; }
    await runAction("goal-create", () => service.createGoal({
      child_id: childId, metric: goalMetric, target_value: target, period: goalPeriod,
      starts_on: goalStart, ends_on: goalEnd || null, timezone: "Asia/Ho_Chi_Minh",
    }), "Đã lưu mục tiêu đọc.");
  }

  async function transition(goal: ReadingGoalDTO, next: ReadingGoalStatus) {
    await runAction("goal-" + goal.id, () => service.transitionGoal(goal.id, next), "Đã cập nhật trạng thái mục tiêu.");
  }
  async function saveEditedGoal(goal: ReadingGoalDTO) {
    const target = Number(editingTarget);
    if (!Number.isInteger(target) || target <= 0) { setError("Mục tiêu phải là số nguyên lớn hơn 0."); return; }
    await runAction("goal-edit-" + goal.id, () => service.updateGoal(goal.id, { target_value: target }), "Đã cập nhật mục tiêu.");
    setEditingGoalId("");
  }
  async function toggleCollection(bookId: string, type: BookCollectionType) {
    const existing = collections.find((entry) => entry.book_id === bookId && entry.collection_type === type);
    await runAction("collection-" + bookId + "-" + type, async () => {
      if (existing) await service.removeCollection(childId, bookId, type);
      else await service.addCollection(childId, bookId, type);
    }, existing ? "Đã gỡ sách khỏi danh sách." : "Đã lưu sách vào danh sách.");
  }
  async function submitReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId || reminderDays.length === 0) { setError("Hãy chọn ít nhất một ngày nhắc."); return; }
    const payload = { remind_at: reminderTime, weekdays: [...reminderDays].sort((a, b) => a - b), timezone: reminderTimezone };
    if (editingReminderId) {
      await runAction("reminder-edit", () => service.updateReminder(editingReminderId, payload), "Đã cập nhật lịch nhắc.");
      setEditingReminderId("");
    } else {
      await runAction("reminder-create", () => service.createReminder({ child_id: childId, ...payload, is_active: true }), "Đã tạo lịch nhắc.");
    }
  }
  function beginReminderEdit(reminder: ReadingReminderDTO) {
    setEditingReminderId(reminder.id); setReminderTime(clock(reminder.remind_at));
    setReminderDays(reminder.weekdays); setReminderTimezone(reminder.timezone); setError(""); setSuccess("");
  }

  if (loadingChildren) return <section className="mx-auto max-w-5xl p-6" aria-busy="true">Đang tải hồ sơ bé…</section>;

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-label font-bold text-primary">ViRead · Thói quen đọc</p>
          <h1 className="text-heading font-extrabold text-ink">Quản lý đọc sách</h1>
          <p className="mt-2 max-w-3xl text-label text-muted">Đặt mục tiêu, lưu sách và tạo lịch nhắc theo giờ địa phương của gia đình.</p>
        </div>
        <Button onClick={() => setReloadKey((value) => value + 1)} variant="secondary" disabled={loading || !childId}><RefreshCw aria-hidden="true" className="size-4" /> Tải lại</Button>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-white p-4">
        <label className="font-bold text-ink" htmlFor="management-child">Hồ sơ bé</label>
        <select id="management-child" className={inputClass + " min-w-56"} value={childId} onChange={(event) => setChildId(event.target.value)}>
          {children.map((child) => <option key={child.id} value={child.id}>{child.alias} · Lớp {child.grade}</option>)}
        </select>
        {selectedChild ? <span className="text-label text-muted">Đang xem: {selectedChild.alias}</span> : null}
      </div>
      {error ? <StatusMessage title="Có vấn đề xảy ra" tone="error">{error}</StatusMessage> : null}
      {success ? <StatusMessage title="Đã lưu" tone="success">{success}</StatusMessage> : null}
      {!childId && !loading ? <EmptyState icon={<Target className="size-9" />} title="Chưa có hồ sơ bé" description="Hãy tạo hồ sơ bé trước khi thiết lập mục tiêu hoặc lịch nhắc." /> : null}
      {loading && childId ? <p role="status" aria-live="polite">Đang tải dữ liệu của bé…</p> : null}

      {childId && !loading && loadedForChild === childId ? (
        <>
          <section className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-3"><Target className="size-6 text-primary" /><h2 className="text-xl font-extrabold text-ink">Kế hoạch và mục tiêu đọc</h2></div>
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" onSubmit={submitGoal}>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Đo lường
                <select className={inputClass} value={goalMetric} onChange={(e) => setGoalMetric(e.target.value as ReadingGoalMetric)}><option value="MINUTES">Phút đọc</option><option value="SESSIONS">Buổi đọc hoàn thành</option></select>
              </label>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Mục tiêu
                <input className={inputClass} type="number" min={1} max={100000} step={1} required value={goalTarget} onChange={(e) => setGoalTarget(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Chu kỳ
                <select className={inputClass} value={goalPeriod} onChange={(e) => setGoalPeriod(e.target.value as ReadingGoalPeriod)}><option value="DAILY">Mỗi ngày</option><option value="WEEKLY">Mỗi tuần</option></select>
              </label>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Bắt đầu
                <input className={inputClass} type="date" required value={goalStart} onChange={(e) => setGoalStart(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Kết thúc (tùy chọn)
                <input className={inputClass} type="date" min={goalStart} value={goalEnd} onChange={(e) => setGoalEnd(e.target.value)} />
              </label>
              <div className="flex items-end"><Button type="submit" disabled={Boolean(busyKey)}>Tạo mục tiêu</Button></div>
            </form>
            {goals.length === 0 ? <p className="mt-5 rounded-control bg-canvas p-4 text-label text-muted">Bé chưa có mục tiêu đọc nào.</p> : (
              <div className="mt-5 grid gap-4 md:grid-cols-2">{goals.map((goal) => (
                <article key={goal.id} className="rounded-card border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-extrabold text-ink">{goal.target_value} {goal.metric === "MINUTES" ? "phút" : "buổi"} · {goal.period === "DAILY" ? "mỗi ngày" : "mỗi tuần"}</h3><span className="rounded-full bg-sky px-3 py-1 text-label font-bold text-primary">{statusText(goal.status)}</span></div>
                  <p className="mt-2 text-label text-muted">Từ {goal.starts_on}{goal.ends_on ? " đến " + goal.ends_on : ""} · {goal.timezone}</p>
                  <div className="mt-4 flex items-center justify-between text-label"><span>Tiến độ chu kỳ hiện tại</span><strong>{goal.current_value}/{goal.target_value}</strong></div>
                  <div className="mt-2 h-3 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-primary transition-all" style={{ width: String(goal.progress_percent) + "%" }} /></div>
                  <p className="mt-1 text-right text-label font-bold text-primary">{goal.progress_percent}%</p>
                  {editingGoalId === goal.id ? <div className="mt-3 flex gap-2"><input aria-label="Giá trị mục tiêu mới" className={inputClass + " w-28"} type="number" min={1} value={editingTarget} onChange={(e) => setEditingTarget(e.target.value)} /><Button onClick={() => void saveEditedGoal(goal)} disabled={Boolean(busyKey)}>Lưu</Button><Button variant="secondary" onClick={() => setEditingGoalId("")}>Hủy</Button></div> : null}
                  {goal.status === "ACTIVE" || goal.status === "PAUSED" ? <div className="mt-4 flex flex-wrap gap-2">
                    <button className={actionClass + " border border-border hover:bg-canvas"} onClick={() => { setEditingGoalId(goal.id); setEditingTarget(String(goal.target_value)); }} type="button">Sửa mục tiêu</button>
                    {goal.status === "ACTIVE" ? <button className={actionClass + " bg-cream text-ink"} disabled={Boolean(busyKey)} onClick={() => void transition(goal, "PAUSED")} type="button">Tạm dừng</button> : <button className={actionClass + " bg-sky text-primary"} disabled={Boolean(busyKey)} onClick={() => void transition(goal, "ACTIVE")} type="button">Tiếp tục</button>}
                    <button className={actionClass + " bg-sky text-primary"} disabled={Boolean(busyKey)} onClick={() => void transition(goal, "COMPLETED")} type="button">Hoàn thành</button>
                    <button className={actionClass + " border border-border text-muted"} disabled={Boolean(busyKey)} onClick={() => void transition(goal, "ENDED")} type="button">Kết thúc</button>
                  </div> : null}
                </article>
              ))}</div>
            )}
            <p className="mt-4 text-xs text-muted">Tiến độ chỉ tính phiên FINISHED có thời điểm bắt đầu/kết thúc hợp lệ. Mục tiêu không tự hoàn thành chỉ vì đạt 100%.</p>
          </section>

          <section className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-3"><BookHeart className="size-6 text-primary" /><h2 className="text-xl font-extrabold text-ink">Sách yêu thích và danh sách muốn đọc</h2></div>
            <p className="mb-4 text-label text-muted">Trạng thái được lưu trên backend theo hồ sơ bé. Sách đã nghỉ vẫn hiện trong danh sách cũ để có thể gỡ lưu, nhưng không thể bắt đầu đọc.</p>
            <div className="grid gap-5 lg:grid-cols-2">
              {[{type: "FAVORITE" as const, title: "Sách yêu thích", rows: favorites, icon: <Heart className="size-5" />}, {type: "WANT_TO_READ" as const, title: "Danh sách muốn đọc", rows: readingList, icon: <ListChecks className="size-5" />}].map((group) => (
                <div key={group.type} className="rounded-card bg-canvas p-4">
                  <h3 className="mb-3 flex items-center gap-2 font-extrabold text-ink">{group.icon}{group.title} <span className="text-label font-normal text-muted">({group.rows.length})</span></h3>
                  {group.rows.length === 0 ? <p className="text-label text-muted">Chưa lưu cuốn sách nào.</p> : <ul className="space-y-3">{group.rows.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-3 rounded-control bg-white p-3">
                      <div className="min-w-0"><p className="truncate font-bold text-ink">{entry.book.title}</p><p className="text-label text-muted">{entry.book.author ?? "Chưa cập nhật tác giả"} · {entry.book.lifecycle_status === "RETIRED" ? "Không còn khả dụng để đọc" : "Lớp " + entry.book.min_grade + "–" + entry.book.max_grade}</p></div>
                      <button className={actionClass + " shrink-0 border border-border"} type="button" disabled={Boolean(busyKey)} onClick={() => void toggleCollection(entry.book_id, group.type)}><Trash2 className="size-4" />Bỏ lưu</button>
                    </li>
                  ))}</ul>}
                </div>
              ))}
            </div>
            <h3 className="mb-3 mt-6 font-extrabold text-ink">Thêm từ thư viện sách đã xác minh</h3>
            {books.length === 0 ? <p className="text-label text-muted">Hiện chưa có sách khả dụng phù hợp với lớp của bé.</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{books.map((book) => {
              const favorite = collections.some((entry) => entry.book_id === book.id && entry.collection_type === "FAVORITE");
              const planned = collections.some((entry) => entry.book_id === book.id && entry.collection_type === "WANT_TO_READ");
              return <article key={book.id} className="flex flex-col gap-2 rounded-card border border-border p-4">
                <h4 className="font-extrabold text-ink">{book.title}</h4><p className="text-label text-muted">{book.author ?? "Chưa cập nhật tác giả"} · Lớp {book.min_grade}–{book.max_grade}</p>
                <div className="mt-auto flex flex-wrap gap-2">
                  <button className={actionClass + (favorite ? " bg-sky text-primary" : " border border-border")} type="button" disabled={Boolean(busyKey)} aria-pressed={favorite} onClick={() => void toggleCollection(book.id, "FAVORITE")}><Heart className="size-4" />{favorite ? "Đã yêu thích" : "Yêu thích"}</button>
                  <button className={actionClass + (planned ? " bg-sky text-primary" : " border border-border")} type="button" disabled={Boolean(busyKey)} aria-pressed={planned} onClick={() => void toggleCollection(book.id, "WANT_TO_READ")}><ListChecks className="size-4" />{planned ? "Đã lưu đọc" : "Muốn đọc"}</button>
                  <Link className={actionClass + " bg-primary text-white"} href={"/books/" + encodeURIComponent(book.id) + "?childId=" + encodeURIComponent(childId)}>Mở sách</Link>
                </div>
              </article>;
            })}</div>}
          </section>

          <section className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-3"><CalendarClock className="size-6 text-primary" /><h2 className="text-xl font-extrabold text-ink">Lịch nhắc đọc</h2></div>
            <p className="mb-4 text-label text-muted">Nhắc trong ứng dụng khi phụ huynh mở trang này sau giờ đặt. Chưa có push, email, SMS hoặc nhắc nền khi ứng dụng đóng.</p>
            <form className="grid gap-3 md:grid-cols-2 lg:grid-cols-4" onSubmit={submitReminder}>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Giờ địa phương
                <input className={inputClass} type="time" required value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-label font-bold text-ink">Timezone IANA
                <input className={inputClass} list="reading-timezones" required value={reminderTimezone} onChange={(e) => setReminderTimezone(e.target.value)} />
                <datalist id="reading-timezones"><option value="Asia/Ho_Chi_Minh" /><option value="Asia/Bangkok" /><option value="Asia/Singapore" /><option value="UTC" /><option value="America/Los_Angeles" /></datalist>
              </label>
              <fieldset className="md:col-span-2"><legend className="mb-2 text-label font-bold text-ink">Lặp vào ngày</legend><div className="flex flex-wrap gap-2">{weekdayOptions.map((day) => <label key={day.value} className={actionClass + (reminderDays.includes(day.value) ? " bg-sky text-primary" : " border border-border")}><input className="accent-primary" type="checkbox" checked={reminderDays.includes(day.value)} onChange={(e) => setReminderDays((current) => e.target.checked ? [...current, day.value].sort((a,b) => a-b) : current.filter((item) => item !== day.value))} />{day.label}</label>)}</div></fieldset>
              <div className="flex flex-wrap items-end gap-2 md:col-span-2 lg:col-span-4"><Button type="submit" disabled={Boolean(busyKey)}>{editingReminderId ? "Lưu chỉnh sửa" : "Tạo lịch nhắc"}</Button>{editingReminderId ? <Button type="button" variant="secondary" onClick={() => setEditingReminderId("")}>Hủy sửa</Button> : null}</div>
            </form>
            {due.length > 0 ? <div className="mt-5 rounded-card border border-border bg-cream p-4"><h3 className="mb-3 flex items-center gap-2 font-extrabold text-ink"><BellRing className="size-5" />Đến giờ đọc sách</h3><ul className="space-y-2">{due.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-white p-3"><span className="text-label text-ink">Lịch nhắc lúc {item.reminder ? clock(item.reminder.remind_at) : new Date(item.scheduled_for).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})} · {item.scheduled_local_date}</span><button className={actionClass + " bg-sky text-primary"} type="button" disabled={Boolean(busyKey)} onClick={() => void runAction("due-" + item.id, () => service.acknowledgeOccurrence(item.id), "Đã ghi nhận lời nhắc.")}><Check className="size-4" />Đã xem</button></li>)}</ul></div> : null}
            {reminders.length === 0 ? <p className="mt-5 rounded-control bg-canvas p-4 text-label text-muted">Chưa có lịch nhắc nào.</p> : <div className="mt-5 grid gap-3 md:grid-cols-2">{reminders.map((reminder) => <article key={reminder.id} className="rounded-card border border-border p-4">
              <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 font-extrabold text-ink"><Clock3 className="size-5 text-primary" />{clock(reminder.remind_at)}</h3><p className="mt-1 text-label text-muted">{reminder.weekdays.map((day) => weekdayOptions.find((option) => option.value === day)?.label).join(", ")} · {reminder.timezone}</p></div><label className="flex items-center gap-2 text-label font-bold"><input type="checkbox" checked={reminder.is_active} disabled={Boolean(busyKey)} onChange={(e) => void runAction("reminder-toggle-" + reminder.id, () => service.updateReminder(reminder.id, { is_active: e.target.checked }), e.target.checked ? "Đã bật lịch nhắc." : "Đã tắt lịch nhắc.")} />Đang bật</label></div>
              <div className="mt-3 flex flex-wrap gap-2"><button className={actionClass + " border border-border"} type="button" onClick={() => { setEditingReminderId(reminder.id); setReminderTime(clock(reminder.remind_at)); setReminderDays(reminder.weekdays); setReminderTimezone(reminder.timezone); }}>Chỉnh sửa</button><button className={actionClass + " border border-border text-danger"} type="button" disabled={Boolean(busyKey)} onClick={() => void runAction("reminder-delete-" + reminder.id, () => service.deleteReminder(reminder.id), "Đã xóa lịch nhắc.")}><Trash2 className="size-4" />Xóa</button></div>
            </article>)}</div>}
          </section>
        </>
      ) : null}
    </section>
  );
}
