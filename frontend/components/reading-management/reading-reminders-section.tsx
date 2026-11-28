"use client";

import {
  BellRing,
  CalendarClock,
  Check,
  Clock3,
  Mail,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type {
  ReadingReminderDTO,
  ReadingReminderOccurrenceDTO,
} from "@/types/reading-management";
import {
  DUE_PAGE_SIZE,
  REMINDERS_PAGE_SIZE,
  clock,
  formatReminderSchedule,
  formatWeekdaysFull,
} from "./reading-management-utils";

export interface ReadingRemindersSectionProps {
  readonly reminders: readonly ReadingReminderDTO[];
  readonly due: readonly ReadingReminderOccurrenceDTO[];
  readonly remindersPage: number;
  readonly onRemindersPageChange: (next: number) => void;
  readonly duePage: number;
  readonly onDuePageChange: (next: number) => void;
  readonly busyKey: string;
  readonly onAddReminder: () => void;
  readonly onEditReminder: (reminder: ReadingReminderDTO) => void;
  readonly onToggleReminder: (
    reminder: ReadingReminderDTO,
    nextActive: boolean,
  ) => void;
  readonly onDeleteReminder: (reminder: ReadingReminderDTO) => void;
  readonly onAcknowledgeDue: (occurrence: ReadingReminderOccurrenceDTO) => void;
}

export function ReadingRemindersSection({
  reminders,
  due,
  remindersPage,
  onRemindersPageChange,
  duePage,
  onDuePageChange,
  busyKey,
  onAddReminder,
  onEditReminder,
  onToggleReminder,
  onDeleteReminder,
  onAcknowledgeDue,
}: ReadingRemindersSectionProps) {
  const { formatTime } = useI18n();
  const t = useTranslations("reports");

  const dueTotalPages = Math.max(1, Math.ceil(due.length / DUE_PAGE_SIZE));
  const safeDuePage = Math.min(Math.max(1, duePage), dueTotalPages);
  const visibleDue = due.slice(
    (safeDuePage - 1) * DUE_PAGE_SIZE,
    safeDuePage * DUE_PAGE_SIZE,
  );

  const remindersTotalPages = Math.max(
    1,
    Math.ceil(reminders.length / REMINDERS_PAGE_SIZE),
  );
  const safeRemindersPage = Math.min(
    Math.max(1, remindersPage),
    remindersTotalPages,
  );
  const visibleReminders = reminders.slice(
    (safeRemindersPage - 1) * REMINDERS_PAGE_SIZE,
    safeRemindersPage * REMINDERS_PAGE_SIZE,
  );

  return (
    <section
      aria-label={t("readingManagement.remindersSectionAria")}
      className="min-w-0 rounded-card border border-border bg-white p-3.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky/70 text-primary"
          >
            <CalendarClock className="size-4" />
          </span>
          <h2 className="min-w-0 break-words text-sm font-extrabold leading-snug text-ink sm:text-base">
            {t("readingManagement.remindersTitle")}
          </h2>
          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
            {reminders.length}
          </span>
        </div>
        <Button
          fullWidth={false}
          size="compact"
          variant="secondary"
          className="h-8! min-h-8! shrink-0 whitespace-nowrap px-2.5! py-1! text-xs!"
          onClick={onAddReminder}
        >
          {t("readingManagement.addReminder")}
        </Button>
      </div>

      {due.length > 0 ? (
        <div className="mb-2.5 rounded-control bg-cream px-3 py-2">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink">
            <BellRing
              aria-hidden="true"
              className="size-3.5 shrink-0 text-primary"
            />
            {t("readingManagement.dueRemindersTitle", {
              count: due.length,
            })}
          </h3>
          <ul className="divide-y divide-border/60">
            {visibleDue.map((item) => (
              <li
                key={item.id}
                data-due-id={item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5 first:pt-0.5 last:pb-0.5"
              >
                <span className="min-w-0 text-xs font-semibold tabular-nums text-ink">
                  {t("readingManagement.reminderAtPrefix")}
                  {item.reminder
                    ? clock(item.reminder.remind_at)
                    : formatTime(item.scheduled_for, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                  · {item.scheduled_local_date}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.email_status !== "NOT_REQUESTED" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-primary">
                      <Mail aria-hidden="true" className="size-3 shrink-0" />{" "}
                      {item.email_error_code === "PARENT_EMAIL_UNVERIFIED"
                        ? t("readingManagement.emailUnverifiedLabel")
                        : t(
                            `readingManagement.deliveryStatus.${item.email_status}`,
                          )}
                    </span>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="compact"
                    fullWidth={false}
                    className="h-7! min-h-7! w-auto! px-2! py-0.5! text-xs!"
                    disabled={Boolean(busyKey)}
                    onClick={() => onAcknowledgeDue(item)}
                  >
                    <Check aria-hidden="true" className="size-3.5 shrink-0" />
                    {t("readingManagement.acknowledgeReminder")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <PaginationBar
            ariaLabel={t("readingManagement.dueRemindersPaginationAria")}
            className="mt-2"
            compact
            itemLabel={t("readingManagement.dueRemindersPaginationItem")}
            onPageChange={onDuePageChange}
            page={safeDuePage}
            pageSize={DUE_PAGE_SIZE}
            total={due.length}
          />
        </div>
      ) : null}

      {reminders.length === 0 ? (
        <p className="mt-2 rounded-control border border-dashed border-border/80 bg-canvas/50 px-3 py-3 text-center text-sm text-muted">
          {t("readingManagement.remindersEmpty")}
        </p>
      ) : (
        <>
          <div className="divide-y divide-border/70">
            {visibleReminders.map((reminder) => {
              const fullDays = formatWeekdaysFull(reminder.weekdays, t);
              const shortSchedule = formatReminderSchedule(
                reminder.weekdays,
                t,
              );
              return (
                <article
                  key={reminder.id}
                  data-reminder-id={reminder.id}
                  className="flex min-w-0 flex-col gap-1.5 py-2 first:pt-1 last:pb-0.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <h3 className="flex shrink-0 items-center gap-1 text-sm font-extrabold tabular-nums text-ink">
                      <Clock3
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-primary"
                      />
                      {clock(reminder.remind_at)}
                    </h3>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky/70 px-2 py-0.5 text-[11px] font-semibold text-primary-hover">
                      {reminder.email_enabled ? (
                        <Mail aria-hidden="true" className="size-3 shrink-0" />
                      ) : null}
                      {reminder.email_enabled
                        ? t("readingManagement.channelEmail")
                        : t("readingManagement.channelApp")}
                    </span>
                    <span
                      className="min-w-0 truncate text-xs text-muted"
                      title={`${fullDays} · ${reminder.timezone}`}
                    >
                      {shortSchedule}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center justify-end gap-1.5">
                    <label className="inline-flex h-8 min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-control px-1.5 text-xs font-semibold text-ink hover:bg-canvas">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={reminder.is_active}
                        disabled={Boolean(busyKey)}
                        onChange={(e) =>
                          onToggleReminder(reminder, e.target.checked)
                        }
                      />
                      {t("readingManagement.reminderEnabledLabel")}
                    </label>
                    <Button
                      variant="quiet"
                      size="compact"
                      fullWidth={false}
                      className="h-8! min-h-8! w-auto! shrink-0 whitespace-nowrap border border-border bg-white px-2! py-0! text-xs!"
                      onClick={() => onEditReminder(reminder)}
                    >
                      {t("readingManagement.edit")}
                    </Button>
                    <Button
                      variant="quiet"
                      size="compact"
                      fullWidth={false}
                      className="h-8! min-h-8! w-auto! shrink-0 whitespace-nowrap border border-border bg-white px-2! py-0! text-xs! text-danger"
                      disabled={Boolean(busyKey)}
                      onClick={() => onDeleteReminder(reminder)}
                    >
                      <Trash2
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
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
            className="mt-2.5"
            compact
            itemLabel={t("readingManagement.remindersPaginationItem")}
            onPageChange={onRemindersPageChange}
            page={safeRemindersPage}
            pageSize={REMINDERS_PAGE_SIZE}
            total={reminders.length}
          />
        </>
      )}
    </section>
  );
}
