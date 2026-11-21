"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  BellRing,
  BookHeart,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Mail,
  RefreshCw,
  Target,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/common/button";
import { FormPage } from "@/components/common/form-page";
import { InformationField } from "@/components/common/information-field";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { VerifiedBookPicker } from "./verified-book-picker";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingManagementService } from "@/hooks/use-reading-management-service";
import { conflictMessage } from "@/lib/api/reading-management-messages";
import {
  GoalInsights,
  PlanInsights,
  TodaySummary,
  isRunningGoal,
  isRunningPlan,
} from "@/components/reading-management/reading-management-insights";
import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
  ReadingGoalDTO,
  ReadingGoalMetric,
  ReadingGoalPeriod,
  ReadingGoalStatus,
  ReadingPlanDTO,
  ReadingPlanStatus,
  ReadingReminderEmailStatus,
  ReadingReminderDTO,
  ReadingReminderOccurrenceDTO,
} from "@/types/reading-management";

const weekdayOptions = [
  { label: "T2", value: 0 },
  { label: "T3", value: 1 },
  { label: "T4", value: 2 },
  { label: "T5", value: 3 },
  { label: "T6", value: 4 },
  { label: "T7", value: 5 },
  { label: "CN", value: 6 },
];
const inputClass =
  "min-h-12 min-w-0 w-full rounded-control border border-border bg-white px-3 text-label text-ink focus-visible:outline-3 focus-visible:outline-primary";
const labelClass =
  "flex min-w-0 flex-col gap-1 text-label font-semibold text-ink";
const actionClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-3 py-2 text-label font-semibold";

