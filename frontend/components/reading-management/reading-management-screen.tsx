"use client";

import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BellRing,
  BookHeart,
  CalendarDays,
  RefreshCw,
  Target,
} from "lucide-react";

import { AppStoreContext } from "@/components/providers/app-store-provider";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { SegmentedFilterBar } from "@/components/common/segmented-filter-bar";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingHubSubNav } from "@/components/reports/reading-hub-subnav";
import {
  TodaySummary,
  isRunningGoal,
  isRunningPlan,
} from "@/components/reading-management/reading-management-insights";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useTranslations } from "@/hooks/use-i18n";
import { useReadingManagementService } from "@/hooks/use-reading-management-service";
import { conflictMessage } from "@/lib/api/reading-management-messages";
import {
  isAndroidNativeReminderAvailable,
  requestAndroidReminderPermission,
  syncRemindersToAndroidShell,
} from "@/lib/reading/native-reminder-bridge";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { cn } from "@/lib/utils/cn";
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
  ReadingReminderDTO,
  ReadingReminderOccurrenceDTO,
} from "@/types/reading-management";
import { ReadingCollectionsSection } from "./reading-collections-section";
import { ReadingGoalsSection } from "./reading-goals-section";
import { ReadingManagementForms } from "./reading-management-forms";
import {
  clock,
  localToday,
  type ActiveReadingForm,
  type ReadingManagementFocus,
} from "./reading-management-utils";
import { ReadingPlansSection } from "./reading-plans-section";
import { ReadingRemindersSection } from "./reading-reminders-section";

interface Props {
  requestedChildId?: string;
}

