"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { VerifiedBookPicker } from "./verified-book-picker";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
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

const PLANS_PAGE_SIZE = 4;
const GOALS_PAGE_SIZE = 4;
const COLLECTIONS_PAGE_SIZE = 5;
const REMINDERS_PAGE_SIZE = 5;
const DUE_PAGE_SIZE = 5;

const weekdayOptions = [
  { key: "mon", value: 0 },
  { key: "tue", value: 1 },
  { key: "wed", value: 2 },
  { key: "thu", value: 3 },
  { key: "fri", value: 4 },
  { key: "sat", value: 5 },
  { key: "sun", value: 6 },
] as const;
const inputClass =
  "min-h-12 min-w-0 w-full rounded-control border border-border bg-white px-3 text-label text-ink focus-visible:outline-3 focus-visible:outline-primary";
const labelClass =
  "flex min-w-0 flex-col gap-1 text-label font-semibold text-ink";
const actionClass =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control px-2.5 py-1.5 text-sm font-semibold sm:gap-2 sm:px-3 sm:py-2 sm:text-label";

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
function clock(value: string): string {
  return value.slice(0, 5);
}

interface Props {
  requestedChildId?: string;
}

export function ReadingManagementScreen({ requestedChildId }: Props) {
  const { formatTime } = useI18n();
  const t = useTranslations("reports");
  const childService = useChildService();
  const bookService = useBookService();
  const service = useReadingManagementService();
  const statusText = (status: ReadingGoalStatus) =>
    t(`readingManagement.goalStatus.${status}`);
  const planStatusText = (status: ReadingPlanStatus) =>
    t(`readingManagement.planStatus.${status}`);
  const emailStatusText = (status: ReadingReminderEmailStatus) =>
    t(`readingManagement.deliveryStatus.${status}`);
  const formatWeekdaysFull = (weekdays: number[]) =>
    weekdays
      .map((day) => {
        const option = weekdayOptions.find((item) => item.value === day);
        return option ? t(`readingManagement.weekdaysShort.${option.key}`) : "";
      })
      .filter(Boolean)
      .join(", ");
  const formatReminderSchedule = (weekdays: number[]) => {
    const uniqueDays = new Set(weekdays);
    const hasZeroToSix = [0, 1, 2, 3, 4, 5, 6].every((day) =>
      uniqueDays.has(day),
    );
    const hasOneToSeven = [1, 2, 3, 4, 5, 6, 7].every((day) =>
      uniqueDays.has(day),
    );
    if (hasZeroToSix || hasOneToSeven) {
      return t("readingManagement.dailyFrequency");
    }
    const hasWeekdaysOnly =
      uniqueDays.size === 5 &&
      [0, 1, 2, 3, 4].every((day) => uniqueDays.has(day));
    if (hasWeekdaysOnly) {
      return t("readingManagement.weekdaysRangeMonFri");
    }
    return formatWeekdaysFull(weekdays);
  };
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
  const [plansPage, setPlansPage] = useState(1);
  const [goalsPage, setGoalsPage] = useState(1);
  const [collectionsPage, setCollectionsPage] = useState(1);
  const [collectionFilter, setCollectionFilter] = useState<
    "ALL" | BookCollectionType
  >("ALL");
  const [remindersPage, setRemindersPage] = useState(1);
  const [duePage, setDuePage] = useState(1);
  const requestIdRef = useRef(0);

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
  const filteredCollections = useMemo(
    () =>
      collectionFilter === "ALL"
        ? collections
        : collections.filter(
            (entry) => entry.collection_type === collectionFilter,
          ),
    [collectionFilter, collections],
  );
  const plansTotalPages = Math.max(
    1,
    Math.ceil(plans.length / PLANS_PAGE_SIZE),
  );
  const safePlansPage = Math.min(plansPage, plansTotalPages);
  const visiblePlans = plans.slice(
    (safePlansPage - 1) * PLANS_PAGE_SIZE,
    safePlansPage * PLANS_PAGE_SIZE,
  );
  const goalsTotalPages = Math.max(
    1,
    Math.ceil(goals.length / GOALS_PAGE_SIZE),
  );
  const safeGoalsPage = Math.min(goalsPage, goalsTotalPages);
  const visibleGoals = goals.slice(
    (safeGoalsPage - 1) * GOALS_PAGE_SIZE,
    safeGoalsPage * GOALS_PAGE_SIZE,
  );
  const collectionsTotalPages = Math.max(
    1,
    Math.ceil(filteredCollections.length / COLLECTIONS_PAGE_SIZE),
  );
  const safeCollectionsPage = Math.min(collectionsPage, collectionsTotalPages);
  const visibleCollections = filteredCollections.slice(
    (safeCollectionsPage - 1) * COLLECTIONS_PAGE_SIZE,
    safeCollectionsPage * COLLECTIONS_PAGE_SIZE,
  );
  const remindersTotalPages = Math.max(
    1,
    Math.ceil(reminders.length / REMINDERS_PAGE_SIZE),
  );
  const safeRemindersPage = Math.min(remindersPage, remindersTotalPages);
  const visibleReminders = reminders.slice(
    (safeRemindersPage - 1) * REMINDERS_PAGE_SIZE,
    safeRemindersPage * REMINDERS_PAGE_SIZE,
  );
  const dueTotalPages = Math.max(1, Math.ceil(due.length / DUE_PAGE_SIZE));
  const safeDuePage = Math.min(duePage, dueTotalPages);
  const visibleDue = due.slice(
    (safeDuePage - 1) * DUE_PAGE_SIZE,
    safeDuePage * DUE_PAGE_SIZE,
  );

  function handleSelectChild(nextChildId: string) {
    if (nextChildId === childId) return;
    requestIdRef.current += 1;
    setChildId(nextChildId);
    setGoals([]);
    setPlans([]);
    setCollections([]);
    setReminders([]);
    setDue([]);
    setBooks([]);
    setActiveForm(null);
    setEditingGoalId("");
    setEditingPlanId("");
    setEditingReminderId("");
    setError("");
    setSuccess("");
    setPlansPage(1);
    setGoalsPage(1);
    setCollectionsPage(1);
    setCollectionFilter("ALL");
    setRemindersPage(1);
    setDuePage(1);
  }

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
        if (active) setError(t("readingManagement.loadChildFailed"));
      })
      .finally(() => {
        if (active) setLoadingChildren(false);
      });
    return () => {
      active = false;
    };
  }, [childService, requestedChildId, t]);

  useEffect(() => {
    if (!childId) {
      return;
    }
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    Promise.all([
      service.listGoals(childId, controller.signal),
      service.listPlans(childId, controller.signal),
      service.listCollections(childId, controller.signal),
      service.listReminders(childId, controller.signal),
      bookService
        .list({ grade: selectedChild?.grade, include_private: true })
        .catch(() => null),
      service.dueReminders(childId, controller.signal).catch(() => []),
    ])
      .then(
        ([goalRows, planRows, savedRows, reminderRows, bookRows, dueRows]) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) {
            return;
          }
          setError("");
          setGoals(goalRows);
          setPlans(planRows);
          setCollections(savedRows);
          setReminders(reminderRows);
          setBooks(bookRows);
          setDue(dueRows);
          setLoadedRequestKey(currentRequestKey);
        },
      )
      .catch(() => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          return;
        }
        setError(t("readingManagement.loadManagementFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === requestIdRef.current) {
          setSettledRequestKey(currentRequestKey);
        }
      });
    return () => {
      requestIdRef.current += 1;
      controller.abort();
    };
  }, [
    bookService,
    childId,
    currentRequestKey,
    reloadKey,
    selectedChild?.grade,
    service,
    t,
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
        conflictMessage(failure) ?? t("readingManagement.mutationUnconfirmed"),
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
      setError(t("readingManagement.validation.goalPositiveInt"));
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
      t("readingManagement.notices.goalSaved"),
    );
  }

  async function transition(goal: ReadingGoalDTO, next: ReadingGoalStatus) {
    if (
      next === "ENDED" &&
      !window.confirm(t("readingManagement.notices.goalEndConfirm"))
    )
      return;
    await runAction(
      "goal-" + goal.id,
      () => service.transitionGoal(goal.id, next),
      t("readingManagement.notices.goalStatusUpdated"),
    );
  }
  async function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId || planDays.length === 0) {
      setError(t("readingManagement.validation.selectReadingDay"));
      return;
    }
    const targetMinutes = Number(planMinutes);
    if (
      !Number.isInteger(targetMinutes) ||
      targetMinutes < 5 ||
      targetMinutes > 240
    ) {
      setError(t("readingManagement.validation.minutesRange"));
      return;
    }
    const title = planTitle.trim();
    if (!title) {
      setError(t("readingManagement.validation.planNameRequired"));
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
          t("readingManagement.notices.planUpdated"),
        )
      : await runAction(
          "plan-create",
          () =>
            service.createPlan({
              child_id: childId,
              starts_on: planStart,
              ...values,
            }),
          t("readingManagement.notices.planCreated"),
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
      !window.confirm(t("readingManagement.notices.planEndConfirm"))
    )
      return;
    const messages: Record<ReadingPlanStatus, string> = {
      ACTIVE: t("readingManagement.notices.planActive"),
      PAUSED: t("readingManagement.notices.planPaused"),
      COMPLETED: t("readingManagement.notices.planCompleted"),
      ENDED: t("readingManagement.notices.planEnded"),
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
      setError(t("readingManagement.validation.targetPositiveInt"));
      return;
    }
    await runAction(
      "goal-edit-" + goal.id,
      () => service.updateGoal(goal.id, { target_value: target }),
      t("readingManagement.notices.goalTargetUpdated"),
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
      existing
        ? t("readingManagement.notices.bookRemoved")
        : t("readingManagement.notices.bookSaved"),
    );
  }
  async function submitReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!childId || reminderDays.length === 0) {
      setError(t("readingManagement.validation.selectReminderDay"));
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
        t("readingManagement.notices.reminderUpdated"),
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
        t("readingManagement.notices.reminderCreated"),
      );
      if (saved) setReminderEmailEnabled(false);
    }
  }
  if (activeForm) {
    const titles = {
      plan: editingPlanId
        ? t("readingManagement.modal.editPlanTitle")
        : t("readingManagement.modal.createPlanTitle"),
      goal: t("readingManagement.modal.goalTitle"),
      reminder: editingReminderId
        ? t("readingManagement.modal.editReminderTitle")
        : t("readingManagement.modal.createReminderTitle"),
    };
    const descriptions = {
      plan: t("readingManagement.modal.planSubtitle"),
      goal: t("readingManagement.modal.goalSubtitle"),
      reminder: t("readingManagement.modal.reminderSubtitle"),
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
              <StatusMessage
                title={t("readingManagement.errorTitle")}
                tone="error"
              >
                {error}
              </StatusMessage>
            ) : null}
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitPlan}>
              <label className={labelClass}>
                {t("readingManagement.modal.planNameLabel")}
                <input
                  className={inputClass}
                  maxLength={100}
                  required
                  value={planTitle}
                  onChange={(event) => setPlanTitle(event.target.value)}
                  placeholder={t("readingManagement.modal.planNamePlaceholder")}
                />
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.planBookLabel")}
                <select
                  className={inputClass}
                  value={planBookId}
                  onChange={(event) => setPlanBookId(event.target.value)}
                >
                  <option value="">
                    {t("readingManagement.modal.planNoBookOption")}
                  </option>
                  {(books ?? []).map((book) => (
                    <option dir="ltr" key={book.id} value={book.id}>
                      {book.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.planMinutesLabel")}
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
                {t("readingManagement.modal.timezoneLabel")}
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
                  {t("readingManagement.modal.readingDaysLabel")}
                </legend>
                <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
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
                      {t(`readingManagement.weekdaysShort.${day.key}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={labelClass}>
                {t("readingManagement.modal.startFromLabel")}
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
                {t("readingManagement.modal.endOptionalLabel")}
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
                  {editingPlanId
                    ? t("readingManagement.modal.savePlan")
                    : t("readingManagement.modal.createPlan")}
                </Button>
                {editingPlanId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditingPlanId("")}
                  >
                    {t("readingManagement.modal.cancelEdit")}
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        ) : activeForm === "goal" ? (
          <>
            {error ? (
              <StatusMessage
                title={t("readingManagement.errorTitle")}
                tone="error"
              >
                {error}
              </StatusMessage>
            ) : null}
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitGoal}>
              <label className={labelClass}>
                {t("readingManagement.modal.metricLabel")}
                <select
                  className={inputClass}
                  value={goalMetric}
                  onChange={(e) =>
                    setGoalMetric(e.target.value as ReadingGoalMetric)
                  }
                >
                  <option value="MINUTES">
                    {t("readingManagement.modal.metricMinutes")}
                  </option>
                  <option value="SESSIONS">
                    {t("readingManagement.modal.metricSessions")}
                  </option>
                </select>
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.targetValueLabel")}
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
                {t("readingManagement.modal.periodLabel")}
                <select
                  className={inputClass}
                  value={goalPeriod}
                  onChange={(e) =>
                    setGoalPeriod(e.target.value as ReadingGoalPeriod)
                  }
                >
                  <option value="DAILY">
                    {t("readingManagement.modal.periodDaily")}
                  </option>
                  <option value="WEEKLY">
                    {t("readingManagement.modal.periodWeekly")}
                  </option>
                </select>
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.startLabel")}
                <input
                  className={inputClass}
                  type="date"
                  required
                  value={goalStart}
                  onChange={(e) => setGoalStart(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.endOptionalLabel")}
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
                  {t("readingManagement.modal.createGoal")}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            {error ? (
              <StatusMessage
                title={t("readingManagement.errorTitle")}
                tone="error"
              >
                {error}
              </StatusMessage>
            ) : null}
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={submitReminder}
            >
              <label className={labelClass}>
                {t("readingManagement.modal.localTimeLabel")}
                <input
                  className={inputClass}
                  type="time"
                  required
                  value={reminderTime}
                  onChange={(e) => setReminderTime(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                {t("readingManagement.modal.ianaTimezoneLabel")}
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
                  {t("readingManagement.modal.repeatDaysLabel")}
                </legend>
                <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
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
                      {t(`readingManagement.weekdaysShort.${day.key}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="min-w-0 rounded-control border border-border bg-canvas p-3 sm:col-span-2">
                <legend className="px-1 text-label font-semibold text-ink">
                  {t("readingManagement.modal.emailReminderLabel")}
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
                      <Mail className="size-4 text-primary" />{" "}
                      {t("readingManagement.modal.sendEmailCheck")}
                    </span>
                    <span className="mt-1 block text-sm text-muted">
                      {t("readingManagement.modal.emailDestinationNote")}
                    </span>
                  </span>
                </label>
              </fieldset>
              <div className="flex min-w-0 flex-wrap items-end gap-2 sm:col-span-2">
                <Button type="submit" disabled={Boolean(busyKey)}>
                  {editingReminderId
                    ? t("readingManagement.modal.saveChanges")
                    : t("readingManagement.modal.createReminder")}
                </Button>
                {editingReminderId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditingReminderId("")}
                  >
                    {t("readingManagement.modal.cancelEdit")}
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
        {t("readingManagement.loadingChild")}
      </section>
    );

  return (
    <section className="reading-organizer mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-24 sm:gap-4 sm:pb-4">
      <header className="flex flex-wrap items-center justify-between gap-2.5 max-sm:pb-3! sm:items-end sm:gap-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-extrabold leading-tight text-ink sm:text-heading">
            {t("readingManagement.heading")}
          </h1>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted sm:mt-1.5 sm:text-body sm:leading-6">
            {t("readingManagement.headingSubtitle")}
          </p>
        </div>
        <Button
          onClick={() => setReloadKey((value) => value + 1)}
          size="compact"
          className="min-h-10! px-3! py-1.5! text-xs! sm:w-auto sm:px-4! sm:py-2! sm:text-sm!"
          fullWidth={false}
          variant="secondary"
          disabled={isReadingDataLoading || !childId}
        >
          <RefreshCw aria-hidden="true" className="size-4" />{" "}
          {t("readingManagement.reload")}
        </Button>
      </header>

      <div className="grid gap-2.5 sm:gap-4 md:grid-cols-2">
        <label
          className="flex min-h-[64px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-3 py-2.5 text-label text-muted shadow-xs sm:min-h-[72px] sm:px-4 sm:py-3"
          htmlFor="management-child"
        >
          {t("readingManagement.childProfileLabel")}
          <select
            id="management-child"
            className="min-h-6 w-full min-w-0 bg-white text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
            value={childId}
            onChange={(event) => handleSelectChild(event.target.value)}
          >
            {children.map((child) => (
              <option key={child.id} value={child.id}>
                {child.alias} ·{" "}
                {t("readingManagement.bookPicker.gradeSingle", {
                  grade: child.grade,
                })}
              </option>
            ))}
          </select>
        </label>
        {selectedChild ? (
          <dl>
            <InformationField label={t("readingManagement.viewingLabel")}>
              {selectedChild.alias} ·{" "}
              {t("readingManagement.bookPicker.gradeSingle", {
                grade: selectedChild.grade,
              })}
            </InformationField>
          </dl>
        ) : null}
      </div>
      {error && !activeForm ? (
        <StatusMessage title={t("readingManagement.errorTitle")} tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {success ? (
        <StatusMessage title={t("readingManagement.savedTitle")} tone="success">
          {success}
        </StatusMessage>
      ) : null}
      {!childId && !isReadingDataLoading ? (
        <EmptyState
          icon={<Target className="size-9" />}
          title={t("readingManagement.noChildTitle")}
          description={t("readingManagement.noChildDesc")}
        />
      ) : null}
      {isReadingDataLoading && childId ? (
        <p role="status" aria-live="polite">
          {t("readingManagement.loadingChildData")}
        </p>
      ) : null}

      {hasReadingData ? (
        <>
          <section
            aria-label={t("readingManagement.overviewAria")}
            className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4"
          >
            {[
              {
                label: t("readingManagement.summaryRunningGoals"),
                value: goals.filter(isRunningGoal).length,
                detail: t("readingManagement.summaryRunningGoalsDetail"),
                icon: <Target className="size-4.5" />,
              },
              {
                label: t("readingManagement.summaryActivePlans"),
                value: plans.filter(isRunningPlan).length,
                detail: t("readingManagement.summaryActivePlansDetail"),
                icon: <CalendarDays className="size-4.5" />,
              },
              {
                label: t("readingManagement.summaryEnabledReminders"),
                value: reminders.filter((reminder) => reminder.is_active)
                  .length,
                detail: t("readingManagement.summaryEnabledRemindersDetail"),
                icon: <BellRing className="size-4.5" />,
              },
              {
                label: t("readingManagement.summarySavedBooks"),
                value: collections.length,
                detail: t("readingManagement.summarySavedBooksDetail"),
                icon: <BookHeart className="size-4.5" />,
              },
            ].map((item) => (
              <article
                key={item.label}
                className="rounded-card border border-border bg-white p-3 shadow-xs transition hover:border-primary/40 sm:p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold text-muted sm:text-sm">
                    {item.label}
                  </p>
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-xl bg-sky/60 p-1.5 text-primary sm:p-2"
                  >
                    {item.icon}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-extrabold tabular-nums text-primary sm:mt-2 sm:text-heading">
                  {item.value}
                </p>
                <p className="mt-0.5 text-[11px] text-muted sm:text-xs">
                  {item.detail}
                </p>
              </article>
            ))}
          </section>

          <details className="rounded-control border border-border bg-white px-3.5 py-2.5 shadow-xs transition hover:border-primary/40 sm:px-4 sm:py-3">
            <summary className="flex min-h-10 cursor-pointer items-center font-bold text-primary">
              {t("readingManagement.todayTitle", {
                childName: t("readingManagement.todayDefaultChild"),
              })}
            </summary>
            <TodaySummary
              childName={
                selectedChild?.alias ?? t("readingManagement.todayDefaultChild")
              }
              plans={plans}
              goals={goals}
            />
          </details>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2 lg:items-start">
            <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
              <section
                aria-label={t("readingManagement.plansSectionAria")}
                className="min-w-0 rounded-card border border-border bg-white p-3.5 shadow-xs sm:px-5 sm:py-5"
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <div
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 rounded-xl bg-sky/70 p-2 text-primary"
                    >
                      <CalendarDays className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="min-w-0 text-lg font-extrabold leading-snug text-ink sm:text-xl">
                          {t("readingManagement.plansTitle")}
                        </h2>
                        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
                          {plans.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {t("readingManagement.plansSubtitle")}
                      </p>
                    </div>
                  </div>
                  <Button
                    fullWidth={false}
                    size="compact"
                    variant="secondary"
                    className="min-h-10! shrink-0 px-3! py-1.5! text-xs! sm:min-h-9!"
                    onClick={() => {
                      setEditingPlanId("");
                      setActiveForm("plan");
                    }}
                  >
                    {t("readingManagement.addPlan")}
                  </Button>
                </div>

                {plans.length === 0 ? (
                  <div className="mt-3 rounded-control border border-dashed border-border/80 bg-canvas/50 px-4 py-4 text-center">
                    <CalendarDays
                      aria-hidden="true"
                      className="mx-auto size-7 text-primary/80"
                    />
                    <p className="mt-1.5 text-sm font-semibold text-ink">
                      {t("readingManagement.plansEmptyTitle")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {t("readingManagement.plansEmptyDesc")}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mt-3 grid gap-3">
                      {visiblePlans.map((plan) => (
                        <article
                          key={plan.id}
                          data-plan-id={plan.id}
                          className="min-w-0 rounded-card border border-border bg-canvas/50 p-3.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <h3 className="break-words font-semibold text-ink">
                                {plan.title}
                              </h3>
                              <p className="mt-0.5 text-sm text-muted">
                                {formatWeekdaysFull(plan.weekdays)} ·{" "}
                                {t("readingManagement.planMinutesPerSession", {
                                  minutes: plan.target_minutes,
                                })}
                              </p>
                              {plan.book_title ? (
                                <p className="mt-0.5 break-words text-sm text-muted">
                                  {t("readingManagement.bookPrefix", {
                                    title: "",
                                  }).trimEnd()}{" "}
                                  <span
                                    className="viread-learning-content"
                                    dir="ltr"
                                    lang="vi"
                                  >
                                    {plan.book_title}
                                  </span>
                                </p>
                              ) : null}
                            </div>
                            <span className="shrink-0 rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-primary">
                              {planStatusText(plan.status)}
                            </span>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                            <span>
                              {t("readingManagement.planCompletedDaysLabel")}
                            </span>
                            <strong className="tabular-nums">
                              {plan.completed_days_this_week}/
                              {plan.scheduled_days_this_week}
                            </strong>
                          </div>
                          <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white">
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-200"
                              style={{
                                width: `${Math.min(100, plan.progress_percent)}%`,
                              }}
                            />
                          </div>
                          <p className="mt-1 text-end text-xs font-semibold tabular-nums text-primary">
                            {plan.progress_percent}%
                          </p>
                          <PlanInsights plan={plan} />
                          {plan.status === "ACTIVE" ||
                          plan.status === "PAUSED" ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
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
                                {t("readingManagement.edit")}
                              </Button>
                              {plan.status === "ACTIVE" ? (
                                <Button
                                  variant="quiet"
                                  size="compact"
                                  fullWidth={false}
                                  className="min-h-10! w-auto! border border-border bg-cream px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                  disabled={Boolean(busyKey)}
                                  onClick={() =>
                                    void transitionPlan(plan, "PAUSED")
                                  }
                                >
                                  {t("readingManagement.pause")}
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  size="compact"
                                  fullWidth={false}
                                  className="min-h-10! w-auto! px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                  disabled={Boolean(busyKey)}
                                  onClick={() =>
                                    void transitionPlan(plan, "ACTIVE")
                                  }
                                >
                                  {t("readingManagement.resume")}
                                </Button>
                              )}
                              <Button
                                variant="secondary"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                disabled={Boolean(busyKey)}
                                onClick={() =>
                                  void transitionPlan(plan, "COMPLETED")
                                }
                              >
                                <CheckCircle2
                                  aria-hidden="true"
                                  className="size-3.5"
                                />{" "}
                                {t("readingManagement.complete")}
                              </Button>
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! text-muted sm:min-h-8! sm:px-2.5!"
                                disabled={Boolean(busyKey)}
                                onClick={() =>
                                  void transitionPlan(plan, "ENDED")
                                }
                              >
                                {t("readingManagement.end")}
                              </Button>
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                    <PaginationBar
                      ariaLabel={t("readingManagement.plansPaginationAria")}
                      className="mt-3"
                      compact
                      itemLabel={t("readingManagement.plansPaginationItem")}
                      onPageChange={setPlansPage}
                      page={safePlansPage}
                      pageSize={PLANS_PAGE_SIZE}
                      total={plans.length}
                    />
                  </>
                )}
              </section>

              <section
                aria-label={t("readingManagement.collectionsSectionAria")}
                className="min-w-0 rounded-card border border-border bg-white p-3.5 shadow-xs sm:px-5 sm:py-5"
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <div
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 rounded-xl bg-sky/70 p-2 text-primary"
                    >
                      <BookHeart className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="min-w-0 text-lg font-extrabold leading-snug text-ink sm:text-xl">
                          {t("readingManagement.collectionsTitle")}
                        </h2>
                        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
                          {collections.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {t("readingManagement.collectionsSubtitle")}
                      </p>
                    </div>
                  </div>
                </div>
                <p className="mb-3 text-xs font-medium text-muted">
                  {t("readingManagement.collectionsCountSummary", {
                    favorites: favorites.length,
                    readingList: readingList.length,
                  })}
                </p>
                {collections.length > 0 ? (
                  <div
                    role="group"
                    aria-label={t("readingManagement.collectionsFilterAria")}
                    className="mb-3 flex flex-nowrap gap-1.5 overflow-x-auto pb-0.5 no-scrollbar [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0"
                  >
                    {(
                      [
                        {
                          key: "ALL",
                          label: t("readingManagement.filterAll", {
                            count: collections.length,
                          }),
                        },
                        {
                          key: "FAVORITE",
                          label: t("readingManagement.filterFavorites", {
                            count: favorites.length,
                          }),
                        },
                        {
                          key: "WANT_TO_READ",
                          label: t("readingManagement.filterReadingList", {
                            count: readingList.length,
                          }),
                        },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        aria-pressed={collectionFilter === tab.key}
                        onClick={() => {
                          setCollectionFilter(tab.key);
                          setCollectionsPage(1);
                        }}
                        className={`inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-xs font-bold transition sm:min-h-8 ${
                          collectionFilter === tab.key
                            ? "border-primary bg-sky text-primary-hover"
                            : "border-border bg-white text-ink hover:bg-canvas"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {collections.length === 0 ? (
                  <p className="mt-3 rounded-control border border-dashed border-border/80 bg-canvas/50 px-4 py-4 text-center text-sm text-muted">
                    {t("readingManagement.collectionsEmpty")}
                  </p>
                ) : filteredCollections.length === 0 ? (
                  <p className="mt-3 rounded-control border border-dashed border-border/80 bg-canvas/50 px-4 py-4 text-center text-sm text-muted">
                    {t("readingManagement.collectionsEmptyFiltered")}
                  </p>
                ) : (
                  <>
                    <ul className="divide-y divide-border/70 overflow-hidden rounded-control border border-border bg-canvas/30">
                      {visibleCollections.map((entry) => (
                        <li
                          key={entry.id}
                          data-collection-id={entry.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 transition-colors hover:bg-white/70"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong
                                className="viread-learning-content break-words text-sm font-bold text-ink"
                                dir="ltr"
                                lang="vi"
                              >
                                {entry.book.title}
                              </strong>
                              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-muted">
                                {entry.collection_type === "FAVORITE"
                                  ? t("readingManagement.favorite")
                                  : t("readingManagement.wantToRead")}
                              </span>
                            </div>
                            {entry.book.lifecycle_status === "RETIRED" ? (
                              <span className="mt-0.5 block text-xs text-muted">
                                {t("readingManagement.unavailableToRead")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {entry.book.lifecycle_status === "ACTIVE" ? (
                              <Link
                                className="inline-flex min-h-10 items-center rounded-control px-2.5 text-xs font-bold text-primary hover:bg-sky hover:underline sm:min-h-8 sm:px-2"
                                href={`/books/${encodeURIComponent(entry.book_id)}?childId=${encodeURIComponent(childId)}`}
                              >
                                {t("readingManagement.openBook")}
                              </Link>
                            ) : null}
                            <Button
                              variant="quiet"
                              size="compact"
                              fullWidth={false}
                              className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! text-primary sm:min-h-8! sm:px-2.5!"
                              disabled={Boolean(busyKey)}
                              onClick={() =>
                                void toggleCollection(
                                  entry.book_id,
                                  entry.collection_type,
                                )
                              }
                            >
                              <Trash2 aria-hidden="true" className="size-3.5" />
                              {t("readingManagement.removeBook")}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <PaginationBar
                      ariaLabel={t(
                        "readingManagement.collectionsPaginationAria",
                      )}
                      className="mt-3"
                      compact
                      itemLabel={t(
                        "readingManagement.collectionsPaginationItem",
                      )}
                      onPageChange={setCollectionsPage}
                      page={safeCollectionsPage}
                      pageSize={COLLECTIONS_PAGE_SIZE}
                      total={filteredCollections.length}
                    />
                  </>
                )}
                <VerifiedBookPicker
                  key={childId}
                  books={books}
                  busy={Boolean(busyKey) || isReadingDataLoading}
                  childId={childId}
                  collections={collections}
                  onReload={() => setReloadKey((key) => key + 1)}
                  onToggle={(bookId, type) =>
                    void toggleCollection(bookId, type)
                  }
                />
              </section>
            </div>

            <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
              <section
                aria-label={t("readingManagement.goalsSectionAria")}
                className="min-w-0 rounded-card border border-border bg-white p-3.5 shadow-xs sm:px-5 sm:py-5"
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <div
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 rounded-xl bg-sky/70 p-2 text-primary"
                    >
                      <Target className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="min-w-0 text-lg font-extrabold leading-snug text-ink sm:text-xl">
                          {t("readingManagement.goalsTitle")}
                        </h2>
                        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
                          {goals.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {t("readingManagement.goalsSubtitle")}
                      </p>
                    </div>
                  </div>
                  <Button
                    fullWidth={false}
                    size="compact"
                    variant="secondary"
                    className="min-h-10! shrink-0 px-3! py-1.5! text-xs! sm:min-h-9!"
                    onClick={() => setActiveForm("goal")}
                  >
                    {t("readingManagement.addGoal")}
                  </Button>
                </div>

                {goals.length === 0 ? (
                  <p className="mt-3 rounded-control border border-dashed border-border/80 bg-canvas/50 px-4 py-4 text-center text-sm text-muted">
                    {t("readingManagement.goalsEmpty")}
                  </p>
                ) : (
                  <>
                    <div className="mt-3 grid gap-3">
                      {visibleGoals.map((goal) => (
                        <article
                          key={goal.id}
                          data-goal-id={goal.id}
                          className="min-w-0 rounded-card border border-border bg-canvas/30 p-3.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <h3 className="font-semibold text-ink">
                              {goal.target_value}{" "}
                              {goal.metric === "MINUTES"
                                ? t("readingManagement.unitMinute")
                                : t("readingManagement.unitSession")}{" "}
                              ·{" "}
                              {goal.period === "DAILY"
                                ? t("readingManagement.goalPeriodDaily")
                                : t("readingManagement.goalPeriodWeekly")}
                            </h3>
                            <span className="shrink-0 rounded-full bg-sky px-2.5 py-0.5 text-xs font-semibold text-primary">
                              {statusText(goal.status)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {t("readingManagement.goalDateFrom", {
                              date: goal.starts_on,
                            })}
                            {goal.ends_on
                              ? t("readingManagement.goalDateTo", {
                                  date: goal.ends_on,
                                })
                              : ""}{" "}
                            · {goal.timezone}
                          </p>
                          <div className="mt-3 flex items-center justify-between text-sm">
                            <span>
                              {t("readingManagement.goalCycleProgress")}
                            </span>
                            <strong className="tabular-nums">
                              {goal.current_value}/{goal.target_value}
                            </strong>
                          </div>
                          <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white">
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-200"
                              style={{
                                width: String(goal.progress_percent) + "%",
                              }}
                            />
                          </div>
                          <p className="mt-1 text-end text-xs font-semibold tabular-nums text-primary">
                            {goal.progress_percent}%
                          </p>
                          <GoalInsights goal={goal} />
                          {editingGoalId === goal.id ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <input
                                aria-label={t(
                                  "readingManagement.newTargetValueAria",
                                )}
                                className="min-h-10 w-28 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary sm:min-h-9"
                                type="number"
                                min={1}
                                value={editingTarget}
                                onChange={(e) =>
                                  setEditingTarget(e.target.value)
                                }
                              />
                              <Button
                                fullWidth={false}
                                size="compact"
                                className="min-h-10! w-auto! px-3! py-1.5! text-xs! sm:min-h-9!"
                                onClick={() => void saveEditedGoal(goal)}
                                disabled={Boolean(busyKey)}
                              >
                                {t("readingManagement.save")}
                              </Button>
                              <Button
                                fullWidth={false}
                                size="compact"
                                className="min-h-10! w-auto! px-3! py-1.5! text-xs! sm:min-h-9!"
                                variant="secondary"
                                onClick={() => setEditingGoalId("")}
                              >
                                {t("readingManagement.cancel")}
                              </Button>
                            </div>
                          ) : null}
                          {goal.status === "ACTIVE" ||
                          goal.status === "PAUSED" ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                onClick={() => {
                                  setEditingGoalId(goal.id);
                                  setEditingTarget(String(goal.target_value));
                                }}
                              >
                                {t("readingManagement.editGoal")}
                              </Button>
                              {goal.status === "ACTIVE" ? (
                                <Button
                                  variant="quiet"
                                  size="compact"
                                  fullWidth={false}
                                  className="min-h-10! w-auto! border border-border bg-cream px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                  disabled={Boolean(busyKey)}
                                  onClick={() =>
                                    void transition(goal, "PAUSED")
                                  }
                                >
                                  {t("readingManagement.pause")}
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  size="compact"
                                  fullWidth={false}
                                  className="min-h-10! w-auto! px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                  disabled={Boolean(busyKey)}
                                  onClick={() =>
                                    void transition(goal, "ACTIVE")
                                  }
                                >
                                  {t("readingManagement.resume")}
                                </Button>
                              )}
                              <Button
                                variant="secondary"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                disabled={Boolean(busyKey)}
                                onClick={() =>
                                  void transition(goal, "COMPLETED")
                                }
                              >
                                {t("readingManagement.complete")}
                              </Button>
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! text-muted sm:min-h-8! sm:px-2.5!"
                                disabled={Boolean(busyKey)}
                                onClick={() => void transition(goal, "ENDED")}
                              >
                                {t("readingManagement.end")}
                              </Button>
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                    <PaginationBar
                      ariaLabel={t("readingManagement.goalsPaginationAria")}
                      className="mt-3"
                      compact
                      itemLabel={t("readingManagement.goalsPaginationItem")}
                      onPageChange={setGoalsPage}
                      page={safeGoalsPage}
                      pageSize={GOALS_PAGE_SIZE}
                      total={goals.length}
                    />
                  </>
                )}
                <p className="mt-3 text-xs text-muted">
                  {t("readingManagement.goalsTimezoneRule")}
                </p>
              </section>

              <section
                aria-label={t("readingManagement.remindersSectionAria")}
                className="min-w-0 rounded-card border border-border bg-white p-3.5 shadow-xs sm:px-5 sm:py-5"
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <div
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 rounded-xl bg-sky/70 p-2 text-primary"
                    >
                      <CalendarClock className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="min-w-0 text-lg font-extrabold leading-snug text-ink sm:text-xl">
                          {t("readingManagement.remindersTitle")}
                        </h2>
                        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
                          {reminders.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {t("readingManagement.remindersSubtitle")}
                      </p>
                    </div>
                  </div>
                  <Button
                    fullWidth={false}
                    size="compact"
                    variant="secondary"
                    className="min-h-10! shrink-0 px-3! py-1.5! text-xs! sm:min-h-9!"
                    onClick={() => {
                      setEditingReminderId("");
                      setActiveForm("reminder");
                    }}
                  >
                    {t("readingManagement.addReminder")}
                  </Button>
                </div>

                {due.length > 0 ? (
                  <div className="mt-3 rounded-control border border-border bg-cream p-3">
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-ink">
                      <BellRing
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                      {t("readingManagement.dueRemindersTitle", {
                        count: due.length,
                      })}
                    </h3>
                    <ul className="space-y-1.5">
                      {visibleDue.map((item) => (
                        <li
                          key={item.id}
                          data-due-id={item.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-white px-3 py-2"
                        >
                          <span className="min-w-0 text-sm text-ink">
                            {t("readingManagement.reminderAtPrefix")}
                            {item.reminder
                              ? clock(item.reminder.remind_at)
                              : formatTime(item.scheduled_for, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}{" "}
                            · {item.scheduled_local_date}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            {item.email_status !== "NOT_REQUESTED" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-0.5 text-xs font-semibold text-primary">
                                <Mail aria-hidden="true" className="size-3.5" />{" "}
                                {item.email_error_code ===
                                "PARENT_EMAIL_UNVERIFIED"
                                  ? t("readingManagement.emailUnverifiedLabel")
                                  : emailStatusText(item.email_status)}
                              </span>
                            ) : null}
                            <Button
                              variant="secondary"
                              size="compact"
                              fullWidth={false}
                              className="min-h-10! w-auto! px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                              disabled={Boolean(busyKey)}
                              onClick={() =>
                                void runAction(
                                  "due-" + item.id,
                                  () => service.acknowledgeOccurrence(item.id),
                                  t("readingManagement.notices.reminderAck"),
                                )
                              }
                            >
                              <Check aria-hidden="true" className="size-3.5" />
                              {t("readingManagement.acknowledgeReminder")}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <PaginationBar
                      ariaLabel={t(
                        "readingManagement.dueRemindersPaginationAria",
                      )}
                      className="mt-2.5"
                      compact
                      itemLabel={t(
                        "readingManagement.dueRemindersPaginationItem",
                      )}
                      onPageChange={setDuePage}
                      page={safeDuePage}
                      pageSize={DUE_PAGE_SIZE}
                      total={due.length}
                    />
                  </div>
                ) : null}
                {reminders.length === 0 ? (
                  <p className="mt-3 rounded-control border border-dashed border-border/80 bg-canvas/50 px-4 py-4 text-center text-sm text-muted">
                    {t("readingManagement.remindersEmpty")}
                  </p>
                ) : (
                  <>
                    <div className="mt-3 divide-y divide-border/70 overflow-hidden rounded-control border border-border bg-canvas/30">
                      {visibleReminders.map((reminder) => {
                        const fullDays = formatWeekdaysFull(reminder.weekdays);
                        const shortSchedule = formatReminderSchedule(
                          reminder.weekdays,
                        );
                        return (
                          <article
                            key={reminder.id}
                            data-reminder-id={reminder.id}
                            className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2 transition-colors hover:bg-white/70"
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <h3 className="flex items-center gap-1.5 text-sm font-extrabold tabular-nums text-ink">
                                <Clock3
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-primary"
                                />
                                {clock(reminder.remind_at)}
                              </h3>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky/70 px-2 py-0.5 text-[11px] font-semibold text-primary-hover">
                                {reminder.email_enabled ? (
                                  <Mail
                                    aria-hidden="true"
                                    className="size-3 shrink-0"
                                  />
                                ) : null}
                                {reminder.email_enabled
                                  ? t("readingManagement.channelEmail")
                                  : t("readingManagement.channelApp")}
                              </span>
                              <span
                                className="truncate text-xs text-muted"
                                title={`${fullDays} · ${reminder.timezone}`}
                              >
                                {shortSchedule}
                              </span>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <label className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1.5 pe-1 text-xs font-semibold text-ink sm:min-h-8">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-primary"
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
                                        ? t(
                                            "readingManagement.notices.reminderEnabled",
                                          )
                                        : t(
                                            "readingManagement.notices.reminderDisabled",
                                          ),
                                    )
                                  }
                                />
                                {t("readingManagement.reminderEnabledLabel")}
                              </label>
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! sm:min-h-8! sm:px-2.5!"
                                onClick={() => {
                                  setEditingReminderId(reminder.id);
                                  setActiveForm("reminder");
                                  setReminderTime(clock(reminder.remind_at));
                                  setReminderDays(reminder.weekdays);
                                  setReminderTimezone(reminder.timezone);
                                  setReminderEmailEnabled(
                                    reminder.email_enabled,
                                  );
                                }}
                              >
                                {t("readingManagement.edit")}
                              </Button>
                              <Button
                                variant="quiet"
                                size="compact"
                                fullWidth={false}
                                className="min-h-10! w-auto! border border-border bg-white px-3! py-1! text-xs! text-danger sm:min-h-8! sm:px-2.5!"
                                disabled={Boolean(busyKey)}
                                onClick={() =>
                                  void (
                                    window.confirm(
                                      t(
                                        "readingManagement.notices.reminderDeleteConfirm",
                                      ),
                                    ) &&
                                    runAction(
                                      "reminder-delete-" + reminder.id,
                                      () => service.deleteReminder(reminder.id),
                                      t(
                                        "readingManagement.notices.reminderDeleted",
                                      ),
                                    )
                                  )
                                }
                              >
                                <Trash2
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {t("readingManagement.delete")}
                              </Button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <PaginationBar
                      ariaLabel={t("readingManagement.remindersPaginationAria")}
                      className="mt-3"
                      compact
                      itemLabel={t("readingManagement.remindersPaginationItem")}
                      onPageChange={setRemindersPage}
                      page={safeRemindersPage}
                      pageSize={REMINDERS_PAGE_SIZE}
                      total={reminders.length}
                    />
                  </>
                )}
              </section>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