function localToday(timeZone = "Asia/Ho_Chi_Minh"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function statusText(status: ReadingGoalStatus): string {
  const labels: Record<ReadingGoalStatus, string> = {
    ACTIVE: "Đang thực hiện",
    PAUSED: "Tạm dừng",
    COMPLETED: "Đã hoàn thành",
    ENDED: "Đã kết thúc",
  };
  return labels[status];
}
function planStatusText(status: ReadingPlanStatus): string {
  const labels: Record<ReadingPlanStatus, string> = {
    ACTIVE: "Đang theo kế hoạch",
    PAUSED: "Tạm dừng",
    COMPLETED: "Đã hoàn thành",
    ENDED: "Đã kết thúc",
  };
  return labels[status];
}
function emailStatusText(status: ReadingReminderEmailStatus): string {
  const labels: Record<ReadingReminderEmailStatus, string> = {
    NOT_REQUESTED: "Không gửi email",
    PENDING: "Đang chờ gửi email",
    SENDING: "Đang gửi email",
    RETRY: "Sẽ thử gửi lại",
    SENT: "Đã gửi email",
    FAILED: "Gửi email chưa thành công",
  };
  return labels[status];
}
function clock(value: string): string {
  return value.slice(0, 5);
}

interface Props {
  requestedChildId?: string;
}

export function ReadingManagementScreen({ requestedChildId }: Props) {
  const childService = useChildService();
  const bookService = useBookService();
  const service = useReadingManagementService();
  const [children, setChildren] = useState<ChildProfileDTO[]>([]);
  const [childId, setChildId] = useState(requestedChildId ?? "");
  const [goals, setGoals] = useState<ReadingGoalDTO[]>([]);
  const [plans, setPlans] = useState<ReadingPlanDTO[]>([]);
  const [collections, setCollections] = useState<ChildBookCollectionDTO[]>([]);
  const [reminders, setReminders] = useState<ReadingReminderDTO[]>([]);
  const [due, setDue] = useState<ReadingReminderOccurrenceDTO[]>([]);
  const [books, setBooks] = useState<BookListItemDTO[] | null>([]);
  const [loadingChildren, setLoadingChildren] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedRequestKey, setLoadedRequestKey] = useState("");
  const [settledRequestKey, setSettledRequestKey] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [activeForm, setActiveForm] = useState<
    "plan" | "goal" | "reminder" | null
  >(null);
  const [goalMetric, setGoalMetric] = useState<ReadingGoalMetric>("MINUTES");
  const [goalPeriod, setGoalPeriod] = useState<ReadingGoalPeriod>("DAILY");
  const [goalTarget, setGoalTarget] = useState("20");
  const [goalStart, setGoalStart] = useState(localToday());
  const [goalEnd, setGoalEnd] = useState("");
  const [editingGoalId, setEditingGoalId] = useState("");
  const [editingTarget, setEditingTarget] = useState("20");
  const [planTitle, setPlanTitle] = useState("");
  const [planMinutes, setPlanMinutes] = useState("20");
  const [planBookId, setPlanBookId] = useState("");
  const [planDays, setPlanDays] = useState<number[]>([0, 2, 4]);
  const [planStart, setPlanStart] = useState(localToday());
  const [planEnd, setPlanEnd] = useState("");
  const [planTimezone, setPlanTimezone] = useState("Asia/Ho_Chi_Minh");
  const [editingPlanId, setEditingPlanId] = useState("");
  const [reminderTime, setReminderTime] = useState("19:00");
  const [reminderDays, setReminderDays] = useState<number[]>([
    0, 1, 2, 3, 4, 5, 6,
  ]);
  const [reminderTimezone, setReminderTimezone] = useState("Asia/Ho_Chi_Minh");
  const [reminderEmailEnabled, setReminderEmailEnabled] = useState(false);
  const [editingReminderId, setEditingReminderId] = useState("");

  const currentRequestKey = `${childId}:${reloadKey}`;
  const hasReadingData =
    Boolean(childId) && loadedRequestKey.startsWith(`${childId}:`);
  const isReadingDataLoading =
    Boolean(childId) && settledRequestKey !== currentRequestKey;
  const selectedChild = useMemo(
    () => children.find((child) => child.id === childId) ?? null,
    [children, childId],
  );
  const favorites = collections.filter(
    (entry) => entry.collection_type === "FAVORITE",
  );
  const readingList = collections.filter(
    (entry) => entry.collection_type === "WANT_TO_READ",
  );

  useEffect(() => {
    let active = true;
    childService
      .list()
      .then((items) => {
        if (!active) return;
        setChildren(items);
        const requested = requestedChildId
          ? items.find((child) => child.id === requestedChildId)
          : undefined;
        setChildId((current) =>
          current && items.some((child) => child.id === current)
            ? current
            : (requested?.id ?? items[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (active) setError("Không tải được hồ sơ bé. Vui lòng thử lại.");
      })
      .finally(() => {
        if (active) setLoadingChildren(false);
      });
    return () => {
      active = false;
    };
  }, [childService, requestedChildId]);

  useEffect(() => {
    if (!childId) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    Promise.all([
      service.listGoals(childId, controller.signal),
      service.listPlans(childId, controller.signal),
      service.listCollections(childId, controller.signal),
      service.listReminders(childId, controller.signal),
      bookService
        .list({ grade: selectedChild?.grade, include_private: true })
        .catch(() => null),
    ])
      .then(([goalRows, planRows, savedRows, reminderRows, bookRows]) => {
        if (!active) return;
        setError("");
        setGoals(goalRows);
        setPlans(planRows);
        setCollections(savedRows);
        setReminders(reminderRows);
        setBooks(bookRows);
        setLoadedRequestKey(currentRequestKey);
        void service
          .dueReminders(childId, controller.signal)
          .then((items) => {
            if (active) setDue(items);
          })
          .catch(() => {});
      })
      .catch(() => {
        if (active)
          setError(
            "Chưa tải được dữ liệu quản lý đọc. Kiểm tra backend và migration Reading Management rồi thử lại.",
          );
      })
      .finally(() => {
        if (active) setSettledRequestKey(currentRequestKey);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    bookService,
    childId,
    currentRequestKey,
    reloadKey,
    selectedChild?.grade,
    service,
  ]);

  async function runAction(
    key: string,
    operation: () => Promise<unknown>,
    message: string,
  ): Promise<boolean> {
    if (busyKey) return false;
    setBusyKey(key);
    setError("");
    setSuccess("");
    try {
      await operation();
      setSuccess(message);
      setActiveForm(null);
      setReloadKey((value) => value + 1);
      return true;
    } catch (failure) {
      setError(
        conflictMessage(failure) ??
          "Không thực hiện được thao tác. Dữ liệu chưa được xác nhận đã lưu; vui lòng thử lại.",
      );
      return false;
    } finally {
      setBusyKey("");
    }
  }

  async function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId) return;
    const target = Number(goalTarget);
    if (!Number.isInteger(target) || target <= 0) {
      setError("Giá trị mục tiêu phải là số nguyên lớn hơn 0.");
      return;
    }
    await runAction(
      "goal-create",
      () =>
        service.createGoal({
          child_id: childId,
          metric: goalMetric,
          target_value: target,
          period: goalPeriod,
          starts_on: goalStart,
          ends_on: goalEnd || null,
          timezone: "Asia/Ho_Chi_Minh",
        }),
      "Đã lưu mục tiêu đọc.",
    );
  }

  async function transition(goal: ReadingGoalDTO, next: ReadingGoalStatus) {
    if (
      next === "ENDED" &&
      !window.confirm(
        "Kết thúc mục tiêu này? Tiến độ đã ghi nhận vẫn được lưu.",
      )
    )
      return;
    await runAction(
      "goal-" + goal.id,
      () => service.transitionGoal(goal.id, next),
      "Đã cập nhật trạng thái mục tiêu.",
    );
  }
  async function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId || planDays.length === 0) {
      setError("Hãy chọn ít nhất một ngày đọc trong tuần.");
      return;
    }
    const targetMinutes = Number(planMinutes);
    if (
      !Number.isInteger(targetMinutes) ||
      targetMinutes < 5 ||
      targetMinutes > 240
    ) {
      setError("Thời lượng mỗi buổi phải từ 5 đến 240 phút.");
      return;
    }
    const title = planTitle.trim();
    if (!title) {
      setError("Hãy đặt tên cho kế hoạch đọc.");
      return;
    }
    const values = {
      title,
      book_id: planBookId || null,
      target_minutes: targetMinutes,
      weekdays: [...planDays].sort((a, b) => a - b),
      ends_on: planEnd || null,
      timezone: planTimezone,
    };
    const saved = editingPlanId
      ? await runAction(
          "plan-edit-" + editingPlanId,
          () => service.updatePlan(editingPlanId, values),
          "Đã cập nhật kế hoạch đọc.",
        )
      : await runAction(
          "plan-create",
          () =>
            service.createPlan({
              child_id: childId,
              starts_on: planStart,
              ...values,
            }),
          "Đã tạo kế hoạch đọc tuần.",
        );
    if (saved) {
      setEditingPlanId("");
      setPlanTitle("");
      setPlanBookId("");
      setPlanMinutes("20");
      setPlanDays([0, 2, 4]);
      setPlanStart(localToday());
      setPlanEnd("");
    }
  }
  async function transitionPlan(plan: ReadingPlanDTO, next: ReadingPlanStatus) {
    if (
      next === "ENDED" &&
      !window.confirm(
        "Kết thúc kế hoạch này? Lịch sử tiến độ đã ghi nhận vẫn được lưu.",
      )
    )
      return;
    const messages: Record<ReadingPlanStatus, string> = {
      ACTIVE: "Đã tiếp tục kế hoạch.",
      PAUSED: "Đã tạm dừng kế hoạch.",
      COMPLETED: "Đã hoàn thành kế hoạch.",
      ENDED: "Đã kết thúc kế hoạch.",
    };
    await runAction(
      "plan-transition-" + plan.id,
      () => service.transitionPlan(plan.id, next),
      messages[next],
    );
  }
  async function saveEditedGoal(goal: ReadingGoalDTO) {
    const target = Number(editingTarget);
    if (!Number.isInteger(target) || target <= 0) {
      setError("Mục tiêu phải là số nguyên lớn hơn 0.");
      return;
    }
    await runAction(
      "goal-edit-" + goal.id,
      () => service.updateGoal(goal.id, { target_value: target }),
      "Đã cập nhật mục tiêu.",
    );
    setEditingGoalId("");
  }
  async function toggleCollection(bookId: string, type: BookCollectionType) {
    const existing = collections.find(
      (entry) => entry.book_id === bookId && entry.collection_type === type,
    );
    await runAction(
      "collection-" + bookId + "-" + type,
      async () => {
        if (existing) await service.removeCollection(childId, bookId, type);
        else await service.addCollection(childId, bookId, type);
      },
      existing ? "Đã gỡ sách khỏi danh sách." : "Đã lưu sách vào danh sách.",
    );
  }
  async function submitReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId || reminderDays.length === 0) {
      setError("Hãy chọn ít nhất một ngày nhắc.");
      return;
    }
    const payload = {
      remind_at: reminderTime,
      weekdays: [...reminderDays].sort((a, b) => a - b),
      timezone: reminderTimezone,
      email_enabled: reminderEmailEnabled,
    };
    if (editingReminderId) {
      const saved = await runAction(
        "reminder-edit",
        () => service.updateReminder(editingReminderId, payload),
        "Đã cập nhật lịch nhắc.",
      );
      if (saved) setEditingReminderId("");
    } else {
      const saved = await runAction(
        "reminder-create",
        () =>
          service.createReminder({
            child_id: childId,
            ...payload,
            is_active: true,
          }),
        "Đã tạo lịch nhắc.",
      );
      if (saved) setReminderEmailEnabled(false);
    }
  }
  if (activeForm) {
    const titles = {
      plan: editingPlanId ? "Chỉnh sửa kế hoạch đọc" : "Thiết lập kế hoạch đọc",
      goal: "Thiết lập mục tiêu",
      reminder: editingReminderId
        ? "Chỉnh sửa lịch nhắc"
        : "Thiết lập lịch nhắc",
    };
    const descriptions = {
      plan: "Chọn sách, thời lượng và lịch đọc phù hợp với bé.",
      goal: "Đặt mục tiêu vừa sức và theo dõi sự tiến bộ của bé.",
      reminder: "Chọn thời gian và những ngày bạn muốn nhận lời nhắc đọc sách.",
    };
    return (
      <FormPage
        title={titles[activeForm]}
        description={descriptions[activeForm]}
        onBack={() => setActiveForm(null)}
      >
        {activeForm === "plan" ? (
          <>
            {error ? (
              <StatusMessage title="Có vấn đề xảy ra" tone="error">
                {error}
              </StatusMessage>
            ) : null}
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitPlan}>
              <label className={labelClass}>
                Tên kế hoạch
                <input
                  className={inputClass}
                  maxLength={100}
                  required
                  value={planTitle}
                  onChange={(event) => setPlanTitle(event.target.value)}
                  placeholder="Ví dụ: Đọc cùng bé sau bữa tối"
                />
              </label>
              <label className={labelClass}>
                Sách dự định đọc
                <select
                  className={inputClass}
                  value={planBookId}
                  onChange={(event) => setPlanBookId(event.target.value)}
                >
                  <option value="">Chưa chọn sách</option>
                  {(books ?? []).map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Thời lượng mỗi buổi (phút)
                <input
                  className={inputClass}
                  type="number"
                  min={5}
                  max={240}
                  step={1}
                  required
                  value={planMinutes}
                  onChange={(event) => setPlanMinutes(event.target.value)}
                />
              </label>
              <label className={labelClass}>
                Múi giờ
                <input
                  className={inputClass}
                  list="reading-timezones"
                  required
                  value={planTimezone}
                  onChange={(event) => setPlanTimezone(event.target.value)}
                />
              </label>
              <fieldset className="min-w-0 sm:col-span-2">
                <legend className="mb-2 text-label font-semibold text-ink">
                  Ngày đọc mỗi tuần
                </legend>
                <div className="flex flex-wrap gap-2">
                  {weekdayOptions.map((day) => (
                    <label
                      key={day.value}
                      className={
                        actionClass +
                        (planDays.includes(day.value)
                          ? " bg-sky text-primary"
                          : " border border-border")
                      }
                    >
                      <input
                        className="accent-primary"
                        type="checkbox"
                        checked={planDays.includes(day.value)}
                        onChange={(event) =>
                          setPlanDays((current) =>
                            event.target.checked
                              ? [...current, day.value].sort((a, b) => a - b)
                              : current.filter((value) => value !== day.value),
                          )
                        }
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={labelClass}>
                Bắt đầu từ
                <input
                  className={inputClass}
                  type="date"
                  required
                  disabled={Boolean(editingPlanId)}
                  value={planStart}
                  onChange={(event) => setPlanStart(event.target.value)}
                />
              </label>
              <label className={labelClass}>
                Kết thúc (tùy chọn)
                <input
                  className={inputClass}
                  type="date"
                  min={planStart}
                  value={planEnd}
                  onChange={(event) => setPlanEnd(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
                <Button type="submit" disabled={Boolean(busyKey)}>
                  {editingPlanId ? "Lưu kế hoạch" : "Tạo kế hoạch tuần"}
                </Button>
                {editingPlanId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditingPlanId("")}
                  >
                    Hủy sửa
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        ) : activeForm === "goal" ? (
          <>
            {error ? (
              <StatusMessage title="Có vấn đề xảy ra" tone="error">
                {error}
              </StatusMessage>
            ) : null}
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitGoal}>
              <label className={labelClass}>
                Đo lường
                <select
                  className={inputClass}
                  value={goalMetric}
                  onChange={(e) =>
                    setGoalMetric(e.target.value as ReadingGoalMetric)
                  }
                >
                  <option value="MINUTES">Phút đọc</option>
                  <option value="SESSIONS">Buổi đọc hoàn thành</option>
                </select>
              </label>
              <label className={labelClass}>
                Mục tiêu
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  required
                  value={goalTarget}
                  onChange={(e) => setGoalTarget(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                Chu kỳ
                <select
                  className={inputClass}
                  value={goalPeriod}
                  onChange={(e) =>
                    setGoalPeriod(e.target.value as ReadingGoalPeriod)
                  }
                >
                  <option value="DAILY">Mỗi ngày</option>
                  <option value="WEEKLY">Mỗi tuần</option>
                </select>
              </label>
              <label className={labelClass}>
                Bắt đầu
                <input
                  className={inputClass}
                  type="date"
                  required
                  value={goalStart}
                  onChange={(e) => setGoalStart(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                Kết thúc (tùy chọn)
                <input
                  className={inputClass}
                  type="date"
                  min={goalStart}
                  value={goalEnd}
                  onChange={(e) => setGoalEnd(e.target.value)}
                />
              </label>
              <div className="flex items-end">
                <Button type="submit" disabled={Boolean(busyKey)}>
                  Tạo mục tiêu
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            {error ? (
              <StatusMessage title="Có vấn đề xảy ra" tone="error">
                {error}
              </StatusMessage>
            ) : null}
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={submitReminder}
            >
              <label className={labelClass}>
                Giờ địa phương
                <input
                  className={inputClass}
                  type="time"
                  required
                  value={reminderTime}
                  onChange={(e) => setReminderTime(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                Timezone IANA
                <input
                  className={inputClass}
                  list="reading-timezones"
                  required
                  value={reminderTimezone}
                  onChange={(e) => setReminderTimezone(e.target.value)}
                />
                <datalist id="reading-timezones">
                  <option value="Asia/Ho_Chi_Minh" />
                  <option value="Asia/Bangkok" />
                  <option value="Asia/Singapore" />
                  <option value="UTC" />
                  <option value="America/Los_Angeles" />
                </datalist>
              </label>
              <fieldset className="min-w-0 sm:col-span-2">
                <legend className="mb-2 text-label font-semibold text-ink">
                  Lặp vào ngày
                </legend>
                <div className="flex flex-wrap gap-2">
                  {weekdayOptions.map((day) => (
                    <label
                      key={day.value}
                      className={
                        actionClass +
                        (reminderDays.includes(day.value)
                          ? " bg-sky text-primary"
                          : " border border-border")
                      }
                    >
                      <input
                        className="accent-primary"
                        type="checkbox"
                        checked={reminderDays.includes(day.value)}
                        onChange={(e) =>
                          setReminderDays((current) =>
                            e.target.checked
                              ? [...current, day.value].sort((a, b) => a - b)
                              : current.filter((item) => item !== day.value),
                          )
                        }
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="min-w-0 rounded-control border border-border bg-canvas p-3 sm:col-span-2">
                <legend className="px-1 text-label font-semibold text-ink">
                  Email nhắc đọc
                </legend>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    className="mt-1 size-5 accent-primary"
                    type="checkbox"
                    checked={reminderEmailEnabled}
                    onChange={(event) =>
                      setReminderEmailEnabled(event.target.checked)
                    }
                  />
                  <span>
                    <span className="flex items-center gap-2 font-semibold text-ink">
                      <Mail className="size-4 text-primary" /> Gửi email cho phụ
                      huynh khi đến giờ
                    </span>
                    <span className="mt-1 block text-sm text-muted">
                      Email được gửi tới địa chỉ đã xác minh của tài khoản phụ
                      huynh.
                    </span>
                  </span>
                </label>
              </fieldset>
              <div className="flex min-w-0 flex-wrap items-end gap-2 sm:col-span-2">
                <Button type="submit" disabled={Boolean(busyKey)}>
                  {editingReminderId ? "Lưu chỉnh sửa" : "Tạo lịch nhắc"}
                </Button>
                {editingReminderId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditingReminderId("")}
                  >
                    Hủy sửa
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        )}
      </FormPage>
    );
  }

  if (loadingChildren)
    return (
      <section
        className="mx-auto max-w-[1120px] p-6 text-body text-muted"
        aria-busy="true"
      >
        Đang tải hồ sơ bé…
      </section>
    );

  return (
    <section className="reading-organizer mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-heading font-extrabold leading-tight text-ink">
            Quản lý đọc sách
          </h1>
          <p className="mt-3 max-w-3xl text-body leading-6 text-muted">
            Đặt mục tiêu, lưu sách và tạo lịch nhắc theo giờ địa phương của gia
            đình.
          </p>
        </div>
        <Button
          onClick={() => setReloadKey((value) => value + 1)}
          className="sm:w-auto"
          variant="secondary"
          disabled={isReadingDataLoading || !childId}
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Tải lại
        </Button>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <label
          className="flex min-h-[72px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-4 py-3 text-label text-muted"
          htmlFor="management-child"
        >
          Hồ sơ bé
          <select
            id="management-child"
            className="min-h-6 w-full min-w-0 bg-white text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
            value={childId}
            onChange={(event) => setChildId(event.target.value)}
          >
            {children.map((child) => (
              <option key={child.id} value={child.id}>
                {child.alias} · Lớp {child.grade}
              </option>
            ))}
          </select>
        </label>
        {selectedChild ? (
          <dl>
            <InformationField label="Đang xem">
              {selectedChild.alias} · Lớp {selectedChild.grade}
            </InformationField>
          </dl>
        ) : null}
      </div>
      {error && !activeForm ? (
        <StatusMessage title="Có vấn đề xảy ra" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {success ? (
        <StatusMessage title="Đã lưu" tone="success">
          {success}
        </StatusMessage>
      ) : null}
      {!childId && !isReadingDataLoading ? (
        <EmptyState
          icon={<Target className="size-9" />}
          title="Chưa có hồ sơ bé"
          description="Hãy tạo hồ sơ bé trước khi thiết lập mục tiêu hoặc lịch nhắc."
        />
      ) : null}
      {isReadingDataLoading && childId ? (
        <p role="status" aria-live="polite">
          Đang tải dữ liệu của bé…
        </p>
      ) : null}

      {hasReadingData ? (
        <>
          <section
            aria-label="Tổng quan thói quen đọc"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            {[
              {
                label: "Mục tiêu đang chạy",
                value: goals.filter(isRunningGoal).length,
                detail: "mục tiêu đọc",
                icon: <Target className="size-5" />,
              },
              {
                label: "Kế hoạch trong tuần",
                value: plans.filter(isRunningPlan).length,
                detail: "kế hoạch đang hoạt động",
                icon: <CalendarDays className="size-5" />,
              },
              {
                label: "Lịch nhắc đã bật",
                value: reminders.filter((reminder) => reminder.is_active)
                  .length,
                detail: "lịch nhắc cho bé",
                icon: <BellRing className="size-5" />,
              },
              {
                label: "Sách đã lưu",
                value: collections.length,
                detail: "sách yêu thích hoặc muốn đọc",
                icon: <BookHeart className="size-5" />,
              },
            ].map((item) => (
              <article
                key={item.label}
                className="rounded-card border border-border bg-white p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-label font-bold text-muted">
                    {item.label}
                  </p>
                  <span className="text-primary">{item.icon}</span>
                </div>
                <p className="mt-2 text-heading font-extrabold text-primary">
                  {item.value}
                </p>
                <p className="mt-1 text-label text-muted">{item.detail}</p>
              </article>
            ))}
          </section>

          <details className="rounded-control border border-border bg-white px-4 py-3">
            <summary className="cursor-pointer font-bold text-primary">
              Hôm nay bé cần đọc gì?
            </summary>
            <TodaySummary
              childName={selectedChild?.alias ?? "bé"}
              plans={plans}
              goals={goals}
            />
          </details>

          <div className="grid items-start gap-6 lg:grid-cols-2">
            <section className="min-w-0 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6">
              <div className="mb-5 flex items-start gap-3">
                <div className="rounded-full bg-sky p-3 text-primary">
                  <CalendarDays className="size-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-extrabold text-ink">
                    Kế hoạch đọc trong tuần
                  </h2>
                  <p className="mt-1 text-label text-muted">
                    Chọn ngày, thời lượng và sách dự định đọc. Tiến độ được tính
                    từ các buổi đọc hợp lệ của bé.
                  </p>
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditingPlanId("");
                  setActiveForm("plan");
                }}
              >
                Thêm kế hoạch
              </Button>

              {plans.length === 0 ? (
                <div className="mt-5 rounded-card bg-canvas p-5 text-center">
                  <CalendarDays className="mx-auto size-8 text-primary" />
                  <p className="mt-2 font-semibold text-ink">
                    Chưa có kế hoạch đọc tuần
                  </p>
                  <p className="mt-1 text-label text-muted">
                    Tạo lịch đọc phù hợp với thời gian của gia đình.
                  </p>
                </div>
              ) : (
                <div className="mt-5 grid gap-4">
                  {plans.map((plan) => (
                    <article
                      key={plan.id}
                      className="rounded-card border border-border bg-canvas p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-ink">
                            {plan.title}
                          </h3>
                          <p className="mt-1 text-label text-muted">
                            {plan.weekdays
                              .map(
                                (day) =>
                                  weekdayOptions.find(
                                    (option) => option.value === day,
                                  )?.label,
                              )
                              .join(", ")}{" "}
                            · {plan.target_minutes} phút mỗi buổi
                          </p>
                          {plan.book_title ? (
                            <p className="mt-1 text-label text-muted">
                              Sách: {plan.book_title}
                            </p>
                          ) : null}
                        </div>
                        <span className="rounded-full bg-white px-3 py-1 text-label font-semibold text-primary">
                          {planStatusText(plan.status)}
                        </span>
                      </div>
                      <div className="mt-4 flex items-center justify-between gap-3 text-label">
                        <span>Ngày đọc hoàn thành trong tuần này</span>
                        <strong>
                          {plan.completed_days_this_week}/
                          {plan.scheduled_days_this_week}
                        </strong>
                      </div>
                      <div className="mt-2 h-3 overflow-hidden rounded-full bg-white">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-200"
                          style={{
                            width: `${Math.min(100, plan.progress_percent)}%`,
                          }}
                        />
                      </div>
                      <p className="mt-1 text-right text-label font-semibold text-primary">
                        {plan.progress_percent}%
                      </p>
                      <PlanInsights plan={plan} />
                      {plan.status === "ACTIVE" || plan.status === "PAUSED" ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="quiet"
                            size="compact"
                            className="w-auto border border-border"
                            onClick={() => {
                              setActiveForm("plan");
                              setEditingPlanId(plan.id);
                              setPlanTitle(plan.title);
                              setPlanBookId(plan.book_id ?? "");
                              setPlanMinutes(String(plan.target_minutes));
                              setPlanDays(plan.weekdays);
                              setPlanStart(plan.starts_on);
                              setPlanEnd(plan.ends_on ?? "");
                              setPlanTimezone(plan.timezone);
                            }}
                          >
                            Chỉnh sửa
                          </Button>
                          {plan.status === "ACTIVE" ? (
                            <Button
                              variant="quiet"
                              size="compact"
                              className="w-auto bg-cream"
                              disabled={Boolean(busyKey)}
                              onClick={() =>
                                void transitionPlan(plan, "PAUSED")
                              }
                            >
                              Tạm dừng
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              size="compact"
                              className="w-auto"
                              disabled={Boolean(busyKey)}
                              onClick={() =>
                                void transitionPlan(plan, "ACTIVE")
                              }
                            >
                              Tiếp tục
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="compact"
                            className="w-auto"
                            disabled={Boolean(busyKey)}
                            onClick={() =>
                              void transitionPlan(plan, "COMPLETED")
                            }
                          >
                            <CheckCircle2 className="size-4" /> Hoàn thành
                          </Button>
                          <Button
                            variant="quiet"
                            size="compact"
                            className="w-auto border border-border text-muted"
                            disabled={Boolean(busyKey)}
                            onClick={() => void transitionPlan(plan, "ENDED")}
                          >
                            Kết thúc
                          </Button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6">
              <div className="mb-4 flex items-center gap-3">
                <Target className="size-6 text-primary" />
                <h2 className="text-2xl font-extrabold text-ink">
                  Mục tiêu đọc
                </h2>
              </div>
              <Button variant="secondary" onClick={() => setActiveForm("goal")}>
                Thêm mục tiêu
              </Button>

              {goals.length === 0 ? (
                <p className="mt-5 rounded-control bg-canvas p-4 text-label text-muted">
                  Bé chưa có mục tiêu đọc nào.
                </p>
              ) : (
                <div className="mt-5 grid gap-4">
                  {goals.map((goal) => (
                    <article
                      key={goal.id}
                      className="rounded-card border border-border p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="font-semibold text-ink">
                          {goal.target_value}{" "}
                          {goal.metric === "MINUTES" ? "phút" : "buổi"} ·{" "}
                          {goal.period === "DAILY" ? "mỗi ngày" : "mỗi tuần"}
                        </h3>
                        <span className="rounded-full bg-sky px-3 py-1 text-label font-semibold text-primary">
                          {statusText(goal.status)}
                        </span>
                      </div>
                      <p className="mt-2 text-label text-muted">
                        Từ {goal.starts_on}
                        {goal.ends_on ? " đến " + goal.ends_on : ""} ·{" "}
                        {goal.timezone}
                      </p>
                      <div className="mt-4 flex items-center justify-between text-label">
                        <span>Tiến độ chu kỳ hiện tại</span>
                        <strong>
                          {goal.current_value}/{goal.target_value}
                        </strong>
                      </div>
                      <div className="mt-2 h-3 overflow-hidden rounded-full bg-canvas">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-200"
                          style={{ width: String(goal.progress_percent) + "%" }}
                        />
                      </div>
                      <p className="mt-1 text-right text-label font-semibold text-primary">
                        {goal.progress_percent}%
                      </p>
                      <GoalInsights goal={goal} />
                      {editingGoalId === goal.id ? (
                        <div className="mt-3 flex gap-2">
                          <input
                            aria-label="Giá trị mục tiêu mới"
                            className={inputClass + " w-28"}
                            type="number"
                            min={1}
                            value={editingTarget}
                            onChange={(e) => setEditingTarget(e.target.value)}
                          />
                          <Button
                            onClick={() => void saveEditedGoal(goal)}
                            disabled={Boolean(busyKey)}
                          >
                            Lưu
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setEditingGoalId("")}
                          >
                            Hủy
                          </Button>
                        </div>
                      ) : null}
                      {goal.status === "ACTIVE" || goal.status === "PAUSED" ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="quiet"
                            size="compact"
                            className="w-auto border border-border"
                            onClick={() => {
                              setEditingGoalId(goal.id);
                              setEditingTarget(String(goal.target_value));
                            }}
                          >
                            Sửa mục tiêu
                          </Button>
                          {goal.status === "ACTIVE" ? (
                            <Button
                              variant="quiet"
                              size="compact"
                              className="w-auto bg-cream"
                              disabled={Boolean(busyKey)}
                              onClick={() => void transition(goal, "PAUSED")}
                            >
                              Tạm dừng
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              size="compact"
                              className="w-auto"
                              disabled={Boolean(busyKey)}
                              onClick={() => void transition(goal, "ACTIVE")}
                            >
                              Tiếp tục
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="compact"
                            className="w-auto"
                            disabled={Boolean(busyKey)}
                            onClick={() => void transition(goal, "COMPLETED")}
                          >
                            Hoàn thành
                          </Button>
                          <Button
                            variant="quiet"
                            size="compact"
                            className="w-auto border border-border text-muted"
                            disabled={Boolean(busyKey)}
                            onClick={() => void transition(goal, "ENDED")}
                          >
                            Kết thúc
                          </Button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
              <p className="mt-4 text-xs text-muted">
                Tiến độ chỉ tính phiên đã hoàn tất với thời điểm bắt đầu/kết
                thúc hợp lệ. Mục tiêu không tự hoàn thành chỉ vì đạt 100%.
              </p>
            </section>

            <section className="min-w-0 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6">
              <div className="mb-4 flex items-center gap-3">
                <BookHeart className="size-6 text-primary" />
                <h2 className="text-2xl font-extrabold text-ink">
                  Sách yêu thích và danh sách muốn đọc
                </h2>
              </div>
              <p className="mb-4 text-label text-muted">
                Các cuốn sách bé yêu thích hoặc muốn đọc. Sách ngừng hoạt động
                vẫn có thể bỏ lưu.
              </p>
              <p className="mb-3 text-sm text-muted">
                Yêu thích {favorites.length} · Muốn đọc {readingList.length}
              </p>
              {collections.length === 0 ? (
                <p className="rounded-control bg-canvas p-4 text-label text-muted">
                  Chưa lưu cuốn sách nào.
                </p>
              ) : (
                <table className="w-full border-collapse text-left text-label">
                  <thead className="hidden bg-sky text-primary-hover sm:table-header-group">
                    <tr>
                      <th className="p-4">Sách</th>
                      <th className="p-4">Danh sách</th>
                      <th className="p-4">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collections.map((entry) => (
                      <tr
                        key={entry.id}
                        className="flex flex-col gap-2 border-b border-border py-4 sm:table-row sm:py-0"
                      >
                        <td className="min-w-0 break-words sm:p-4">
                          <strong className="font-bold text-ink">
                            {entry.book.title}
                          </strong>
                          {entry.book.lifecycle_status === "RETIRED" ? (
                            <span className="mt-1 block text-sm text-muted">
                              Không còn khả dụng để đọc
                            </span>
                          ) : null}
                        </td>
                        <td className="text-muted sm:p-4">
                          {entry.collection_type === "FAVORITE"
                            ? "Yêu thích"
                            : "Muốn đọc"}
                        </td>
                        <td className="sm:p-4">
                          <div className="flex flex-wrap gap-3">
                            {entry.book.lifecycle_status === "ACTIVE" ? (
                              <Link
                                className="inline-flex min-h-11 items-center font-bold text-primary hover:underline"
                                href={`/books/${encodeURIComponent(entry.book_id)}?childId=${encodeURIComponent(childId)}`}
                              >
                                Mở sách
                              </Link>
                            ) : null}
                            <Button
                              variant="quiet"
                              size="compact"
                              className="w-auto text-primary"
                              disabled={Boolean(busyKey)}
                              onClick={() =>
                                void toggleCollection(
                                  entry.book_id,
                                  entry.collection_type,
                                )
                              }
                            >
                              <Trash2 aria-hidden="true" className="size-4" />
                              Bỏ lưu
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <VerifiedBookPicker
                key={childId}
                books={books}
                busy={Boolean(busyKey) || isReadingDataLoading}
                childId={childId}
                collections={collections}
                onReload={() => setReloadKey((key) => key + 1)}
                onToggle={(bookId, type) => void toggleCollection(bookId, type)}
              />
            </section>

            <section className="min-w-0 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6">
              <div className="mb-4 flex items-center gap-3">
                <CalendarClock className="size-6 text-primary" />
                <h2 className="text-2xl font-extrabold text-ink">
                  Lịch nhắc đọc
                </h2>
              </div>
              <p className="mb-4 text-label text-muted">
                Lịch được lưu theo múi giờ đã chọn. Khi bật email, máy chủ sẽ
                gửi lời nhắc đến địa chỉ đã xác minh của tài khoản phụ huynh.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditingReminderId("");
                  setActiveForm("reminder");
                }}
              >
                Thêm lịch nhắc
              </Button>

              {due.length > 0 ? (
                <div className="mt-5 rounded-card border border-border bg-cream p-4">
                  <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
                    <BellRing className="size-5" />
                    Đến giờ đọc sách
                  </h3>
                  <ul className="space-y-2">
                    {due.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-white p-3"
                      >
                        <span className="text-label text-ink">
                          Lịch nhắc lúc{" "}
                          {item.reminder
                            ? clock(item.reminder.remind_at)
                            : new Date(item.scheduled_for).toLocaleTimeString(
                                [],
                                { hour: "2-digit", minute: "2-digit" },
                              )}{" "}
                          · {item.scheduled_local_date}
                        </span>
                        {item.email_status !== "NOT_REQUESTED" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-3 py-1 text-sm font-semibold text-primary">
                            <Mail className="size-4" />{" "}
                            {item.email_error_code === "PARENT_EMAIL_UNVERIFIED"
                              ? "Email phụ huynh chưa xác minh"
                              : emailStatusText(item.email_status)}
                          </span>
                        ) : null}
                        <Button
                          variant="secondary"
                          size="compact"
                          className="w-auto"
                          disabled={Boolean(busyKey)}
                          onClick={() =>
                            void runAction(
                              "due-" + item.id,
                              () => service.acknowledgeOccurrence(item.id),
                              "Đã ghi nhận lời nhắc.",
                            )
                          }
                        >
                          <Check className="size-4" />
                          Đã xem
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {reminders.length === 0 ? (
                <p className="mt-5 rounded-control bg-canvas p-4 text-label text-muted">
                  Chưa có lịch nhắc nào.
                </p>
              ) : (
                <div className="mt-5 grid gap-3">
                  {reminders.map((reminder) => (
                    <article
                      key={reminder.id}
                      className="rounded-card border border-border p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="flex items-center gap-2 font-semibold text-ink">
                            <Clock3 className="size-5 text-primary" />
                            {clock(reminder.remind_at)}
                          </h3>
                          <p className="mt-1 text-label text-muted">
                            {reminder.weekdays
                              .map(
                                (day) =>
                                  weekdayOptions.find(
                                    (option) => option.value === day,
                                  )?.label,
                              )
                              .join(", ")}{" "}
                            · {reminder.timezone}
                          </p>
                          <p className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                            <Mail className="size-4" />
                            {reminder.email_enabled
                              ? "Có gửi email nhắc"
                              : "Chỉ nhắc trong ứng dụng"}
                          </p>
                        </div>
                        <label className="flex items-center gap-2 text-label font-semibold">
                          <input
                            type="checkbox"
                            checked={reminder.is_active}
                            disabled={Boolean(busyKey)}
                            onChange={(e) =>
                              void runAction(
                                "reminder-toggle-" + reminder.id,
                                () =>
                                  service.updateReminder(reminder.id, {
                                    is_active: e.target.checked,
                                  }),
                                e.target.checked
                                  ? "Đã bật lịch nhắc."
                                  : "Đã tắt lịch nhắc.",
                              )
                            }
                          />
                          Đang bật
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="quiet"
                          size="compact"
                          className="w-auto border border-border"
                          onClick={() => {
                            setEditingReminderId(reminder.id);
                            setActiveForm("reminder");
                            setReminderTime(clock(reminder.remind_at));
                            setReminderDays(reminder.weekdays);
                            setReminderTimezone(reminder.timezone);
                            setReminderEmailEnabled(reminder.email_enabled);
                          }}
                        >
                          Chỉnh sửa
                        </Button>
                        <Button
                          variant="quiet"
                          size="compact"
                          className="w-auto border border-border text-danger"
                          disabled={Boolean(busyKey)}
                          onClick={() =>
                            void (
                              window.confirm(
                                "Xóa lịch nhắc này? Các lần gửi trong tương lai sẽ bị hủy.",
                              ) &&
                              runAction(
                                "reminder-delete-" + reminder.id,
                                () => service.deleteReminder(reminder.id),
                                "Đã xóa lịch nhắc.",
                              )
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                          Xóa
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