export function ReadingManagementScreen({ requestedChildId }: Props) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const authRuntime = useAuthRuntime();
  const appStore = useContext(AppStoreContext);
  const preferredChildId =
    requestedChildId ?? appStore?.selectedChildId ?? null;
  const childService = useChildService();
  const bookService = useBookService();
  const service = useReadingManagementService();

  const [children, setChildren] = useState<ChildProfileDTO[]>([]);
  const [childId, setChildId] = useState(preferredChildId ?? "");
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
  const [focus, setFocus] = useState<ReadingManagementFocus>("ALL");
  const [activeForm, setActiveForm] = useState<ActiveReadingForm>(null);

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

  useEffect(() => {
    if (selectedChild) {
      hydrateTeacherVoiceFromChildProfile(selectedChild);
    }
  }, [selectedChild]);

  function handleSelectChild(nextChildId: string) {
    if (nextChildId === childId) return;
    const nextChild =
      children.find((candidate) => candidate.id === nextChildId) ?? null;
    if (nextChild) {
      hydrateTeacherVoiceFromChildProfile(nextChild, { force: true });
    }
    requestIdRef.current += 1;
    setChildId(nextChildId);
    setGoals([]);
    setPlans([]);
    setCollections([]);
    setReminders([]);
    setDue([]);
    setBooks([]);
    setFocus("ALL");
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
        const requested = preferredChildId
          ? items.find((child) => child.id === preferredChildId)
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
  }, [childService, preferredChildId, t]);

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

  const parentUserId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? "";
  const selectedChildAlias = selectedChild?.alias ?? "";

  useEffect(() => {
    if (
      !parentUserId ||
      loadedRequestKey !== currentRequestKey ||
      !isAndroidNativeReminderAvailable()
    ) {
      return;
    }
    void syncRemindersToAndroidShell({
      userId: parentUserId,
      childAlias: selectedChildAlias,
      reminders,
      titleText: "ViRead",
      bodyText: t("readingManagement.androidReminderBody", {
        alias: selectedChildAlias,
      }),
    }).then((ack) => {
      if (ack?.status === "SYNCED_PERMISSION_NEEDED") {
        void requestAndroidReminderPermission();
      }
    });
  }, [
    currentRequestKey,
    loadedRequestKey,
    parentUserId,
    reminders,
    selectedChildAlias,
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

  async function transitionGoal(goal: ReadingGoalDTO, next: ReadingGoalStatus) {
    if (
      next === "ENDED" &&
      !window.confirm(t("readingManagement.notices.goalEndConfirm"))
    ) {
      return;
    }
    await runAction(
      "goal-" + goal.id,
      () => service.transitionGoal(goal.id, next),
      t("readingManagement.notices.goalStatusUpdated"),
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
    ) {
      return;
    }
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
    return (
      <ReadingManagementForms
        activeForm={activeForm}
        books={books}
        busyKey={busyKey}
        error={error}
        onBack={() => setActiveForm(null)}
        editingPlanId={editingPlanId}
        setEditingPlanId={setEditingPlanId}
        planTitle={planTitle}
        setPlanTitle={setPlanTitle}
        planBookId={planBookId}
        setPlanBookId={setPlanBookId}
        planMinutes={planMinutes}
        setPlanMinutes={setPlanMinutes}
        planDays={planDays}
        setPlanDays={setPlanDays}
        planStart={planStart}
        setPlanStart={setPlanStart}
        planEnd={planEnd}
        setPlanEnd={setPlanEnd}
        planTimezone={planTimezone}
        setPlanTimezone={setPlanTimezone}
        onSubmitPlan={(event) => void submitPlan(event)}
        goalMetric={goalMetric}
        setGoalMetric={setGoalMetric}
        goalPeriod={goalPeriod}
        setGoalPeriod={setGoalPeriod}
        goalTarget={goalTarget}
        setGoalTarget={setGoalTarget}
        goalStart={goalStart}
        setGoalStart={setGoalStart}
        goalEnd={goalEnd}
        setGoalEnd={setGoalEnd}
        onSubmitGoal={(event) => void submitGoal(event)}
        editingReminderId={editingReminderId}
        setEditingReminderId={setEditingReminderId}
        reminderTime={reminderTime}
        setReminderTime={setReminderTime}
        reminderDays={reminderDays}
        setReminderDays={setReminderDays}
        reminderTimezone={reminderTimezone}
        setReminderTimezone={setReminderTimezone}
        reminderEmailEnabled={reminderEmailEnabled}
        setReminderEmailEnabled={setReminderEmailEnabled}
        onSubmitReminder={(event) => void submitReminder(event)}
      />
    );
  }

  if (loadingChildren) {
    return (
      <section
        className="mx-auto max-w-[1120px] p-6 text-body text-muted"
        aria-busy="true"
      >
        {t("readingManagement.loadingChild")}
      </section>
    );
  }

  const kpiItems = [
    {
      key: "GOALS" as const,
      label: t("readingManagement.summaryRunningGoals"),
      value: goals.filter(isRunningGoal).length,
      icon: <Target className="size-4" />,
    },
    {
      key: "PLANS" as const,
      label: t("readingManagement.summaryActivePlans"),
      value: plans.filter(isRunningPlan).length,
      icon: <CalendarDays className="size-4" />,
    },
    {
      key: "REMINDERS" as const,
      label: t("readingManagement.summaryEnabledReminders"),
      value: reminders.filter((reminder) => reminder.is_active).length,
      icon: <BellRing className="size-4" />,
    },
    {
      key: "COLLECTIONS" as const,
      label: t("readingManagement.summarySavedBooks"),
      value: collections.length,
      icon: <BookHeart className="size-4" />,
    },
  ];

  const focusOptions = [
    { value: "ALL" as const, label: tCommon("taskCenter.filters.all") },
    { value: "PLANS" as const, label: t("readingManagement.focusPlans") },
    { value: "GOALS" as const, label: t("readingManagement.focusGoals") },
    {
      value: "REMINDERS" as const,
      label: t("readingManagement.focusReminders"),
    },
    {
      value: "COLLECTIONS" as const,
      label: t("readingManagement.summarySavedBooks"),
    },
  ];

  const plansSection = (
    <ReadingPlansSection
      plans={plans}
      page={plansPage}
      onPageChange={setPlansPage}
      busyKey={busyKey}
      onAddPlan={() => {
        setEditingPlanId("");
        setActiveForm("plan");
      }}
      onEditPlan={(plan) => {
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
      onTransitionPlan={(plan, next) => void transitionPlan(plan, next)}
    />
  );

  const goalsSection = (
    <ReadingGoalsSection
      goals={goals}
      page={goalsPage}
      onPageChange={setGoalsPage}
      busyKey={busyKey}
      editingGoalId={editingGoalId}
      editingTarget={editingTarget}
      onStartEditGoal={(goal) => {
        setEditingGoalId(goal.id);
        setEditingTarget(String(goal.target_value));
      }}
      onChangeEditingTarget={setEditingTarget}
      onSaveEditedGoal={(goal) => void saveEditedGoal(goal)}
      onCancelEditGoal={() => setEditingGoalId("")}
      onAddGoal={() => setActiveForm("goal")}
      onTransitionGoal={(goal, next) => void transitionGoal(goal, next)}
    />
  );

  const collectionsSection = (
    <ReadingCollectionsSection
      childId={childId}
      collections={collections}
      books={books}
      filter={collectionFilter}
      onFilterChange={(next) => {
        setCollectionFilter(next);
        setCollectionsPage(1);
      }}
      page={collectionsPage}
      onPageChange={setCollectionsPage}
      busyKey={busyKey}
      isLoading={isReadingDataLoading}
      onToggleCollection={(bookId, type) => void toggleCollection(bookId, type)}
      onReload={() => setReloadKey((value) => value + 1)}
    />
  );

  const remindersSection = (
    <ReadingRemindersSection
      reminders={reminders}
      due={due}
      remindersPage={remindersPage}
      onRemindersPageChange={setRemindersPage}
      duePage={duePage}
      onDuePageChange={setDuePage}
      busyKey={busyKey}
      onAddReminder={() => {
        setEditingReminderId("");
        setActiveForm("reminder");
      }}
      onEditReminder={(reminder) => {
        setEditingReminderId(reminder.id);
        setActiveForm("reminder");
        setReminderTime(clock(reminder.remind_at));
        setReminderDays(reminder.weekdays);
        setReminderTimezone(reminder.timezone);
        setReminderEmailEnabled(reminder.email_enabled);
      }}
      onToggleReminder={(reminder, nextActive) =>
        void runAction(
          "reminder-toggle-" + reminder.id,
          () =>
            service.updateReminder(reminder.id, {
              is_active: nextActive,
            }),
          nextActive
            ? t("readingManagement.notices.reminderEnabled")
            : t("readingManagement.notices.reminderDisabled"),
        )
      }
      onDeleteReminder={(reminder) =>
        void (
          window.confirm(
            t("readingManagement.notices.reminderDeleteConfirm"),
          ) &&
          runAction(
            "reminder-delete-" + reminder.id,
            () => service.deleteReminder(reminder.id),
            t("readingManagement.notices.reminderDeleted"),
          )
        )
      }
      onAcknowledgeDue={(item) =>
        void runAction(
          "due-" + item.id,
          () => service.acknowledgeOccurrence(item.id),
          t("readingManagement.notices.reminderAck"),
        )
      }
    />
  );

  return (
    <section className="reading-organizer mx-auto flex w-full max-w-[1120px] flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border pb-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="book-title text-xl tracking-[-0.02em] text-ink sm:text-2xl">
            {t("readingManagement.heading")}
          </h1>
          <ReadingHubSubNav
            active="reading-management"
            childId={childId || null}
          />
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <label className="sr-only" htmlFor="management-child">
            {t("readingManagement.childProfileLabel")}
          </label>
          <select
            id="management-child"
            className="h-10 min-h-10 min-w-0 flex-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-primary sm:h-9 sm:min-h-9 sm:w-44 sm:flex-initial sm:text-sm"
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
          <Button
            onClick={() => setReloadKey((value) => value + 1)}
            size="admin"
            className="h-10! min-h-10! shrink-0 whitespace-nowrap px-2.5! text-xs! sm:h-9! sm:min-h-9!"
            fullWidth={false}
            variant="secondary"
            disabled={isReadingDataLoading || !childId}
          >
            <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />{" "}
            {t("readingManagement.reload")}
          </Button>
        </div>
      </header>

      {error ? (
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
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {t("readingManagement.loadingChildData")}
        </p>
      ) : null}

      {hasReadingData ? (
        <>
          <section
            aria-label={t("readingManagement.overviewAria")}
            className="grid grid-cols-2 gap-2.5 lg:grid-cols-4"
          >
            {kpiItems.map((item) => {
              const isActive = focus === item.key;
              return (
                <article
                  key={item.key}
                  className={cn(
                    "min-w-0 rounded-card border bg-white transition-colors",
                    isActive
                      ? "border-primary bg-sky/25"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() =>
                      setFocus((current) =>
                        current === item.key ? "ALL" : item.key,
                      )
                    }
                    className="flex h-full min-h-13 w-full flex-col items-start justify-between gap-1 rounded-card px-2.5 py-2 text-start focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "inline-flex size-6 shrink-0 items-center justify-center rounded-lg sm:size-7",
                          isActive
                            ? "bg-primary text-white"
                            : "bg-sky/60 text-primary",
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="text-xs font-bold leading-snug text-muted sm:text-[13px]">
                        {item.label}
                      </span>
                    </span>
                    <span className="shrink-0 text-xl font-extrabold leading-none tabular-nums text-primary">
                      {item.value}
                    </span>
                  </button>
                </article>
              );
            })}
          </section>

          <SegmentedFilterBar
            ariaLabel={t("readingManagement.focusAria")}
            options={focusOptions}
            value={focus}
            onChange={setFocus}
          />

          {focus === "ALL" ? (
            <>
              <TodaySummary
                key={childId}
                childName={
                  selectedChild?.alias ??
                  t("readingManagement.todayDefaultChild")
                }
                plans={plans}
                goals={goals}
              />

              <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
                <div className="flex min-w-0 flex-col gap-4">
                  {plansSection}
                  {collectionsSection}
                </div>
                <div className="flex min-w-0 flex-col gap-4">
                  {goalsSection}
                  {remindersSection}
                </div>
              </div>
            </>
          ) : focus === "PLANS" ? (
            plansSection
          ) : focus === "GOALS" ? (
            goalsSection
          ) : focus === "REMINDERS" ? (
            remindersSection
          ) : (
            collectionsSection
          )}
        </>
      ) : null}
    </section>
  );
}
