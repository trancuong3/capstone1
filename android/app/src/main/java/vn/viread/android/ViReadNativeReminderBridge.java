package vn.viread.android;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Origin-locked Android Local Study Reminder Bridge exposed ONLY via AndroidX
 * {@link WebViewCompat#addWebMessageListener} under {@code window.ViReadNativeReminder}
 * (NEVER {@code @JavascriptInterface}).
 *
 * <p>Syncs {@code ReadingReminder} schedules from the authenticated parent portal into
 * Doze-aware local {@link AlarmManager} notifications without requiring Firebase Cloud Messaging
 * or background server polling.
 */
public final class ViReadNativeReminderBridge implements WebViewCompat.WebMessageListener {
    public static final String JS_OBJECT_NAME = "ViReadNativeReminder";
    static final String PREFS_NAME = "viread_reading_reminders";
    static final String KEY_OWNER_USER_ID = "owner_user_id";
    static final String KEY_REMINDERS_JSON = "reminders_json";
    static final int MAX_REMINDERS = 24;
    private static final int ALARM_BASE_REQUEST_CODE = 42_000;

    interface NavigationProvider {
        TrustedNavigation get();
    }

    interface ReplySender {
        void send(String json);
    }

    public interface HostCallbacks {
        boolean hasNotificationPermission();

        boolean requestNotificationPermission();
    }

    private final Context appContext;
    private final NavigationProvider navigationProvider;
    private final HostCallbacks hostCallbacks;
    private final Handler mainHandler;
    @Nullable
    private ReplySender pendingPermissionReply;
    @Nullable
    private String pendingPermissionRequestId;

    ViReadNativeReminderBridge(
            @NonNull Context context,
            @NonNull NavigationProvider navigationProvider,
            @NonNull HostCallbacks hostCallbacks,
            @NonNull Handler mainHandler) {
        this.appContext = context.getApplicationContext();
        this.navigationProvider = navigationProvider;
        this.hostCallbacks = hostCallbacks;
        this.mainHandler = mainHandler;
    }

    public static ViReadNativeReminderBridge createDefault(
            @NonNull Context context,
            @NonNull NavigationProvider navigationProvider,
            @NonNull HostCallbacks hostCallbacks) {
        return new ViReadNativeReminderBridge(
                context, navigationProvider, hostCallbacks, new Handler(Looper.getMainLooper()));
    }

    public void attachToWebView(@NonNull WebView webView, @NonNull String allowedOrigin) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME);
            } catch (Throwable ignored) {
                // Listener may not be attached yet.
            }
            WebViewCompat.addWebMessageListener(
                    webView,
                    JS_OBJECT_NAME,
                    Collections.singleton(allowedOrigin),
                    this);
        }
    }

    public static void detachFromWebView(@NonNull WebView webView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME);
            } catch (Throwable ignored) {
                // Safe no-op if not attached.
            }
        }
    }

    public void onHostDestroy() {
        pendingPermissionReply = null;
        pendingPermissionRequestId = null;
    }

    public void onNotificationPermissionResult(boolean granted) {
        ReplySender reply = pendingPermissionReply;
        String reqId = pendingPermissionRequestId;
        pendingPermissionReply = null;
        pendingPermissionRequestId = null;
        if (reply != null) {
            sendAck(reply, reqId, true, granted ? "GRANTED" : "DENIED", countScheduledAlarms());
        }
    }

    @Override
    public void onPostMessage(
            @NonNull WebView view,
            @NonNull WebMessageCompat message,
            @NonNull android.net.Uri sourceOrigin,
            boolean isMainFrame,
            @NonNull JavaScriptReplyProxy replyProxy) {
        final String payload = message.getData();
        final String origin = sourceOrigin.toString();
        final ReplySender sender = json -> {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                replyProxy.postMessage(json);
            }
        };
        mainHandler.post(() -> handleIncomingMessage(payload, origin, isMainFrame, sender));
    }

    void handleIncomingMessage(
            @Nullable String rawPayload,
            @Nullable String sourceOrigin,
            boolean isMainFrame,
            @NonNull ReplySender replySender) {
        TrustedNavigation nav = navigationProvider.get();
        if (!isMainFrame || nav == null || sourceOrigin == null || !nav.isTrusted(sourceOrigin)) {
            return;
        }
        if (rawPayload == null || rawPayload.isEmpty() || rawPayload.length() > 32_768) {
            sendError(replySender, null, "INVALID_PAYLOAD");
            return;
        }

        JSONObject obj;
        try {
            obj = new JSONObject(rawPayload);
        } catch (JSONException ex) {
            sendError(replySender, null, "INVALID_JSON");
            return;
        }

        String requestId = sanitizeShortString(obj.optString("requestId", ""), 80);
        String action = sanitizeShortString(obj.optString("action", ""), 40);

        switch (action) {
            case "getStatus": {
                sendAck(
                        replySender,
                        requestId,
                        true,
                        hostCallbacks.hasNotificationPermission() ? "GRANTED" : "PERMISSION_NEEDED",
                        countScheduledAlarms());
                return;
            }
            case "requestNotificationPermission": {
                if (Build.VERSION.SDK_INT < 33 || hostCallbacks.hasNotificationPermission()) {
                    sendAck(replySender, requestId, true, "GRANTED", countScheduledAlarms());
                    return;
                }
                pendingPermissionReply = replySender;
                pendingPermissionRequestId = requestId;
                if (!hostCallbacks.requestNotificationPermission()) {
                    pendingPermissionReply = null;
                    pendingPermissionRequestId = null;
                    sendAck(replySender, requestId, false, "REQUEST_FAILED", countScheduledAlarms());
                }
                return;
            }
            case "syncReminders": {
                String userId = sanitizeShortString(obj.optString("userId", ""), 80);
                if (userId.isEmpty()) {
                    sendError(replySender, requestId, "MISSING_USER_ID");
                    return;
                }
                JSONArray items = obj.optJSONArray("reminders");
                int scheduled = syncRemindersInternal(appContext, userId, items, System.currentTimeMillis());
                sendAck(
                        replySender,
                        requestId,
                        true,
                        hostCallbacks.hasNotificationPermission() ? "SYNCED" : "SYNCED_PERMISSION_NEEDED",
                        scheduled);
                return;
            }
            case "clearReminders": {
                clearAllScheduledReminders(appContext);
                sendAck(replySender, requestId, true, "CLEARED", 0);
                return;
            }
            default:
                sendError(replySender, requestId, "UNSUPPORTED_ACTION");
        }
    }

    static int syncRemindersInternal(
            @NonNull Context context,
            @NonNull String userId,
            @Nullable JSONArray rawItems,
            long nowMillis) {
        cancelAllAlarmIntents(context);
        JSONArray sanitizedList = new JSONArray();
        if (rawItems != null) {
            int limit = Math.min(MAX_REMINDERS, rawItems.length());
            for (int i = 0; i < limit; i++) {
                JSONObject item = rawItems.optJSONObject(i);
                if (item == null || !item.optBoolean("isActive", true)) {
                    continue;
                }
                String id = sanitizeShortString(item.optString("id", ""), 80);
                String remindAt = sanitizeShortString(item.optString("remindAt", ""), 16);
                JSONArray weekdaysJson = item.optJSONArray("weekdays");
                int[] weekdays = parseWeekdays(weekdaysJson);
                if (id.isEmpty() || remindAt.isEmpty() || weekdays.length == 0) {
                    continue;
                }
                String timezone = sanitizeShortString(
                        item.optString("timezone", "Asia/Ho_Chi_Minh"), 64);
                String title = sanitizeShortString(
                        item.optString("title", "ViRead"), 100);
                String body = sanitizeShortString(
                        item.optString("body", "Đến giờ đọc sách cùng bé rồi!"), 200);
                String targetPath = sanitizeTargetPath(item.optString("targetPath", "/dashboard"));

                try {
                    JSONObject clean = new JSONObject();
                    clean.put("slot", sanitizedList.length());
                    clean.put("id", id);
                    clean.put("remindAt", remindAt);
                    JSONArray cleanDays = new JSONArray();
                    for (int d : weekdays) {
                        cleanDays.put(d);
                    }
                    clean.put("weekdays", cleanDays);
                    clean.put("timezone", timezone);
                    clean.put("title", title);
                    clean.put("body", body);
                    clean.put("targetPath", targetPath);
                    sanitizedList.put(clean);
                } catch (JSONException ignored) {
                    // Skip malformed item.
                }
            }
        }

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_OWNER_USER_ID, userId)
                .putString(KEY_REMINDERS_JSON, sanitizedList.toString())
                .apply();

        return scheduleSavedReminders(context, nowMillis);
    }

    static int scheduleSavedReminders(@NonNull Context context, long nowMillis) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_REMINDERS_JSON, "[]");
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null || raw == null) {
            return 0;
        }
        int scheduled = 0;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length() && i < MAX_REMINDERS; i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                int slot = item.optInt("slot", i);
                String remindAt = item.optString("remindAt", "");
                int[] weekdays = parseWeekdays(item.optJSONArray("weekdays"));
                String timezone = item.optString("timezone", "Asia/Ho_Chi_Minh");
                long triggerAt = computeNextTriggerMillis(nowMillis, remindAt, weekdays, timezone);
                if (triggerAt <= nowMillis) continue;

                PendingIntent pi = buildAlarmPendingIntent(context, slot, item, PendingIntent.FLAG_UPDATE_CURRENT);
                if (pi != null) {
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                    scheduled++;
                }
            }
        } catch (JSONException ignored) {
            return 0;
        }
        return scheduled;
    }

    public static void clearAllScheduledReminders(@NonNull Context context) {
        cancelAllAlarmIntents(context);
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().clear().apply();
    }

    private static void cancelAllAlarmIntents(@NonNull Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        for (int slot = 0; slot < MAX_REMINDERS; slot++) {
            Intent intent = new Intent(context, ReadingReminderReceiver.class);
            intent.setAction(ReadingReminderReceiver.ACTION_FIRE_REMINDER);
            PendingIntent pi = PendingIntent.getBroadcast(
                    context,
                    ALARM_BASE_REQUEST_CODE + slot,
                    intent,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (pi != null) {
                alarmManager.cancel(pi);
                pi.cancel();
            }
        }
    }

    @Nullable
    static PendingIntent buildAlarmPendingIntent(
            @NonNull Context context,
            int slot,
            @NonNull JSONObject item,
            int extraFlags) {
        if (slot < 0 || slot >= MAX_REMINDERS) return null;
        Intent intent = new Intent(context, ReadingReminderReceiver.class);
        intent.setAction(ReadingReminderReceiver.ACTION_FIRE_REMINDER);
        intent.putExtra(ReadingReminderReceiver.EXTRA_SLOT, slot);
        intent.putExtra(ReadingReminderReceiver.EXTRA_REMINDER_ID, item.optString("id", ""));
        intent.putExtra(ReadingReminderReceiver.EXTRA_TITLE, item.optString("title", "ViRead"));
        intent.putExtra(ReadingReminderReceiver.EXTRA_BODY, item.optString("body", ""));
        intent.putExtra(ReadingReminderReceiver.EXTRA_TARGET_PATH, item.optString("targetPath", "/dashboard"));
        return PendingIntent.getBroadcast(
                context,
                ALARM_BASE_REQUEST_CODE + slot,
                intent,
                extraFlags | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Computes next epoch millis strictly after {@code nowMillis} for ViRead's weekday convention
     * ({@code 0 = Monday .. 6 = Sunday}) and {@code HH:MM[:SS]} time string.
     */
    static long computeNextTriggerMillis(
            long nowMillis,
            @NonNull String remindAt,
            @NonNull int[] weekdays,
            @Nullable String timezoneId) {
        if (weekdays.length == 0) return -1L;
        LocalTime localTime = parseRemindTime(remindAt);
        if (localTime == null) return -1L;

        ZoneId zone;
        try {
            zone = (timezoneId != null && !timezoneId.trim().isEmpty())
                    ? ZoneId.of(timezoneId.trim())
                    : ZoneId.of("Asia/Ho_Chi_Minh");
        } catch (Throwable ignored) {
            zone = ZoneId.of("Asia/Ho_Chi_Minh");
        }

        Set<Integer> allowedDays = new HashSet<>();
        for (int d : weekdays) {
            if (d >= 0 && d <= 6) {
                allowedDays.add(d);
            }
        }
        if (allowedDays.isEmpty()) return -1L;

        ZonedDateTime nowZdt = Instant.ofEpochMilli(nowMillis).atZone(zone);
        for (int dayOffset = 0; dayOffset <= 7; dayOffset++) {
            ZonedDateTime candidateDate = nowZdt.plusDays(dayOffset);
            DayOfWeek dow = candidateDate.getDayOfWeek();
            int vireadWeekday = dow.getValue() - 1; // Monday=1 -> 0 .. Sunday=7 -> 6
            if (!allowedDays.contains(vireadWeekday)) {
                continue;
            }
            ZonedDateTime candidate = candidateDate
                    .withHour(localTime.getHour())
                    .withMinute(localTime.getMinute())
                    .withSecond(0)
                    .withNano(0);
            long epochMs = candidate.toInstant().toEpochMilli();
            if (epochMs > nowMillis + 2_000L) {
                return epochMs;
            }
        }
        return -1L;
    }

    @Nullable
    private static LocalTime parseRemindTime(@NonNull String raw) {
        String[] parts = raw.trim().split(":");
        if (parts.length < 2) return null;
        try {
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return null;
            }
            return LocalTime.of(hour, minute);
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static int[] parseWeekdays(@Nullable JSONArray arr) {
        if (arr == null) return new int[0];
        List<Integer> list = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            int d = arr.optInt(i, -1);
            if (d >= 0 && d <= 6 && !list.contains(d)) {
                list.add(d);
            }
        }
        int[] out = new int[list.size()];
        for (int i = 0; i < list.size(); i++) {
            out[i] = list.get(i);
        }
        return out;
    }

    static String sanitizeTargetPath(@Nullable String path) {
        if (path == null) return "/dashboard";
        String trimmed = path.trim();
        if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.contains("..")) {
            return "/dashboard";
        }
        return trimmed.length() > 160 ? "/dashboard" : trimmed;
    }

    private static String sanitizeShortString(@Nullable String value, int maxLen) {
        if (value == null) return "";
        String clean = value.replace('\0', ' ').trim();
        return clean.length() > maxLen ? clean.substring(0, maxLen) : clean;
    }

    private int countScheduledAlarms() {
        SharedPreferences prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_REMINDERS_JSON, "[]");
        try {
            return raw != null ? new JSONArray(raw).length() : 0;
        } catch (JSONException ex) {
            return 0;
        }
    }

    private static void sendAck(
            @NonNull ReplySender sender,
            @Nullable String requestId,
            boolean ok,
            @NonNull String status,
            int scheduledCount) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "reminder_ack");
            if (requestId != null && !requestId.isEmpty()) {
                out.put("requestId", requestId);
            }
            out.put("ok", ok);
            out.put("status", status);
            out.put("sdkInt", Build.VERSION.SDK_INT);
            out.put("scheduledCount", scheduledCount);
            sender.send(out.toString());
        } catch (JSONException ignored) {
            // Safe ignore.
        }
    }

    private static void sendError(
            @NonNull ReplySender sender,
            @Nullable String requestId,
            @NonNull String errorCode) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "reminder_error");
            if (requestId != null && !requestId.isEmpty()) {
                out.put("requestId", requestId);
            }
            out.put("ok", false);
            out.put("code", errorCode);
            sender.send(out.toString());
        } catch (JSONException ignored) {
            // Safe ignore.
        }
    }
}
