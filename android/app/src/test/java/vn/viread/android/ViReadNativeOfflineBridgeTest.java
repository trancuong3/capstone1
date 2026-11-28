package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class ViReadNativeOfflineBridgeTest {
    private static final String TRUSTED_ORIGIN = "https://viread-frontend.vercel.app";

    private Context context;
    private TrustedNavigation navigation;
    private ViReadNativeOfflineBridge bridge;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        ViReadNativeOfflineBridge.clearAllSavedPacks(context);
        navigation = new TrustedNavigation(TRUSTED_ORIGIN, false);
        bridge = new ViReadNativeOfflineBridge(
                context,
                () -> navigation,
                new Handler(Looper.getMainLooper()));
    }

    @Test
    public void syncListAndClearPacksAreIsolatedByUserAndTrustedOrigin() throws Exception {
        List<String> replies = new ArrayList<>();

        // Untrusted origin or iframe message must be silently ignored
        bridge.handleIncomingMessage(
                "{\"action\":\"syncPacks\",\"userId\":\"u1\",\"packs\":[]}",
                "https://evil.example.com",
                true,
                replies::add);
        bridge.handleIncomingMessage(
                "{\"action\":\"syncPacks\",\"userId\":\"u1\",\"packs\":[]}",
                TRUSTED_ORIGIN,
                false,
                replies::add);
        assertTrue(replies.isEmpty());

        JSONObject payload = new JSONObject();
        payload.put("requestId", "req-1");
        payload.put("action", "syncPacks");
        payload.put("userId", "parent-a");
        JSONArray packs = new JSONArray();
        JSONObject p1 = new JSONObject();
        p1.put("bookId", "book-123");
        p1.put("title", "Truyện Lục Bát");
        p1.put("pageCount", 6);
        p1.put("savedAt", "2026-11-28T10:00:00Z");
        packs.put(p1);
        payload.put("packs", packs);

        bridge.handleIncomingMessage(payload.toString(), TRUSTED_ORIGIN, true, replies::add);
        assertEquals(1, replies.size());
        JSONObject ack = new JSONObject(replies.get(0));
        assertTrue(ack.getBoolean("ok"));
        assertEquals(1, ack.getInt("count"));

        // Different parent must NOT see parent-a's offline pack metadata
        assertEquals(0, ViReadNativeOfflineBridge.readPacksForUser(context, "parent-b").length());
        assertEquals(1, ViReadNativeOfflineBridge.readPacksForUser(context, "parent-a").length());

        // Clear wipes metadata cleanly
        replies.clear();
        bridge.handleIncomingMessage(
                "{\"requestId\":\"req-2\",\"action\":\"clearPacks\"}",
                TRUSTED_ORIGIN,
                true,
                replies::add);
        JSONObject clearAck = new JSONObject(replies.get(0));
        assertTrue(clearAck.getBoolean("ok"));
        assertEquals("CLEARED", clearAck.getString("status"));
        assertEquals(0, ViReadNativeOfflineBridge.readPacksForUser(context, "parent-a").length());

        // Invalid action returns structured error
        replies.clear();
        bridge.handleIncomingMessage(
                "{\"requestId\":\"req-3\",\"action\":\"unknown\"}",
                TRUSTED_ORIGIN,
                true,
                replies::add);
        JSONObject err = new JSONObject(replies.get(0));
        assertFalse(err.getBoolean("ok"));
    }
}
