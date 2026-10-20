import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
  ReadingGoalCreateDTO,
  ReadingGoalDTO,
  ReadingGoalStatus,
  ReadingReminderDTO,
  ReadingReminderOccurrenceDTO,
  ReadingReminderWriteDTO,
  ReadingReminderEmailStatusDTO,
} from "@/types/reading-management";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const goalSchema = z.object({
  id: z.string().uuid(),
  child_id: z.string().uuid(),
  metric: z.enum(["MINUTES", "SESSIONS"]),
  target_value: z.number().int().positive(),
  period: z.enum(["DAILY", "WEEKLY"]),
  starts_on: dateSchema,
  ends_on: dateSchema.nullable(),
  timezone: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ENDED"]),
  current_value: z.number().int().nonnegative(),
  progress_percent: z.number().min(0).max(100),
  completed_value: z.number().int().nonnegative().nullable().optional(),
  completed_at: dateTimeSchema.nullable().optional(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});
const collectionSchema = z.object({
  id: z.string().uuid(),
  child_id: z.string().uuid(),
  book_id: z.string().uuid(),
  collection_type: z.enum(["FAVORITE", "WANT_TO_READ"]),
  created_at: dateTimeSchema,
  book: z.object({
    id: z.string().uuid(),
    title: z.string(),
    author: z.string().nullable(),
    min_grade: z.number().int(),
    max_grade: z.number().int(),
    lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
    available_to_read: z.boolean(),
  }),
});
const reminderSchema = z.object({
  id: z.string().uuid(),
  child_id: z.string().uuid(),
  remind_at: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  weekdays: z.array(z.number().int().min(0).max(6)),
  timezone: z.string().min(1),
  is_active: z.boolean(),
  email_enabled: z.boolean(),
  latest_email_status: z.enum(["PENDING", "PROCESSING", "SENT", "FAILED", "SKIPPED"]).nullable(),
  deleted_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});
const occurrenceSchema = z.object({
  id: z.string().uuid(),
  reminder_id: z.string().uuid(),
  scheduled_local_date: dateSchema,
  scheduled_for: dateTimeSchema,
  status: z.enum(["PENDING", "ACKNOWLEDGED"]),
  acknowledged_at: dateTimeSchema.nullable(),
  reminder: reminderSchema.nullable(),
});
const emailStatusSchema = z.object({
  provider_configured: z.boolean(),
  sender_configured: z.boolean(),
  app_url_configured: z.boolean(),
  auth_admin_configured: z.boolean(),
  email_available: z.boolean(),
  email_verified: z.boolean().nullable(),
  ready: z.boolean(),
});
const deletedSchema = z.object({ deleted: z.literal(true) });

export interface ReadingManagementService {
  listGoals(childId: string, signal?: AbortSignal): Promise<ReadingGoalDTO[]>;
  createGoal(payload: ReadingGoalCreateDTO): Promise<ReadingGoalDTO>;
  updateGoal(
    goalId: string,
    payload: { target_value?: number; ends_on?: string | null },
  ): Promise<ReadingGoalDTO>;
  transitionGoal(
    goalId: string,
    status: ReadingGoalStatus,
  ): Promise<ReadingGoalDTO>;
  listCollections(
    childId: string,
    signal?: AbortSignal,
  ): Promise<ChildBookCollectionDTO[]>;
  addCollection(
    childId: string,
    bookId: string,
    type: BookCollectionType,
  ): Promise<ChildBookCollectionDTO>;
  removeCollection(
    childId: string,
    bookId: string,
    type: BookCollectionType,
  ): Promise<void>;
  listReminders(
    childId: string,
    signal?: AbortSignal,
  ): Promise<ReadingReminderDTO[]>;
  reminderEmailStatus(signal?: AbortSignal): Promise<ReadingReminderEmailStatusDTO>;
  createReminder(
    payload: Required<
      Pick<
        ReadingReminderWriteDTO,
        "child_id" | "remind_at" | "weekdays" | "timezone"
      >
    > & { is_active?: boolean; email_enabled?: boolean },
  ): Promise<ReadingReminderDTO>;
  updateReminder(
    reminderId: string,
    payload: ReadingReminderWriteDTO,
  ): Promise<ReadingReminderDTO>;
  deleteReminder(reminderId: string): Promise<void>;
  dueReminders(
    childId: string,
    signal?: AbortSignal,
  ): Promise<ReadingReminderOccurrenceDTO[]>;
  acknowledgeOccurrence(
    occurrenceId: string,
  ): Promise<ReadingReminderOccurrenceDTO>;
}

export function createReadingManagementService(): ReadingManagementService {
  return {
    listGoals: (childId, signal) =>
      requestApi(
        "/reading-management/goals" + apiQuery({ child_id: childId }),
        z.array(goalSchema),
        signal,
      ),
    createGoal: (payload) =>
      requestApi("/reading-management/goals", goalSchema, undefined, {
        method: "POST",
        body: payload,
      }),
    updateGoal: (id, payload) =>
      requestApi(
        "/reading-management/goals/" + encodeURIComponent(id),
        goalSchema,
        undefined,
        { method: "PATCH", body: payload },
      ),
    transitionGoal: (id, status) =>
      requestApi(
        "/reading-management/goals/" + encodeURIComponent(id) + "/transition",
        goalSchema,
        undefined,
        { method: "POST", body: { status } },
      ),
    listCollections: (childId, signal) =>
      requestApi(
        "/reading-management/collections" + apiQuery({ child_id: childId }),
        z.array(collectionSchema),
        signal,
      ),
    addCollection: (childId, bookId, type) =>
      requestApi(
        "/reading-management/collections/" + encodeURIComponent(bookId),
        collectionSchema,
        undefined,
        { method: "PUT", body: { child_id: childId, collection_type: type } },
      ),
    async removeCollection(childId, bookId, type) {
      await requestApi(
        "/reading-management/collections/" +
          encodeURIComponent(bookId) +
          apiQuery({ child_id: childId, collection_type: type }),
        deletedSchema,
        undefined,
        { method: "DELETE" },
      );
    },
    listReminders: (childId, signal) =>
      requestApi(
        "/reading-management/reminders" + apiQuery({ child_id: childId }),
        z.array(reminderSchema),
        signal,
      ),
    reminderEmailStatus: (signal) =>
      requestApi("/reading-management/reminders/email-status", emailStatusSchema, signal),
    createReminder: (payload) =>
      requestApi("/reading-management/reminders", reminderSchema, undefined, {
        method: "POST",
        body: payload,
      }),
    updateReminder: (id, payload) =>
      requestApi(
        "/reading-management/reminders/" + encodeURIComponent(id),
        reminderSchema,
        undefined,
        { method: "PATCH", body: payload },
      ),
    async deleteReminder(id) {
      await requestApi(
        "/reading-management/reminders/" + encodeURIComponent(id),
        deletedSchema,
        undefined,
        { method: "DELETE" },
      );
    },
    dueReminders: (childId, signal) =>
      requestApi(
        "/reading-management/reminders/due" + apiQuery({ child_id: childId }),
        z.array(occurrenceSchema),
        signal,
      ),
    acknowledgeOccurrence: (id) =>
      requestApi(
        "/reading-management/reminders/occurrences/" +
          encodeURIComponent(id) +
          "/acknowledge",
        occurrenceSchema,
        undefined,
        { method: "POST" },
      ),
  };
}
