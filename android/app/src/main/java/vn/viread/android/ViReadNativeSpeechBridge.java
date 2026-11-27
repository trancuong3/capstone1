package vn.viread.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Origin-locked Android Native Speech Bridge exposed ONLY via AndroidX
 * {@link WebViewCompat#addWebMessageListener} under {@code window.ViReadNativeSpeech}
 * (NEVER {@code @JavascriptInterface} / {@code addJavascriptInterface}).
 *
 * <p>Security & reliability invariants:
 * <ul>
 *   <li>Accepts messages strictly from main frame ({@code isMainFrame == true}) and exact
 *       trusted HTTPS origin ({@code TrustedNavigation.isTrusted(sourceOrigin)}).</li>
 *   <li>Enforces atomic TTS/STT mutual exclusion on the Main Looper: starting TTS immediately
 *       cancels/destroys any active {@link SpeechRecognizer} and waits 150ms for Android audio
 *       HAL settle; starting STT immediately stops TTS and abandons audio focus.</li>
 *   <li>Streams {@code tts_range} from API 26+ {@link UtteranceProgressListener#onRangeStart}
 *       for synchronized word highlighting and {@code stt_onset} ({@code System.currentTimeMillis()})
 *       for EchoGuard false-rejection prevention.</li>
 * </ul>
 */
public final class ViReadNativeSpeechBridge implements WebViewCompat.WebMessageListener {
    public static final String JS_OBJECT_NAME = "ViReadNativeSpeech";
    public static final String PLATFORM_ID = "android-webview";
    public static final String DEFAULT_LANG = "vi-VN";
    public static final int MAX_SPEAK_TEXT_LENGTH = 2500;
    public static final float MIN_SPEECH_RATE = 0.6f;
    public static final float MAX_SPEECH_RATE = 1.4f;
    public static final float MIN_SPEECH_PITCH = 0.5f;
    public static final float MAX_SPEECH_PITCH = 2.0f;
    public static final long STT_TO_TTS_SETTLE_MS = 150L;
    public static final long TTS_INIT_TIMEOUT_MS = 2_500L;
    public static final long STT_STOP_FALLBACK_TIMEOUT_MS = 2_000L;
    public static final long COMPLETE_SILENCE_LENGTH_MS = 1_500L;
    public static final long POSSIBLY_COMPLETE_SILENCE_LENGTH_MS = 1_000L;
    public static final int DEFAULT_MAX_RESULTS = 3;
    public static final int MIN_MAX_RESULTS = 1;
    public static final int MAX_MAX_RESULTS = 5;
    private static final long RMS_EMIT_MIN_INTERVAL_MS = 80L;

    interface NavigationProvider {
        TrustedNavigation get();
    }

    interface ReplySender {
        void send(String json);
    }

    interface Clock {
        long currentTimeMillis();

        long elapsedRealtime();
    }

    interface Scheduler {
        void post(Runnable runnable);

        void postDelayed(Runnable runnable, long delayMs);

        void removeCallbacks(Runnable runnable);
    }

    interface AudioFocusController {
        boolean requestSpeechFocus(AudioAttributes attributes, Runnable onFocusLoss);

        void abandonFocus();
    }

    interface TtsInitCallback {
        void onInitComplete(boolean success);
    }

    interface TtsCallback {
        void onStart(String utteranceId);

        void onRangeStart(String utteranceId, int start, int end, int frame);

        void onDone(String utteranceId);

        void onError(String utteranceId, int errorCode);

        void onStop(String utteranceId, boolean interrupted);
    }

    interface TtsEngine {
        void initialize(TtsInitCallback callback);

        boolean isReady();

        int getVietnameseVoicesCount();

        boolean isVietnameseAvailable();

        boolean speak(
                String text,
                float rate,
                float pitch,
                String utteranceId,
                AudioAttributes attributes,
                TtsCallback callback);

        default boolean speak(
                String text,
                float rate,
                float pitch,
                @Nullable String voiceGender,
                @Nullable String voiceId,
                String utteranceId,
                AudioAttributes attributes,
                TtsCallback callback) {
            return speak(text, rate, pitch, utteranceId, attributes, callback);
        }

        void stop();

        void shutdown();
    }

    interface SttSessionCallback {
        void onReadyForSpeech();

        void onBeginningOfSpeech();

        void onRmsChanged(float rmsDb);

        void onPartialResults(List<String> matches);

        void onFinalResults(List<String> matches, @Nullable float[] confidences);

        void onError(int errorCode);

        void onEndOfSpeech();
    }

    interface SttSession {
        boolean isOnDevice();

        void startListening(Intent recognizerIntent);

        void stopListening();

        void cancel();

        void destroy();
    }

    interface SttEngineFactory {
        boolean isSttAvailable();

        boolean isOnDeviceSttAvailable();

        @Nullable
        SttSession create(boolean preferOnDevice, SttSessionCallback callback);
    }

    interface HostCallbacks {
        boolean hasRecordAudioPermission();

        /**
         * Requests {@link Manifest.permission#RECORD_AUDIO}. Returns {@code true} if a runtime
         * prompt was launched (result will arrive via {@link #onRecordAudioPermissionResult}),
         * or {@code false} if permission cannot be requested right now.
         */
        boolean requestRecordAudioPermission();

        boolean openTtsInstallSettings();

        String getPackageName();
    }

    private static final class PendingCapabilitiesRequest {
        final String requestId;
        final ReplySender reply;

        PendingCapabilitiesRequest(String requestId, ReplySender reply) {
            this.requestId = requestId;
            this.reply = reply;
        }
    }

    private static final class PendingSpeakRequest {
        final int generation;
        final String requestId;
        final String text;
        final float rate;
        final float pitch;
        @Nullable final String voiceGender;
        @Nullable final String voiceId;
        final ReplySender reply;

        PendingSpeakRequest(
                int generation,
                String requestId,
                String text,
                float rate,
                float pitch,
                @Nullable String voiceGender,
                @Nullable String voiceId,
                ReplySender reply) {
            this.generation = generation;
            this.requestId = requestId;
            this.text = text;
            this.rate = rate;
            this.pitch = pitch;
            this.voiceGender = voiceGender;
            this.voiceId = voiceId;
            this.reply = reply;
        }
    }

    private static final class PendingSttRequest {
        final int generation;
        final String requestId;
        final String lang;
        final boolean partialResults;
        final int maxResults;
        final ReplySender reply;

        PendingSttRequest(
                int generation,
                String requestId,
                String lang,
                boolean partialResults,
                int maxResults,
                ReplySender reply) {
            this.generation = generation;
            this.requestId = requestId;
            this.lang = lang;
            this.partialResults = partialResults;
            this.maxResults = maxResults;
            this.reply = reply;
        }
    }

    private final NavigationProvider navigationProvider;
    private final TtsEngine ttsEngine;
    private final SttEngineFactory sttEngineFactory;
    private final AudioFocusController audioFocusController;
    private final HostCallbacks hostCallbacks;
    private final Scheduler scheduler;
    private final Clock clock;
    private final AudioAttributes speechAudioAttributes;

    private final List<PendingCapabilitiesRequest> pendingCapabilities = new ArrayList<>();
    private boolean ttsInitRequested;
    private boolean ttsInitCompleted;
    private boolean ttsInitSucceeded;
    private Runnable ttsInitTimeoutRunnable;

    private int ttsSeq;
    private int sttSeq;
    private Runnable pendingSpeakSettleRunnable;
    private PendingSpeakRequest queuedSpeakWhileTtsInitializing;
    private String activeTtsRequestId;
    private String activeTtsUtteranceId;
    private ReplySender activeTtsReply;

    private PendingSttRequest pendingPermissionSttRequest;
    private SttSession activeSttSession;
    private PendingSttRequest activeSttRequest;
    private long activeSttOnsetAt;
    private long lastRmsEmitElapsedMs;
    private boolean activeSttReceivedResults;
    private boolean activeSttUsedCloudFallback;
    private int activeSttBusyRetries;
    private Runnable sttBusyRetryRunnable;
    private boolean onDeviceViUnsupported;
    private Runnable sttStopFallbackRunnable;
    private long lastSttStopElapsedMs = -1L;
    private static final int MAX_STT_BUSY_RETRIES = 2;
    private static final long STT_BUSY_RETRY_DELAY_MS = 220L;

    private boolean destroyed;

    public static ViReadNativeSpeechBridge createDefault(
            Activity activity,
            NavigationProvider navigationProvider,
            HostCallbacks hostCallbacks) {
        Context appContext = activity.getApplicationContext();
        Handler mainHandler = new Handler(Looper.getMainLooper());
        Scheduler scheduler = new MainHandlerScheduler(mainHandler);
        Clock clock = new SystemClockAdapter();
        return new ViReadNativeSpeechBridge(
                navigationProvider,
                new AndroidTtsEngine(appContext),
                new AndroidSttEngineFactory(appContext),
                new AndroidAudioFocusController(appContext, mainHandler),
                hostCallbacks,
                scheduler,
                clock);
    }

    ViReadNativeSpeechBridge(
            NavigationProvider navigationProvider,
            TtsEngine ttsEngine,
            SttEngineFactory sttEngineFactory,
            AudioFocusController audioFocusController,
            HostCallbacks hostCallbacks,
            Scheduler scheduler,
            Clock clock) {
        this.navigationProvider = navigationProvider;
        this.ttsEngine = ttsEngine;
        this.sttEngineFactory = sttEngineFactory;
        this.audioFocusController = audioFocusController;
        this.hostCallbacks = hostCallbacks;
        this.scheduler = scheduler;
        this.clock = clock;
        this.speechAudioAttributes = createSpeechAudioAttributes();
    }

    public static AudioAttributes createSpeechAudioAttributes() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
    }

    /**
     * Registers this bridge on {@code webView} restricted strictly to {@code origin} via
     * AndroidX {@link WebViewCompat#addWebMessageListener}. Returns {@code true} if registered.
     */
    public boolean attachToWebView(WebView webView, String origin) {
        if (webView == null || origin == null || origin.isEmpty()) {
            return false;
        }
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                return false;
            }
            WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME);
            WebViewCompat.addWebMessageListener(
                    webView,
                    JS_OBJECT_NAME,
                    Collections.singleton(origin),
                    this);
            return true;
        } catch (Throwable ignored) {
            // Safe fallback when WebView provider is unavailable (e.g. JVM Robolectric tests).
            return false;
        }
    }

    /**
     * Removes the registered listener from {@code webView} safely.
     */
    public static void detachFromWebView(WebView webView) {
        if (webView == null) return;
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME);
            }
        } catch (Throwable ignored) {
            // Ignore when WebView provider is unavailable.
        }
    }

    @Override
    public void onPostMessage(
            @NonNull WebView view,
            @NonNull WebMessageCompat message,
            @NonNull Uri sourceOrigin,
            boolean isMainFrame,
            @NonNull JavaScriptReplyProxy replyProxy) {
        String originStr = sourceOrigin != null ? sourceOrigin.toString() : null;
        String payload = message != null ? message.getData() : null;
        ReplySender sender = json -> {
            try {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    replyProxy.postMessage(json);
                }
            } catch (Throwable ignored) {
                // Document navigated away or WebView destroyed.
            }
        };
        handleIncomingMessage(payload, originStr, isMainFrame, sender);
    }

    /**
     * Origin-locked message entrypoint (package-private for JVM/Robolectric unit testing).
     */
    void handleIncomingMessage(
            @Nullable String rawPayload,
            @Nullable String sourceOrigin,
            boolean isMainFrame,
            @NonNull ReplySender reply) {
        if (destroyed || !isMainFrame || sourceOrigin == null) {
            return;
        }
        TrustedNavigation nav = navigationProvider.get();
        if (nav == null || !nav.isTrusted(sourceOrigin)) {
            return;
        }
        if (rawPayload == null || rawPayload.trim().isEmpty()) {
            sendBridgeError(reply, "", "invalid_json", "Empty message payload");
            return;
        }
        final JSONObject obj;
        try {
            obj = new JSONObject(rawPayload);
        } catch (JSONException ex) {
            sendBridgeError(reply, "", "invalid_json", "Malformed JSON payload");
            return;
        }

        final String action = obj.optString("action", "").trim();
        final String requestId = obj.optString("requestId", "");
        if (action.isEmpty()) {
            sendBridgeError(reply, requestId, "unknown_action", "Missing action");
            return;
        }

        scheduler.post(() -> dispatchTrustedActionOnMain(action, requestId, obj, reply));
    }

    private void dispatchTrustedActionOnMain(
            String action, String requestId, JSONObject payload, ReplySender reply) {
        if (destroyed) return;
        switch (action) {
            case "getCapabilities":
                handleGetCapabilities(requestId, reply);
                break;
            case "speak":
                handleSpeak(requestId, payload, reply);
                break;
            case "stopSpeak":
                handleStopSpeak(requestId, reply);
                break;
            case "openTtsInstallSettings":
                handleOpenTtsInstallSettings(requestId, reply);
                break;
            case "startStt":
                handleStartStt(requestId, payload, reply);
                break;
            case "stopStt":
                handleStopStt(requestId, reply);
                break;
            case "cancelStt":
                handleCancelStt(requestId, reply);
                break;
            default:
                sendBridgeError(reply, requestId, "unknown_action", "Unsupported action: " + action);
                break;
        }
    }

    private void ensureTtsInitialized() {
        if (ttsInitRequested || destroyed) {
            return;
        }
        ttsInitRequested = true;
        ttsInitTimeoutRunnable = () -> {
            if (!ttsInitCompleted && !destroyed) {
                ttsInitCompleted = true;
                ttsInitSucceeded = false;
                flushPendingAfterTtsInit();
            }
        };
        scheduler.postDelayed(ttsInitTimeoutRunnable, TTS_INIT_TIMEOUT_MS);
        try {
            ttsEngine.initialize(success -> scheduler.post(() -> {
                if (destroyed) return;
                if (ttsInitTimeoutRunnable != null) {
                    scheduler.removeCallbacks(ttsInitTimeoutRunnable);
                    ttsInitTimeoutRunnable = null;
                }
                if (!ttsInitCompleted) {
                    ttsInitCompleted = true;
                    ttsInitSucceeded = success;
                    flushPendingAfterTtsInit();
                } else if (success && !ttsInitSucceeded) {
                    // Late init succeeded after timeout; make subsequent calls work.
                    ttsInitSucceeded = true;
                }
            }));
        } catch (Throwable ex) {
            if (ttsInitTimeoutRunnable != null) {
                scheduler.removeCallbacks(ttsInitTimeoutRunnable);
                ttsInitTimeoutRunnable = null;
            }
            ttsInitCompleted = true;
            ttsInitSucceeded = false;
            flushPendingAfterTtsInit();
        }
    }

    private void flushPendingAfterTtsInit() {
        if (!pendingCapabilities.isEmpty()) {
            List<PendingCapabilitiesRequest> snapshot = new ArrayList<>(pendingCapabilities);
            pendingCapabilities.clear();
            for (PendingCapabilitiesRequest req : snapshot) {
                sendCapabilities(req.requestId, req.reply);
            }
        }
        if (queuedSpeakWhileTtsInitializing != null) {
            PendingSpeakRequest pending = queuedSpeakWhileTtsInitializing;
            queuedSpeakWhileTtsInitializing = null;
            if (pending.generation == ttsSeq && !destroyed) {
                executeSpeakNow(pending);
            }
        }
    }

    private void handleGetCapabilities(String requestId, ReplySender reply) {
        if (!ttsInitCompleted) {
            pendingCapabilities.add(new PendingCapabilitiesRequest(requestId, reply));
            ensureTtsInitialized();
            return;
        }
        sendCapabilities(requestId, reply);
    }

    private void sendCapabilities(String requestId, ReplySender reply) {
        int viVoicesCount = (ttsInitSucceeded && ttsEngine.isReady())
                ? Math.max(0, ttsEngine.getVietnameseVoicesCount())
                : 0;
        boolean ttsAvailable = ttsInitSucceeded
                && ttsEngine.isReady()
                && (viVoicesCount > 0 || ttsEngine.isVietnameseAvailable());
        boolean onDeviceSttAvailable = sttEngineFactory.isOnDeviceSttAvailable();
        boolean sttAvailable = sttEngineFactory.isSttAvailable() || onDeviceSttAvailable;

        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "capabilities");
        putSafe(evt, "requestId", requestId);
        putSafe(evt, "ttsAvailable", ttsAvailable);
        putSafe(evt, "viVoicesCount", viVoicesCount);
        putSafe(evt, "sttAvailable", sttAvailable);
        putSafe(evt, "onDeviceSttAvailable", onDeviceSttAvailable);
        putSafe(evt, "platform", PLATFORM_ID);
        sendJson(reply, evt);
    }

    private void handleSpeak(String requestId, JSONObject payload, ReplySender reply) {
        String rawText = payload.isNull("text") ? null : payload.optString("text", null);
        if (rawText == null || rawText.trim().isEmpty()) {
            sendTtsError(reply, requestId, "invalid_text", "Speak text must be non-empty");
            return;
        }
        if (rawText.length() > MAX_SPEAK_TEXT_LENGTH) {
            sendTtsError(
                    reply,
                    requestId,
                    "text_too_long",
                    "Speak text exceeds " + MAX_SPEAK_TEXT_LENGTH + " characters");
            return;
        }

        float rate = clampFloat(
                payload.has("rate") && !payload.isNull("rate")
                        ? (float) payload.optDouble("rate", 1.0)
                        : 1.0f,
                MIN_SPEECH_RATE,
                MAX_SPEECH_RATE,
                1.0f);
        float pitch = clampFloat(
                payload.has("pitch") && !payload.isNull("pitch")
                        ? (float) payload.optDouble("pitch", 1.0)
                        : 1.0f,
                MIN_SPEECH_PITCH,
                MAX_SPEECH_PITCH,
                1.0f);

        String rawVoiceGender = payload.isNull("voiceGender")
                ? null
                : payload.optString("voiceGender", null);
        String normalizedGender = null;
        if (rawVoiceGender != null) {
            String trimmedGender = rawVoiceGender.trim().toLowerCase(Locale.ROOT);
            if ("male".equals(trimmedGender) || "female".equals(trimmedGender)) {
                normalizedGender = trimmedGender;
            }
        }
        String rawVoiceId = payload.isNull("voiceId") ? null : payload.optString("voiceId", null);
        String normalizedVoiceId =
                (rawVoiceId != null && !rawVoiceId.trim().isEmpty()) ? rawVoiceId.trim() : null;

        // Supersede any previous TTS operation cleanly
        int generation = ++ttsSeq;
        cancelPendingSpeakTimers();
        stopActiveTtsSilentlyForSupersede();

        // Atomic mutual exclusion: cancel active STT + enforce 150ms HAL settle
        boolean hadActiveStt = cancelAndCleanupSttOnMain("preempted_by_tts", true);
        PendingSpeakRequest request = new PendingSpeakRequest(
                generation,
                requestId,
                rawText,
                rate,
                pitch,
                normalizedGender,
                normalizedVoiceId,
                reply);

        long settleDelayMs = computeTtsSettleDelayMs(hadActiveStt);
        if (settleDelayMs > 0L) {
            pendingSpeakSettleRunnable = () -> {
                pendingSpeakSettleRunnable = null;
                if (destroyed || request.generation != ttsSeq) {
                    return;
                }
                startOrQueueSpeakAfterSettle(request);
            };
            scheduler.postDelayed(pendingSpeakSettleRunnable, settleDelayMs);
        } else {
            startOrQueueSpeakAfterSettle(request);
        }
    }

    private long computeTtsSettleDelayMs(boolean hadActiveStt) {
        if (hadActiveStt) {
            return STT_TO_TTS_SETTLE_MS;
        }
        if (lastSttStopElapsedMs >= 0L) {
            long elapsed = clock.elapsedRealtime() - lastSttStopElapsedMs;
            if (elapsed >= 0L && elapsed < STT_TO_TTS_SETTLE_MS) {
                return STT_TO_TTS_SETTLE_MS - elapsed;
            }
        }
        return 0L;
    }

    private void startOrQueueSpeakAfterSettle(PendingSpeakRequest request) {
        if (!ttsInitCompleted) {
            queuedSpeakWhileTtsInitializing = request;
            ensureTtsInitialized();
            return;
        }
        executeSpeakNow(request);
    }

    private void executeSpeakNow(PendingSpeakRequest request) {
        if (destroyed || request.generation != ttsSeq) {
            return;
        }
        if (!ttsInitSucceeded || !ttsEngine.isReady()) {
            sendTtsError(
                    request.reply,
                    request.requestId,
                    "tts_unavailable",
                    "Android TextToSpeech engine is unavailable");
            return;
        }

        final String utteranceId = "viread_tts_" + request.generation + "_" + request.requestId;
        activeTtsRequestId = request.requestId;
        activeTtsUtteranceId = utteranceId;
        activeTtsReply = request.reply;

        audioFocusController.requestSpeechFocus(
                speechAudioAttributes,
                () -> scheduler.post(() -> stopTtsInternal(null, null, "audio_focus_lost")));

        TtsCallback callback = new TtsCallback() {
            @Override
            public void onStart(String id) {
                scheduler.post(() -> {
                    if (destroyed || !utteranceId.equals(activeTtsUtteranceId)) return;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "tts_start");
                    putSafe(evt, "requestId", request.requestId);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onRangeStart(String id, int start, int end, int frame) {
                scheduler.post(() -> {
                    if (destroyed || !utteranceId.equals(activeTtsUtteranceId)) return;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "tts_range");
                    putSafe(evt, "requestId", request.requestId);
                    putSafe(evt, "start", start);
                    putSafe(evt, "end", end);
                    putSafe(evt, "frame", frame);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onDone(String id) {
                scheduler.post(() -> {
                    if (!utteranceId.equals(activeTtsUtteranceId)) return;
                    clearActiveTtsAndAbandonFocus();
                    if (destroyed) return;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "tts_done");
                    putSafe(evt, "requestId", request.requestId);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onError(String id, int errorCode) {
                scheduler.post(() -> {
                    if (!utteranceId.equals(activeTtsUtteranceId)) return;
                    clearActiveTtsAndAbandonFocus();
                    if (destroyed) return;
                    sendTtsError(
                            request.reply,
                            request.requestId,
                            mapTtsErrorCode(errorCode),
                            "TTS synthesis failed (code=" + errorCode + ")");
                });
            }

            @Override
            public void onStop(String id, boolean interrupted) {
                scheduler.post(() -> {
                    if (!utteranceId.equals(activeTtsUtteranceId)) return;
                    clearActiveTtsAndAbandonFocus();
                    if (destroyed) return;
                    sendTtsStopped(request.reply, request.requestId);
                });
            }
        };

        boolean queued = ttsEngine.speak(
                request.text,
                request.rate,
                request.pitch,
                request.voiceGender,
                request.voiceId,
                utteranceId,
                speechAudioAttributes,
                callback);
        if (!queued) {
            clearActiveTtsAndAbandonFocus();
            sendTtsError(
                    request.reply,
                    request.requestId,
                    "tts_speak_failed",
                    "Failed to queue TTS utterance");
        }
    }

    private void handleStopSpeak(String requestId, ReplySender reply) {
        stopTtsInternal(requestId, reply, "stop_requested");
    }

    private void stopTtsInternal(
            @Nullable String explicitStopRequestId,
            @Nullable ReplySender explicitStopReply,
            String reason) {
        ttsSeq++;
        cancelPendingSpeakTimers();

        String interruptedId = activeTtsRequestId;
        ReplySender interruptedReply = activeTtsReply;
        clearActiveTtsAndAbandonFocus();
        try {
            ttsEngine.stop();
        } catch (Throwable ignored) {
            // Safe shutdown/stop.
        }

        if (interruptedId != null
                && interruptedReply != null
                && !interruptedId.equals(explicitStopRequestId)) {
            sendTtsStopped(interruptedReply, interruptedId);
        }
        if (explicitStopReply != null) {
            sendTtsStopped(
                    explicitStopReply,
                    explicitStopRequestId != null ? explicitStopRequestId : "");
        }
    }

    private void stopActiveTtsSilentlyForSupersede() {
        String previousId = activeTtsRequestId;
        ReplySender previousReply = activeTtsReply;
        clearActiveTtsAndAbandonFocus();
        if (previousId != null) {
            try {
                ttsEngine.stop();
            } catch (Throwable ignored) {
                // Safe stop.
            }
            if (previousReply != null) {
                sendTtsStopped(previousReply, previousId);
            }
        }
    }

    private void cancelPendingSpeakTimers() {
        if (pendingSpeakSettleRunnable != null) {
            scheduler.removeCallbacks(pendingSpeakSettleRunnable);
            pendingSpeakSettleRunnable = null;
        }
        queuedSpeakWhileTtsInitializing = null;
    }

    private void clearActiveTtsAndAbandonFocus() {
        activeTtsRequestId = null;
        activeTtsUtteranceId = null;
        activeTtsReply = null;
        try {
            audioFocusController.abandonFocus();
        } catch (Throwable ignored) {
            // Safe audio focus release.
        }
    }

    private void handleOpenTtsInstallSettings(String requestId, ReplySender reply) {
        boolean opened = false;
        try {
            opened = hostCallbacks.openTtsInstallSettings();
        } catch (Throwable ignored) {
            opened = false;
        }
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", opened ? "tts_settings_opened" : "tts_settings_unavailable");
        putSafe(evt, "requestId", requestId);
        sendJson(reply, evt);
    }

    private void handleStartStt(String requestId, JSONObject payload, ReplySender reply) {
        // Atomic mutual exclusion: stop any active/pending TTS & release audio focus FIRST
        stopTtsInternal(null, null, "preempted_by_stt");

        // Cancel any previous active or permission-waiting STT cleanly
        if (sttBusyRetryRunnable != null) {
            scheduler.removeCallbacks(sttBusyRetryRunnable);
            sttBusyRetryRunnable = null;
        }
        activeSttBusyRetries = 0;
        cancelPendingPermissionStt("superseded");
        cancelAndCleanupSttOnMain("superseded", true);

        String lang = payload.optString("lang", DEFAULT_LANG).trim();
        if (lang.isEmpty()) {
            lang = DEFAULT_LANG;
        }
        boolean partialResults = payload.optBoolean("partialResults", true);
        int maxResults = clampInt(
                payload.optInt("maxResults", DEFAULT_MAX_RESULTS),
                MIN_MAX_RESULTS,
                MAX_MAX_RESULTS);

        int generation = ++sttSeq;
        PendingSttRequest request = new PendingSttRequest(
                generation, requestId, lang, partialResults, maxResults, reply);

        if (!hostCallbacks.hasRecordAudioPermission()) {
            boolean requested = false;
            try {
                requested = hostCallbacks.requestRecordAudioPermission();
            } catch (Throwable ignored) {
                requested = false;
            }
            if (requested) {
                pendingPermissionSttRequest = request;
            } else {
                sendSttError(reply, requestId, "permission_denied", "RECORD_AUDIO permission denied");
                sendSttEnd(reply, requestId);
            }
            return;
        }

        beginSttSessionOnMain(request, false);
    }

    /**
     * Called by {@link MainActivity#onRequestPermissionsResult} after runtime {@code RECORD_AUDIO}
     * permission prompt resolves.
     */
    public void onRecordAudioPermissionResult(boolean granted) {
        scheduler.post(() -> {
            PendingSttRequest pending = pendingPermissionSttRequest;
            pendingPermissionSttRequest = null;
            if (pending == null || destroyed || pending.generation != sttSeq) {
                return;
            }
            if (!granted) {
                sendSttError(
                        pending.reply,
                        pending.requestId,
                        "permission_denied",
                        "RECORD_AUDIO permission denied");
                sendSttEnd(pending.reply, pending.requestId);
                return;
            }
            // Re-ensure TTS didn't start while dialog was up
            stopTtsInternal(null, null, "preempted_by_stt");
            beginSttSessionOnMain(pending, false);
        });
    }

    private void beginSttSessionOnMain(PendingSttRequest request, boolean forceCloudFallback) {
        if (destroyed || request.generation != sttSeq) {
            return;
        }

        boolean onDeviceAvail = sttEngineFactory.isOnDeviceSttAvailable();
        boolean standardAvail = sttEngineFactory.isSttAvailable();
        if (!onDeviceAvail && !standardAvail) {
            sendSttError(
                    request.reply,
                    request.requestId,
                    "stt_unavailable",
                    "Android SpeechRecognizer is unavailable on this device");
            sendSttEnd(request.reply, request.requestId);
            return;
        }

        boolean preferOnDevice = !forceCloudFallback
                && !onDeviceViUnsupported
                && onDeviceAvail;
        if (!preferOnDevice && !standardAvail) {
            preferOnDevice = onDeviceAvail;
        }

        activeSttRequest = request;
        activeSttOnsetAt = 0L;
        lastRmsEmitElapsedMs = -1L;
        activeSttReceivedResults = false;
        activeSttUsedCloudFallback = forceCloudFallback;

        SttSessionCallback listener = new SttSessionCallback() {
            @Override
            public void onReadyForSpeech() {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "stt_ready");
                    putSafe(evt, "requestId", request.requestId);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onBeginningOfSpeech() {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    long onset = clock.currentTimeMillis();
                    activeSttOnsetAt = onset;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "stt_onset");
                    putSafe(evt, "requestId", request.requestId);
                    putSafe(evt, "onsetAt", onset);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onRmsChanged(float rmsDb) {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    long nowElapsed = clock.elapsedRealtime();
                    if (lastRmsEmitElapsedMs >= 0L
                            && (nowElapsed - lastRmsEmitElapsedMs) < RMS_EMIT_MIN_INTERVAL_MS) {
                        return;
                    }
                    lastRmsEmitElapsedMs = nowElapsed;
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "stt_rms");
                    putSafe(evt, "requestId", request.requestId);
                    putSafe(evt, "rmsDb", Float.isFinite(rmsDb) ? rmsDb : 0.0f);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onPartialResults(List<String> matches) {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    String transcript = firstNonEmpty(matches);
                    if (transcript == null) return;
                    activeSttReceivedResults = true;
                    if (activeSttOnsetAt <= 0L) {
                        activeSttOnsetAt = clock.currentTimeMillis();
                    }
                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "stt_partial");
                    putSafe(evt, "requestId", request.requestId);
                    putSafe(evt, "transcript", transcript);
                    putSafe(evt, "onsetAt", activeSttOnsetAt);
                    sendJson(request.reply, evt);
                });
            }

            @Override
            public void onFinalResults(List<String> matches, @Nullable float[] confidences) {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    activeSttReceivedResults = true;
                    long onset = activeSttOnsetAt > 0L
                            ? activeSttOnsetAt
                            : clock.currentTimeMillis();
                    String transcript = "";
                    JSONArray alternatives = new JSONArray();
                    if (matches != null) {
                        for (String item : matches) {
                            if (item != null && !item.trim().isEmpty()) {
                                String cleaned = item.trim();
                                if (transcript.isEmpty()) {
                                    transcript = cleaned;
                                }
                                alternatives.put(cleaned);
                                if (alternatives.length() >= request.maxResults) {
                                    break;
                                }
                            }
                        }
                    }

                    destroyActiveSttSessionOnly();

                    JSONObject evt = new JSONObject();
                    putSafe(evt, "type", "stt_final");
                    putSafe(evt, "requestId", request.requestId);
                    putSafe(evt, "transcript", transcript);
                    putSafe(evt, "alternatives", alternatives);
                    putSafe(evt, "onsetAt", onset);
                    sendJson(request.reply, evt);
                    sendSttEnd(request.reply, request.requestId);
                });
            }

            @Override
            public void onError(int errorCode) {
                scheduler.post(() -> {
                    if (!isCurrentStt(request)) return;
                    if (errorCode == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
                            && !activeSttReceivedResults
                            && activeSttBusyRetries < MAX_STT_BUSY_RETRIES) {
                        activeSttBusyRetries += 1;
                        boolean keepCloudFallback = activeSttUsedCloudFallback;
                        destroyActiveSttSessionOnly();
                        if (sttBusyRetryRunnable != null) {
                            scheduler.removeCallbacks(sttBusyRetryRunnable);
                        }
                        sttBusyRetryRunnable = () -> {
                            sttBusyRetryRunnable = null;
                            if (destroyed || request.generation != sttSeq) {
                                return;
                            }
                            beginSttSessionOnMain(request, keepCloudFallback);
                        };
                        scheduler.postDelayed(sttBusyRetryRunnable, STT_BUSY_RETRY_DELAY_MS);
                        return;
                    }
                    boolean wasOnDevice = activeSttSession != null && activeSttSession.isOnDevice();
                    if (wasOnDevice
                            && !activeSttReceivedResults
                            && !activeSttUsedCloudFallback
                            && isOnDeviceLanguageFallbackError(errorCode)
                            && sttEngineFactory.isSttAvailable()) {
                        // On-device model missing vi-VN pack -> seamlessly fall back to standard SpeechRecognizer
                        onDeviceViUnsupported = true;
                        destroyActiveSttSessionOnly();
                        beginSttSessionOnMain(request, true);
                        return;
                    }

                    destroyActiveSttSessionOnly();
                    sendSttError(
                            request.reply,
                            request.requestId,
                            mapSttErrorCode(errorCode),
                            "SpeechRecognizer error (code=" + errorCode + ")");
                    sendSttEnd(request.reply, request.requestId);
                });
            }

            @Override
            public void onEndOfSpeech() {
                // SpeechRecognizer delivers onResults or onError after onEndOfSpeech.
            }
        };

        SttSession session;
        try {
            session = sttEngineFactory.create(preferOnDevice, listener);
        } catch (Throwable ex) {
            session = null;
        }
        if (session == null && preferOnDevice && standardAvail) {
            try {
                session = sttEngineFactory.create(false, listener);
            } catch (Throwable ex) {
                session = null;
            }
        }
        if (session == null) {
            activeSttRequest = null;
            sendSttError(
                    request.reply,
                    request.requestId,
                    "stt_unavailable",
                    "Could not create Android SpeechRecognizer");
            sendSttEnd(request.reply, request.requestId);
            return;
        }

        activeSttSession = session;
        Intent recognizerIntent = buildRecognizerIntent(
                request.lang,
                request.partialResults,
                request.maxResults,
                hostCallbacks.getPackageName());
        try {
            session.startListening(recognizerIntent);
        } catch (Throwable ex) {
            destroyActiveSttSessionOnly();
            sendSttError(
                    request.reply,
                    request.requestId,
                    "stt_start_failed",
                    "Failed to start Android SpeechRecognizer");
            sendSttEnd(request.reply, request.requestId);
        }
    }

    private void handleStopStt(String requestId, ReplySender reply) {
        cancelPendingPermissionStt("stopped");
        if (activeSttSession == null || activeSttRequest == null) {
            sendSttEnd(reply, requestId);
            return;
        }
        final PendingSttRequest current = activeSttRequest;
        try {
            activeSttSession.stopListening();
        } catch (Throwable ignored) {
            cancelAndCleanupSttOnMain("stop_failed", true);
            if (!current.requestId.equals(requestId)) {
                sendSttEnd(reply, requestId);
            }
            return;
        }

        // Guard against OEM SpeechRecognizers that fail to fire onResults/onError after stopListening.
        cancelSttStopFallbackTimer();
        sttStopFallbackRunnable = () -> {
            sttStopFallbackRunnable = null;
            if (isCurrentStt(current)) {
                cancelAndCleanupSttOnMain("stop_timeout", true);
            }
        };
        scheduler.postDelayed(sttStopFallbackRunnable, STT_STOP_FALLBACK_TIMEOUT_MS);

        if (!current.requestId.equals(requestId)) {
            sendSttEnd(reply, requestId);
        }
    }

    private void handleCancelStt(String requestId, ReplySender reply) {
        cancelPendingPermissionStt("canceled");
        String prevRequestId = activeSttRequest != null ? activeSttRequest.requestId : null;
        cancelAndCleanupSttOnMain("canceled", true);
        if (prevRequestId == null || !prevRequestId.equals(requestId)) {
            sendSttEnd(reply, requestId);
        }
    }

    private void cancelPendingPermissionStt(String reason) {
        PendingSttRequest pending = pendingPermissionSttRequest;
        pendingPermissionSttRequest = null;
        if (pending != null) {
            sttSeq++;
            sendSttEnd(pending.reply, pending.requestId);
        }
    }

    private boolean cancelAndCleanupSttOnMain(String reason, boolean emitEnd) {
        cancelSttStopFallbackTimer();
        SttSession session = activeSttSession;
        PendingSttRequest request = activeSttRequest;
        if (session == null && request == null) {
            return false;
        }
        sttSeq++;
        activeSttSession = null;
        activeSttRequest = null;
        activeSttOnsetAt = 0L;
        lastSttStopElapsedMs = clock.elapsedRealtime();

        if (session != null) {
            try {
                session.cancel();
            } catch (Throwable ignored) {
                // Safe cancel.
            }
            try {
                session.destroy();
            } catch (Throwable ignored) {
                // Safe destroy.
            }
        }
        if (emitEnd && request != null) {
            sendSttEnd(request.reply, request.requestId);
        }
        return true;
    }

    private void destroyActiveSttSessionOnly() {
        cancelSttStopFallbackTimer();
        SttSession session = activeSttSession;
        activeSttSession = null;
        activeSttRequest = null;
        activeSttOnsetAt = 0L;
        lastSttStopElapsedMs = clock.elapsedRealtime();
        if (session != null) {
            try {
                session.destroy();
            } catch (Throwable ignored) {
                // Safe destroy.
            }
        }
    }

    private void cancelSttStopFallbackTimer() {
        if (sttStopFallbackRunnable != null) {
            scheduler.removeCallbacks(sttStopFallbackRunnable);
            sttStopFallbackRunnable = null;
        }
    }

    private boolean isCurrentStt(PendingSttRequest request) {
        return !destroyed
                && activeSttRequest != null
                && activeSttRequest.generation == request.generation
                && activeSttSession != null;
    }

    /**
     * Stops active TTS & SpeechRecognizer and releases audio focus when {@link MainActivity}
     * enters background ({@code onStop}).
     */
    public void onHostStop() {
        scheduler.post(() -> {
            if (destroyed) return;
            stopTtsInternal(null, null, "host_stopped");
            cancelPendingPermissionStt("host_stopped");
            cancelAndCleanupSttOnMain("host_stopped", true);
        });
    }

    /**
     * Permanently shuts down TTS, destroys any SpeechRecognizer, and releases audio focus
     * when {@link MainActivity#onDestroy} executes.
     */
    public void onHostDestroy() {
        destroyed = true;
        ttsSeq++;
        sttSeq++;
        if (ttsInitTimeoutRunnable != null) {
            scheduler.removeCallbacks(ttsInitTimeoutRunnable);
            ttsInitTimeoutRunnable = null;
        }
        cancelPendingSpeakTimers();
        cancelSttStopFallbackTimer();
        pendingCapabilities.clear();
        pendingPermissionSttRequest = null;

        SttSession session = activeSttSession;
        activeSttSession = null;
        activeSttRequest = null;
        if (session != null) {
            try {
                session.cancel();
            } catch (Throwable ignored) {
                // Safe teardown.
            }
            try {
                session.destroy();
            } catch (Throwable ignored) {
                // Safe teardown.
            }
        }

        clearActiveTtsAndAbandonFocus();
        try {
            ttsEngine.stop();
        } catch (Throwable ignored) {
            // Safe teardown.
        }
        try {
            ttsEngine.shutdown();
        } catch (Throwable ignored) {
            // Safe teardown.
        }
    }

    static Intent buildRecognizerIntent(
            String lang, boolean partialResults, int maxResults, @Nullable String callingPackage) {
        String effectiveLang = (lang != null && !lang.trim().isEmpty())
                ? lang.trim()
                : DEFAULT_LANG;
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, effectiveLang);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, effectiveLang);
        intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, true);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partialResults);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                COMPLETE_SILENCE_LENGTH_MS);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                POSSIBLY_COMPLETE_SILENCE_LENGTH_MS);
        if (callingPackage != null && !callingPackage.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, callingPackage);
        }
        return intent;
    }

    @Nullable
    static Voice selectBestVietnameseVoice(@Nullable Set<Voice> voices) {
        return selectBestVietnameseVoice(voices, null);
    }

    @Nullable
    static Voice selectBestVietnameseVoice(
            @Nullable Set<Voice> voices, @Nullable String preferredGender) {
        if (voices == null || voices.isEmpty()) {
            return null;
        }
        String gender = preferredGender == null
                ? null
                : preferredGender.trim().toLowerCase(Locale.ROOT);
        Voice best = null;
        int bestScore = Integer.MIN_VALUE;
        for (Voice voice : voices) {
            if (!isUsableVietnameseVoice(voice)) {
                continue;
            }
            int score = 0;
            if (!voice.isNetworkConnectionRequired()) {
                score += 1000;
            }
            Locale locale = voice.getLocale();
            if (locale != null && "VN".equalsIgnoreCase(locale.getCountry())) {
                score += 200;
            }
            String vName = voice.getName() != null
                    ? voice.getName().toLowerCase(Locale.ROOT)
                    : "";
            boolean looksMale = vName.contains("vid")
                    || vName.contains("male")
                    || vName.contains("nam")
                    || vName.contains("minh")
                    || vName.contains("hung")
                    || vName.contains("tuan");
            boolean looksFemale = vName.contains("gft")
                    || vName.contains("vie")
                    || vName.contains("vif")
                    || vName.contains("vic")
                    || vName.contains("female")
                    || vName.contains("hoaimy")
                    || vName.contains("linh")
                    || vName.contains("mai")
                    || vName.contains("lan");
            if ("male".equals(gender)) {
                if (looksMale && !looksFemale) score += 600;
                if (looksFemale) score -= 350;
            } else if ("female".equals(gender)) {
                if (looksFemale) score += 600;
                if (looksMale && !looksFemale) score -= 350;
            }
            score += voice.getQuality();
            score -= Math.max(0, voice.getLatency()) / 10;
            if (best == null || score > bestScore) {
                best = voice;
                bestScore = score;
            }
        }
        return best;
    }

    static int countUsableVietnameseVoices(@Nullable Set<Voice> voices) {
        if (voices == null || voices.isEmpty()) {
            return 0;
        }
        int count = 0;
        for (Voice voice : voices) {
            if (isUsableVietnameseVoice(voice)) {
                count++;
            }
        }
        return count;
    }

    private static boolean isUsableVietnameseVoice(@Nullable Voice voice) {
        if (voice == null || voice.getLocale() == null) {
            return false;
        }
        if (!"vi".equalsIgnoreCase(voice.getLocale().getLanguage())) {
            return false;
        }
        Set<String> features = voice.getFeatures();
        return features == null
                || !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED);
    }

    @SuppressLint("InlinedApi")
    static boolean isOnDeviceLanguageFallbackError(int errorCode) {
        return errorCode == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                || errorCode == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                || errorCode == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT;
    }

    @SuppressLint("InlinedApi")
    static String mapSttErrorCode(int errorCode) {
        switch (errorCode) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_CLIENT:
                return "aborted";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission_denied";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "network";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "service-not-allowed";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                return "too-many-requests";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                return "language-not-supported";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "language-unavailable";
            default:
                return "stt-unavailable";
        }
    }

    static String mapTtsErrorCode(int errorCode) {
        switch (errorCode) {
            case TextToSpeech.ERROR_NETWORK:
            case TextToSpeech.ERROR_NETWORK_TIMEOUT:
                return "network";
            case TextToSpeech.ERROR_NOT_INSTALLED_YET:
                return "voice_not_installed";
            case TextToSpeech.ERROR_SERVICE:
                return "tts_service_error";
            case TextToSpeech.ERROR_SYNTHESIS:
                return "tts_synthesis_error";
            default:
                return "tts_error";
        }
    }

    static float clampFloat(float value, float min, float max, float fallback) {
        if (!Float.isFinite(value)) {
            return fallback;
        }
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    private static int clampInt(int value, int min, int max) {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    @Nullable
    private static String firstNonEmpty(@Nullable List<String> items) {
        if (items == null) return null;
        for (String item : items) {
            if (item != null && !item.trim().isEmpty()) {
                return item.trim();
            }
        }
        return null;
    }

    private void sendTtsStopped(ReplySender reply, String requestId) {
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "tts_stopped");
        putSafe(evt, "requestId", requestId);
        sendJson(reply, evt);
    }

    private void sendTtsError(ReplySender reply, String requestId, String code, String message) {
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "tts_error");
        putSafe(evt, "requestId", requestId);
        putSafe(evt, "code", code);
        putSafe(evt, "message", message);
        sendJson(reply, evt);
    }

    private void sendSttError(ReplySender reply, String requestId, String code, String message) {
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "stt_error");
        putSafe(evt, "requestId", requestId);
        putSafe(evt, "code", code);
        putSafe(evt, "message", message);
        sendJson(reply, evt);
    }

    private void sendSttEnd(ReplySender reply, String requestId) {
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "stt_end");
        putSafe(evt, "requestId", requestId);
        sendJson(reply, evt);
    }

    private void sendBridgeError(ReplySender reply, String requestId, String code, String message) {
        JSONObject evt = new JSONObject();
        putSafe(evt, "type", "bridge_error");
        putSafe(evt, "requestId", requestId);
        putSafe(evt, "code", code);
        putSafe(evt, "message", message);
        sendJson(reply, evt);
    }

    private void sendJson(ReplySender reply, JSONObject payload) {
        if (reply == null || payload == null) return;
        try {
            reply.send(payload.toString());
        } catch (Throwable ignored) {
            // Safe delivery.
        }
    }

    private static void putSafe(JSONObject obj, String key, Object value) {
        try {
            obj.put(key, value);
        } catch (JSONException ignored) {
            // Valid primitive/string/JSONArray values never throw here.
        }
    }

    // ---- Production Android Adapters ----

    private static final class MainHandlerScheduler implements Scheduler {
        private final Handler handler;

        MainHandlerScheduler(Handler handler) {
            this.handler = handler;
        }

        @Override
        public void post(Runnable runnable) {
            if (Looper.myLooper() == handler.getLooper()) {
                runnable.run();
            } else {
                handler.post(runnable);
            }
        }

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            handler.postDelayed(runnable, delayMs);
        }

        @Override
        public void removeCallbacks(Runnable runnable) {
            handler.removeCallbacks(runnable);
        }
    }

    private static final class SystemClockAdapter implements Clock {
        @Override
        public long currentTimeMillis() {
            return System.currentTimeMillis();
        }

        @Override
        public long elapsedRealtime() {
            return SystemClock.elapsedRealtime();
        }
    }

    private static final class AndroidAudioFocusController implements AudioFocusController {
        private final AudioManager audioManager;
        private final Handler mainHandler;
        private AudioFocusRequest activeRequest;

        AndroidAudioFocusController(Context appContext, Handler mainHandler) {
            this.audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
            this.mainHandler = mainHandler;
        }

        @Override
        public boolean requestSpeechFocus(AudioAttributes attributes, Runnable onFocusLoss) {
            if (audioManager == null) return false;
            abandonFocus();
            AudioFocusRequest request = new AudioFocusRequest.Builder(
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attributes)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusChange -> {
                        if (focusChange == AudioManager.AUDIOFOCUS_LOSS
                                && onFocusLoss != null) {
                            onFocusLoss.run();
                        }
                    }, mainHandler)
                    .build();
            activeRequest = request;
            int status = audioManager.requestAudioFocus(request);
            return status == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }

        @Override
        public void abandonFocus() {
            if (audioManager != null && activeRequest != null) {
                try {
                    audioManager.abandonAudioFocusRequest(activeRequest);
                } catch (Throwable ignored) {
                    // Safe abandon.
                }
            }
            activeRequest = null;
        }
    }

    private static final class AndroidTtsEngine implements TtsEngine {
        private static final Locale VI_VN = Locale.forLanguageTag(DEFAULT_LANG);
        private final Context appContext;
        private TextToSpeech tts;
        private volatile boolean ready;
        private volatile TtsCallback activeCallback;
        @Nullable private String pinnedVoiceKey;
        @Nullable private Voice pinnedVoice;

        AndroidTtsEngine(Context appContext) {
            this.appContext = appContext;
        }

        @Override
        public void initialize(TtsInitCallback callback) {
            tts = new TextToSpeech(appContext, status -> {
                boolean ok = (status == TextToSpeech.SUCCESS);
                if (ok && tts != null) {
                    configureVietnameseVoice(tts, null, null);
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onStart(utteranceId);
                        }

                        @Override
                        public void onRangeStart(
                                String utteranceId, int start, int end, int frame) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onRangeStart(utteranceId, start, end, frame);
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onDone(utteranceId);
                        }

                        @Override
                        @SuppressWarnings("deprecation")
                        public void onError(String utteranceId) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onError(utteranceId, TextToSpeech.ERROR);
                        }

                        @Override
                        public void onError(String utteranceId, int errorCode) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onError(utteranceId, errorCode);
                        }

                        @Override
                        public void onStop(String utteranceId, boolean interrupted) {
                            TtsCallback cb = activeCallback;
                            if (cb != null) cb.onStop(utteranceId, interrupted);
                        }
                    });
                }
                ready = ok;
                callback.onInitComplete(ok);
            });
        }

        private void configureVietnameseVoice(
                TextToSpeech engine,
                @Nullable String voiceGender,
                @Nullable String voiceId) {
            String targetKey = (voiceGender == null ? "default" : voiceGender)
                    + "::"
                    + (voiceId == null ? "" : voiceId);
            try {
                engine.setLanguage(VI_VN);
            } catch (Throwable ignored) {
                // Continue with voice selection attempt.
            }
            try {
                if (targetKey.equals(pinnedVoiceKey) && pinnedVoice != null) {
                    engine.setVoice(pinnedVoice);
                    return;
                }
                Voice best = selectBestVietnameseVoice(engine.getVoices(), voiceGender);
                if (best != null) {
                    pinnedVoiceKey = targetKey;
                    pinnedVoice = best;
                    engine.setVoice(best);
                }
            } catch (Throwable ignored) {
                // OEM getVoices() can throw on restricted builds; setLanguage fallback applies.
            }
        }

        @Override
        public boolean isReady() {
            return ready && tts != null;
        }

        @Override
        public int getVietnameseVoicesCount() {
            if (!isReady()) return 0;
            try {
                int count = countUsableVietnameseVoices(tts.getVoices());
                if (count > 0) return count;
            } catch (Throwable ignored) {
                // Fall back to isLanguageAvailable.
            }
            return isVietnameseAvailable() ? 1 : 0;
        }

        @Override
        public boolean isVietnameseAvailable() {
            if (!isReady()) return false;
            try {
                int avail = tts.isLanguageAvailable(VI_VN);
                return avail >= TextToSpeech.LANG_AVAILABLE;
            } catch (Throwable ignored) {
                return false;
            }
        }

        @Override
        public boolean speak(
                String text,
                float rate,
                float pitch,
                String utteranceId,
                AudioAttributes attributes,
                TtsCallback callback) {
            return speak(text, rate, pitch, null, null, utteranceId, attributes, callback);
        }

        @Override
        public boolean speak(
                String text,
                float rate,
                float pitch,
                @Nullable String voiceGender,
                @Nullable String voiceId,
                String utteranceId,
                AudioAttributes attributes,
                TtsCallback callback) {
            if (!isReady()) return false;
            activeCallback = callback;
            try {
                configureVietnameseVoice(tts, voiceGender, voiceId);
                tts.setAudioAttributes(attributes);
                tts.setSpeechRate(rate);
                tts.setPitch(pitch);
                Bundle params = new Bundle();
                int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
                return res == TextToSpeech.SUCCESS;
            } catch (Throwable ex) {
                return false;
            }
        }

        @Override
        public void stop() {
            activeCallback = null;
            if (tts != null) {
                tts.stop();
            }
        }

        @Override
        public void shutdown() {
            ready = false;
            activeCallback = null;
            if (tts != null) {
                tts.shutdown();
                tts = null;
            }
        }
    }

    private static final class AndroidSttEngineFactory implements SttEngineFactory {
        private final Context appContext;

        AndroidSttEngineFactory(Context appContext) {
            this.appContext = appContext;
        }

        @Override
        public boolean isSttAvailable() {
            try {
                return SpeechRecognizer.isRecognitionAvailable(appContext);
            } catch (Throwable ignored) {
                return false;
            }
        }

        @Override
        public boolean isOnDeviceSttAvailable() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                return false;
            }
            try {
                return SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext);
            } catch (Throwable ignored) {
                return false;
            }
        }

        @Override
        @Nullable
        public SttSession create(boolean preferOnDevice, SttSessionCallback callback) {
            boolean useOnDevice = preferOnDevice
                    && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && isOnDeviceSttAvailable();
            SpeechRecognizer recognizer;
            if (useOnDevice) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext);
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(appContext);
            }
            if (recognizer == null) {
                return null;
            }
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                    callback.onReadyForSpeech();
                }

                @Override
                public void onBeginningOfSpeech() {
                    callback.onBeginningOfSpeech();
                }

                @Override
                public void onRmsChanged(float rmsdB) {
                    callback.onRmsChanged(rmsdB);
                }

                @Override
                public void onBufferReceived(byte[] buffer) {
                    // Unused
                }

                @Override
                public void onEndOfSpeech() {
                    callback.onEndOfSpeech();
                }

                @Override
                public void onError(int error) {
                    callback.onError(error);
                }

                @Override
                public void onResults(Bundle results) {
                    List<String> matches = results != null
                            ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            : Collections.emptyList();
                    float[] confidences = results != null
                            ? results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                            : null;
                    callback.onFinalResults(matches, confidences);
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    List<String> matches = partialResults != null
                            ? partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            : Collections.emptyList();
                    callback.onPartialResults(matches);
                }

                @Override
                public void onEvent(int eventType, Bundle params) {
                    // Unused
                }
            });
            return new AndroidSttSession(recognizer, useOnDevice);
        }
    }

    private static final class AndroidSttSession implements SttSession {
        private final SpeechRecognizer recognizer;
        private final boolean onDevice;

        AndroidSttSession(SpeechRecognizer recognizer, boolean onDevice) {
            this.recognizer = recognizer;
            this.onDevice = onDevice;
        }

        @Override
        public boolean isOnDevice() {
            return onDevice;
        }

        @Override
        public void startListening(Intent recognizerIntent) {
            recognizer.startListening(recognizerIntent);
        }

        @Override
        public void stopListening() {
            recognizer.stopListening();
        }

        @Override
        public void cancel() {
            recognizer.cancel();
        }

        @Override
        public void destroy() {
            recognizer.destroy();
        }
    }

    /**
     * Launches Android TTS data install activity safely if available on the device.
     */
    static boolean launchTtsInstallSettings(Activity activity) {
        if (activity == null || activity.isFinishing()) {
            return false;
        }
        Intent intent = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        PackageManager pm = activity.getPackageManager();
        if (pm == null || intent.resolveActivity(pm) == null) {
            return false;
        }
        try {
            activity.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException | SecurityException ex) {
            return false;
        }
    }

    // Package-private inspection helpers for tests
    boolean hasActiveSttForTest() {
        return activeSttSession != null;
    }

    boolean hasActiveTtsForTest() {
        return activeTtsUtteranceId != null;
    }

    boolean hasPendingSpeakSettleForTest() {
        return pendingSpeakSettleRunnable != null;
    }
}
