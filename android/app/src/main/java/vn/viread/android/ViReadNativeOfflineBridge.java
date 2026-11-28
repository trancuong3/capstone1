package vn.viread.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Exact-origin locked Android Offline Reading Pack metadata bridge exposed ONLY via
 * {@link WebViewCompat#addWebMessageListener} under {@code window.ViReadNativeOffline}
 * (NEVER {@code @JavascriptInterface}).
 *
 * <p>Persists user-isolated offline pack metadata so the native shell knows which books have
 * verified offline packs cached for the currently signed-in parent account, and wipes metadata
 * immediately upon sign-out or account switch.
 */
public final class ViReadNativeOfflineBridge implements WebViewCompat.WebMessageListener {
    public static final String JS_OBJECT_NAME = "ViReadNativeOffline";
    static final String PREFS_NAME = "viread_offline_reading_packs";
    static final String KEY_OWNER_USER_ID = "owner_user_id";
    static final String KEY_PACKS_JSON = "packs_json";
    static final int MAX_PACKS = 40;

    interface NavigationProvider {
        TrustedNavigation get();
    }

    interface ReplySender {
        void send(String json);
    }

    private final Context appContext;
    private final NavigationProvider navigationProvider;
    private final Handler mainHandler;

    ViReadNativeOfflineBridge(
            @NonNull Context context,
            @NonNull NavigationProvider navigationProvider,
            @NonNull Handler mainHandler) {
        this.appContext = context.getApplicationContext();
        this.navigationProvider = navigationProvider;
        this.mainHandler = mainHandler;
    }

    public static ViReadNativeOfflineBridge createDefault(
            @NonNull Context context,
            @NonNull NavigationProvider navigationProvider) {
        return new ViReadNativeOfflineBridge(
                context, navigationProvider, new Handler(Looper.getMainLooper()));
    }

    public void attachToWebView(@NonNull WebView webView, @NonNull String allowedOrigin) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME);
            } catch (Throwable ignored) {
                // Safe no-op if not attached yet.
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
            case "syncPacks": {
                String userId = sanitizeShortString(obj.optString("userId", ""), 80);
                if (userId.isEmpty()) {
                    sendError(replySender, requestId, "MISSING_USER_ID");
                    return;
                }
                int savedCount = syncPacksInternal(appContext, userId, obj.optJSONArray("packs"));
                sendAck(replySender, requestId, "SYNCED", savedCount, readPacksForUser(appContext, userId));
                return;
            }
            case "listPacks": {
                String userId = sanitizeShortString(obj.optString("userId", ""), 80);
                if (userId.isEmpty()) {
                    sendError(replySender, requestId, "MISSING_USER_ID");
                    return;
                }
                JSONArray packs = readPacksForUser(appContext, userId);
                sendAck(replySender, requestId, "OK", packs.length(), packs);
                return;
            }
            case "clearPacks": {
                clearAllSavedPacks(appContext);
                sendAck(replySender, requestId, "CLEARED", 0, new JSONArray());
                return;
            }
            default:
                sendError(replySender, requestId, "UNSUPPORTED_ACTION");
        }
    }

    static int syncPacksInternal(
            @NonNull Context context,
            @NonNull String userId,
            @Nullable JSONArray rawPacks) {
        JSONArray cleanArr = new JSONArray();
        if (rawPacks != null) {
            int limit = Math.min(MAX_PACKS, rawPacks.length());
            for (int i = 0; i < limit; i++) {
                JSONObject item = rawPacks.optJSONObject(i);
                if (item == null) continue;
                String bookId = sanitizeShortString(item.optString("bookId", ""), 80);
                String title = sanitizeShortString(item.optString("title", ""), 140);
                int pageCount = Math.max(0, Math.min(500, item.optInt("pageCount", 0)));
                String savedAt = sanitizeShortString(item.optString("savedAt", ""), 48);
                if (bookId.isEmpty() || pageCount <= 0) continue;
                try {
                    JSONObject clean = new JSONObject();
                    clean.put("bookId", bookId);
                    clean.put("title", title.isEmpty() ? "ViRead" : title);
                    clean.put("pageCount", pageCount);
                    clean.put("savedAt", savedAt);
                    cleanArr.put(clean);
                } catch (JSONException ignored) {
                    // Skip malformed item.
                }
            }
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_OWNER_USER_ID, userId)
                .putString(KEY_PACKS_JSON, cleanArr.toString())
                .apply();
        return cleanArr.length();
    }

    @NonNull
    static JSONArray readPacksForUser(@NonNull Context context, @NonNull String userId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String owner = prefs.getString(KEY_OWNER_USER_ID, "");
        if (owner == null || !owner.equals(userId)) {
            return new JSONArray();
        }
        String raw = prefs.getString(KEY_PACKS_JSON, "[]");
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException ex) {
            return new JSONArray();
        }
    }

    public static void clearAllSavedPacks(@NonNull Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().clear().apply();
    }

    private static String sanitizeShortString(@Nullable String value, int maxLen) {
        if (value == null) return "";
        String clean = value.replace('\0', ' ').trim();
        return clean.length() > maxLen ? clean.substring(0, maxLen) : clean;
    }

    private static void sendAck(
            @NonNull ReplySender sender,
            @Nullable String requestId,
            @NonNull String status,
            int count,
            @NonNull JSONArray packs) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "offline_pack_ack");
            if (requestId != null && !requestId.isEmpty()) {
                out.put("requestId", requestId);
            }
            out.put("ok", true);
            out.put("status", status);
            out.put("count", count);
            out.put("packs", packs);
            sender.send(out.toString());
        } catch (JSONException ignored) {
            // Safe ignore.
        }
    }

    private static void sendError(
            @NonNull ReplySender sender,
            @Nullable String requestId,
            @NonNull String code) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "offline_pack_error");
            if (requestId != null && !requestId.isEmpty()) {
                out.put("requestId", requestId);
            }
            out.put("ok", false);
            out.put("code", code);
            sender.send(out.toString());
        } catch (JSONException ignored) {
            // Safe ignore.
        }
    }
}
