"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Mail } from "lucide-react";

import { Button } from "@/components/common/button";
import { FormPage } from "@/components/common/form-page";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import type { BookListItemDTO } from "@/types/book";
import type {
  ReadingGoalMetric,
  ReadingGoalPeriod,
} from "@/types/reading-management";
import { weekdayOptions } from "./reading-management-utils";

const inputClass =
  "min-h-11 min-w-0 w-full rounded-control border border-border bg-white px-3 text-label text-ink focus-visible:outline-3 focus-visible:outline-primary";
const labelClass =
  "flex min-w-0 flex-col gap-1 text-label font-semibold text-ink";
const dayChipClass =
  "inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs font-semibold transition-colors";

export interface ReadingManagementFormsProps {
  readonly activeForm: "plan" | "goal" | "reminder";
  readonly books: BookListItemDTO[] | null;
  readonly busyKey: string;
  readonly error: string;
  readonly onBack: () => void;
  // Plan state
  readonly editingPlanId: string;
  readonly setEditingPlanId: (value: string) => void;
  readonly planTitle: string;
  readonly setPlanTitle: (value: string) => void;
  readonly planBookId: string;
  readonly setPlanBookId: (value: string) => void;
  readonly planMinutes: string;
  readonly setPlanMinutes: (value: string) => void;
  readonly planDays: number[];
  readonly setPlanDays: Dispatch<SetStateAction<number[]>>;
  readonly planStart: string;
  readonly setPlanStart: (value: string) => void;
  readonly planEnd: string;
  readonly setPlanEnd: (value: string) => void;
  readonly planTimezone: string;
  readonly setPlanTimezone: (value: string) => void;
  readonly onSubmitPlan: (event: FormEvent<HTMLFormElement>) => void;
  // Goal state
  readonly goalMetric: ReadingGoalMetric;
  readonly setGoalMetric: (value: ReadingGoalMetric) => void;
  readonly goalPeriod: ReadingGoalPeriod;
  readonly setGoalPeriod: (value: ReadingGoalPeriod) => void;
  readonly goalTarget: string;
  readonly setGoalTarget: (value: string) => void;
  readonly goalStart: string;
  readonly setGoalStart: (value: string) => void;
  readonly goalEnd: string;
  readonly setGoalEnd: (value: string) => void;
  readonly onSubmitGoal: (event: FormEvent<HTMLFormElement>) => void;
  // Reminder state
  readonly editingReminderId: string;
  readonly setEditingReminderId: (value: string) => void;
  readonly reminderTime: string;
  readonly setReminderTime: (value: string) => void;
  readonly reminderDays: number[];
  readonly setReminderDays: Dispatch<SetStateAction<number[]>>;
  readonly reminderTimezone: string;
  readonly setReminderTimezone: (value: string) => void;
  readonly reminderEmailEnabled: boolean;
  readonly setReminderEmailEnabled: (value: boolean) => void;
  readonly onSubmitReminder: (event: FormEvent<HTMLFormElement>) => void;
}

export function ReadingManagementForms({
  activeForm,
  books,
  busyKey,
  error,
  onBack,
  editingPlanId,
  setEditingPlanId,
  planTitle,
  setPlanTitle,
  planBookId,
  setPlanBookId,
  planMinutes,
  setPlanMinutes,
  planDays,
  setPlanDays,
  planStart,
  setPlanStart,
  planEnd,
  setPlanEnd,
  planTimezone,
  setPlanTimezone,
  onSubmitPlan,
  goalMetric,
  setGoalMetric,
  goalPeriod,
  setGoalPeriod,
  goalTarget,
  setGoalTarget,
  goalStart,
  setGoalStart,
  goalEnd,
  setGoalEnd,
  onSubmitGoal,
  editingReminderId,
  setEditingReminderId,
  reminderTime,
  setReminderTime,
  reminderDays,
  setReminderDays,
  reminderTimezone,
  setReminderTimezone,
  reminderEmailEnabled,
  setReminderEmailEnabled,
  onSubmitReminder,
}: ReadingManagementFormsProps) {
  const t = useTranslations("reports");

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
      onBack={onBack}
    >
      <datalist id="reading-timezones">
        <option value="Asia/Ho_Chi_Minh" />
        <option value="Asia/Bangkok" />
        <option value="Asia/Singapore" />
        <option value="UTC" />
        <option value="America/Los_Angeles" />
      </datalist>

      {error ? (
        <StatusMessage title={t("readingManagement.errorTitle")} tone="error">
          {error}
        </StatusMessage>
      ) : null}

      {activeForm === "plan" ? (
        <form className="grid gap-3.5 sm:grid-cols-2" onSubmit={onSubmitPlan}>
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
            <legend className="mb-1.5 text-label font-semibold text-ink">
              {t("readingManagement.modal.readingDaysLabel")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {weekdayOptions.map((day) => (
                <label
                  key={day.value}
                  className={
                    dayChipClass +
                    (planDays.includes(day.value)
                      ? " border border-primary/30 bg-sky text-primary"
                      : " border border-border bg-white text-ink")
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
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button
              fullWidth={false}
              size="compact"
              type="submit"
              disabled={Boolean(busyKey)}
            >
              {editingPlanId
                ? t("readingManagement.modal.savePlan")
                : t("readingManagement.modal.createPlan")}
            </Button>
            {editingPlanId ? (
              <Button
                fullWidth={false}
                size="compact"
                type="button"
                variant="secondary"
                onClick={() => setEditingPlanId("")}
              >
                {t("readingManagement.modal.cancelEdit")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : activeForm === "goal" ? (
        <form className="grid gap-3.5 sm:grid-cols-2" onSubmit={onSubmitGoal}>
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
            <Button
              fullWidth={false}
              size="compact"
              type="submit"
              disabled={Boolean(busyKey)}
            >
              {t("readingManagement.modal.createGoal")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="grid gap-3.5 sm:grid-cols-2"
          onSubmit={onSubmitReminder}
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
          </label>
          <fieldset className="min-w-0 sm:col-span-2">
            <legend className="mb-1.5 text-label font-semibold text-ink">
              {t("readingManagement.modal.repeatDaysLabel")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {weekdayOptions.map((day) => (
                <label
                  key={day.value}
                  className={
                    dayChipClass +
                    (reminderDays.includes(day.value)
                      ? " border border-primary/30 bg-sky text-primary"
                      : " border border-border bg-white text-ink")
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
                  <Mail aria-hidden="true" className="size-4 text-primary" />{" "}
                  {t("readingManagement.modal.sendEmailCheck")}
                </span>
                <span className="mt-1 block text-sm text-muted">
                  {t("readingManagement.modal.emailDestinationNote")}
                </span>
              </span>
            </label>
          </fieldset>
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2">
            <Button
              fullWidth={false}
              size="compact"
              type="submit"
              disabled={Boolean(busyKey)}
            >
              {editingReminderId
                ? t("readingManagement.modal.saveChanges")
                : t("readingManagement.modal.createReminder")}
            </Button>
            {editingReminderId ? (
              <Button
                fullWidth={false}
                size="compact"
                type="button"
                variant="secondary"
                onClick={() => setEditingReminderId("")}
              >
                {t("readingManagement.modal.cancelEdit")}
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </FormPage>
  );
}
