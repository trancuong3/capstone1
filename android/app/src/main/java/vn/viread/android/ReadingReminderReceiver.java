package vn.viread.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

/**
 * Fires scheduled local reading reminder notifications and reschedules saved weekly reminders
 * across device reboots ({@link Intent#ACTION_BOOT_COMPLETED}).
 */
public final class ReadingReminderReceiver extends BroadcastReceiver {
    public static final String ACTION_FIRE_REMINDER = "vn.viread.android.ACTION_READING_REMINDER";
    public static final String CHANNEL_ID = "viread_reading_reminders";
    static final String EXTRA_SLOT = "slot";
    static final String EXTRA_REMINDER_ID = "reminder_id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_TARGET_PATH = "target_path";
    static final String EXTRA_LAUNCH_PATH = "vn.viread.android.EXTRA_LAUNCH_PATH";
    private static final int NOTIFICATION_BASE_ID = 52_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) {
            return;
        }
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            ViReadNativeReminderBridge.scheduleSavedReminders(context, System.currentTimeMillis());
            return;
        }
        if (!ACTION_FIRE_REMINDER.equals(action)) {
            return;
        }

        int slot = intent.getIntExtra(EXTRA_SLOT, 0);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String body = intent.getStringExtra(EXTRA_BODY);
        String targetPath = ViReadNativeReminderBridge.sanitizeTargetPath(
                intent.getStringExtra(EXTRA_TARGET_PATH));

        postReminderNotificationIfPermitted(
                context,
                slot,
                (title != null && !title.trim().isEmpty()) ? title.trim() : "ViRead",
                (body != null && !body.trim().isEmpty()) ? body.trim() : "Đến giờ đọc sách cùng bé rồi!",
                targetPath);

        // Reschedule the next weekly occurrence after firing.
        ViReadNativeReminderBridge.scheduleSavedReminders(
                context, System.currentTimeMillis() + 5_000L);
    }

    @SuppressLint("MissingPermission")
    static boolean postReminderNotificationIfPermitted(
            @NonNull Context context,
            int slot,
            @NonNull String title,
            @NonNull String body,
            @NonNull String targetPath) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return false;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "ViRead Reading Reminders",
                NotificationManager.IMPORTANCE_DEFAULT);
        manager.createNotificationChannel(channel);

        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        openIntent.putExtra(EXTRA_LAUNCH_PATH, targetPath);

        int safeSlot = Math.max(0, Math.min(ViReadNativeReminderBridge.MAX_REMINDERS - 1, slot));
        PendingIntent contentIntent = PendingIntent.getActivity(
                context,
                NOTIFICATION_BASE_ID + safeSlot,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(contentIntent);

        manager.notify(NOTIFICATION_BASE_ID + safeSlot, builder.build());
        return true;
    }
}
