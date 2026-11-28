package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import java.time.ZonedDateTime;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class ViReadNativeReminderBridgeTest {
    private static final String TRUSTED_ORIGIN = "https://viread-frontend.vercel.app";
    private Context context;
    private TrustedNavigation trustedNav;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        trustedNav = new TrustedNavigation(TRUSTED_ORIGIN, false);
        ViReadNativeReminderBridge.clearAllScheduledReminders(context);
    }

    @Test
    public void rejectsUntrustedOriginAndSubframes() {
        ViReadNativeReminderBridge bridge = new ViReadNativeReminderBridge(
                context,
                () -> trustedNav,
                new ViReadNativeReminderBridge.HostCallbacks() {
                    @Override
                    public boolean hasNotificationPermission() {
                        return true;
                    }

                    @Override
                    public boolean requestNotificationPermission() {
                        return true;
                    }
                },
                new Handler(Looper.getMainLooper()));

        AtomicReference<String> reply = new AtomicReference<>();
        bridge.handleIncomingMessage(
                "{\"action\":\"getStatus\",\"requestId\":\"r1\"}",
                "https://evil.example.com",
                true,
                reply::set);
        assertNull("Untrusted origin must be ignored silently", reply.get());

        bridge.handleIncomingMessage(
                "{\"action\":\"getStatus\",\"requestId\":\"r2\"}",
                TRUSTED_ORIGIN,
                false,
                reply::set);
        assertNull("Iframe message must be ignored silently", reply.get());
    }

    @Test
    public void syncsSchedulesComputesNextTriggerAndClearsOnLogout() throws Exception {
        AtomicBoolean permissionGranted = new AtomicBoolean(true);
        ViReadNativeReminderBridge bridge = new ViReadNativeReminderBridge(
                context,
                () -> trustedNav,
                new ViReadNativeReminderBridge.HostCallbacks() {
                    @Override
                    public boolean hasNotificationPermission() {
                        return permissionGranted.get();
                    }

                    @Override
                    public boolean requestNotificationPermission() {
                        return true;
                    }
                },
                new Handler(Looper.getMainLooper()));

        long mondayMorning = ZonedDateTime.parse("2026-11-30T08:00:00+07:00")
                .toInstant()
                .toEpochMilli();
        // Monday is 0 in ViRead weekday convention; 19:30 same day must be chosen!
        long trigger = ViReadNativeReminderBridge.computeNextTriggerMillis(
                mondayMorning,
                "19:30",
                new int[]{0, 2, 4},
                "Asia/Ho_Chi_Minh");
        long expected = ZonedDateTime.parse("2026-11-30T19:30:00+07:00")
                .toInstant()
                .toEpochMilli();
        assertEquals(expected, trigger);

        AtomicReference<String> syncReply = new AtomicReference<>();
        String payload = "{"
                + "\"action\":\"syncReminders\","
                + "\"requestId\":\"sync-1\","
                + "\"userId\":\"parent-uuid-1\","
                + "\"reminders\":[{"
                + "\"id\":\"rem-1\","
                + "\"isActive\":true,"
                + "\"remindAt\":\"19:30\","
                + "\"weekdays\":[0,2,4],"
                + "\"timezone\":\"Asia/Ho_Chi_Minh\","
                + "\"title\":\"ViRead\","
                + "\"body\":\"Đến giờ đọc sách!\","
                + "\"targetPath\":\"/dashboard\""
                + "}]"
                + "}";

        bridge.handleIncomingMessage(payload, TRUSTED_ORIGIN, true, syncReply::set);
        assertNotNull(syncReply.get());
        JSONObject ack = new JSONObject(syncReply.get());
        assertTrue(ack.getBoolean("ok"));
        assertEquals("SYNCED", ack.getString("status"));
        assertEquals(1, ack.getInt("scheduledCount"));

        AtomicReference<String> clearReply = new AtomicReference<>();
        bridge.handleIncomingMessage(
                "{\"action\":\"clearReminders\",\"requestId\":\"clr-1\"}",
                TRUSTED_ORIGIN,
                true,
                clearReply::set);
        JSONObject clearAck = new JSONObject(clearReply.get());
        assertTrue(clearAck.getBoolean("ok"));
        assertEquals(0, clearAck.getInt("scheduledCount"));
    }
}
