package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioAttributes;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class ViReadNativeSpeechBridgeTest {
    private static final String TRUSTED_ORIGIN = "https://viread-frontend.vercel.app";

    @After
    public void tearDown() {
        MainActivity.backendWarmupRunnerForTest = null;
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
    }

    // ---- Test Doubles ----

    private static final class FakeClock implements ViReadNativeSpeechBridge.Clock {
        long wallMs = 1_700_000_000_000L;
        long elapsedMs = 10_000L;

        @Override
        public long currentTimeMillis() {
            return wallMs;
        }

        @Override
        public long elapsedRealtime() {
            return elapsedMs;
        }

        void advance(long deltaMs) {
            wallMs += deltaMs;
            elapsedMs += deltaMs;
        }
    }

    private static final class ScheduledTask {
        final Runnable runnable;
        final long dueAtElapsedMs;
        boolean canceled;

        ScheduledTask(Runnable runnable, long dueAtElapsedMs) {
            this.runnable = runnable;
            this.dueAtElapsedMs = dueAtElapsedMs;
        }
    }

    private static final class FakeScheduler implements ViReadNativeSpeechBridge.Scheduler {
        private final FakeClock clock;
        private final List<ScheduledTask> tasks = new ArrayList<>();

        FakeScheduler(FakeClock clock) {
            this.clock = clock;
        }

        @Override
        public void post(Runnable runnable) {
            runnable.run();
        }

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            tasks.add(new ScheduledTask(runnable, clock.elapsedMs + delayMs));
        }

        @Override
        public void removeCallbacks(Runnable runnable) {
            for (ScheduledTask task : tasks) {
                if (task.runnable == runnable) {
                    task.canceled = true;
                }
            }
        }

        void advanceBy(long deltaMs) {
            clock.advance(deltaMs);
            List<ScheduledTask> due = new ArrayList<>();
            for (ScheduledTask task : tasks) {
                if (!task.canceled && task.dueAtElapsedMs <= clock.elapsedMs) {
                    task.canceled = true;
                    due.add(task);
                }
            }
            for (ScheduledTask task : due) {
                task.runnable.run();
            }
        }
    }

    private static final class FakeAudioFocusController
            implements ViReadNativeSpeechBridge.AudioFocusController {
        int requestCount;
        int abandonCount;
        boolean currentlyHeld;
        AudioAttributes lastAttributes;
        Runnable lastLossCallback;

        @Override
        public boolean requestSpeechFocus(AudioAttributes attributes, Runnable onFocusLoss) {
            requestCount++;
            currentlyHeld = true;
            lastAttributes = attributes;
            lastLossCallback = onFocusLoss;
            return true;
        }

        @Override
        public void abandonFocus() {
            abandonCount++;
            currentlyHeld = false;
        }
    }

    private static final class FakeTtsEngine implements ViReadNativeSpeechBridge.TtsEngine {
        boolean autoCompleteInit = true;
        boolean initSuccess = true;
        boolean ready;
        int viVoicesCount = 2;
        boolean viAvailable = true;
        boolean hasMaleViVoice = true;
        boolean hasFemaleViVoice = true;
        String selectedVoiceGender;
        ViReadNativeSpeechBridge.TtsInitCallback pendingInitCallback;

        int initCount;
        boolean speakShouldSucceed = true;
        int speakCount;
        int stopCount;
        int shutdownCount;
        String lastText;
        float lastRate;
        float lastPitch;
        String lastVoiceGender;
        String lastVoiceId;
        String lastUtteranceId;
        AudioAttributes lastAttributes;
        ViReadNativeSpeechBridge.TtsCallback lastCallback;
        boolean voiceGenderMismatch;
        String resolvedVoiceName;

        @Override
        public void initialize(ViReadNativeSpeechBridge.TtsInitCallback callback) {
            initCount++;
            if (autoCompleteInit) {
                ready = initSuccess;
                callback.onInitComplete(initSuccess);
            } else {
                pendingInitCallback = callback;
            }
        }

        void completeInit(boolean success) {
            initSuccess = success;
            ready = success;
            if (pendingInitCallback != null) {
                ViReadNativeSpeechBridge.TtsInitCallback cb = pendingInitCallback;
                pendingInitCallback = null;
                cb.onInitComplete(success);
            }
        }

        @Override
        public boolean isReady() {
            return ready;
        }

        @Override
        public int getVietnameseVoicesCount() {
            return viVoicesCount;
        }

        @Override
        public boolean isVietnameseAvailable() {
            return viAvailable;
        }

        @Override
        public boolean hasVietnameseVoiceForGender(String gender) {
            if ("male".equals(gender)) return hasMaleViVoice;
            if ("female".equals(gender)) return hasFemaleViVoice;
            return false;
        }

        @Override
        public String getSelectedVoiceGender() {
            return selectedVoiceGender;
        }

        @Override
        public boolean speak(
                String text,
                float rate,
                float pitch,
                String utteranceId,
                AudioAttributes attributes,
                ViReadNativeSpeechBridge.TtsCallback callback) {
            return speak(text, rate, pitch, utteranceId, attributes, callback, null, null);
        }

        @Override
        public boolean speak(
                String text,
                float rate,
                float pitch,
                String utteranceId,
                AudioAttributes attributes,
                ViReadNativeSpeechBridge.TtsCallback callback,
                String voiceGender,
                String voiceId) {
            speakCount++;
            lastText = text;
            lastRate = rate;
            lastPitch = pitch;
            lastVoiceGender = voiceGender;
            lastVoiceId = voiceId;
            selectedVoiceGender = voiceGender;
            lastUtteranceId = utteranceId;
            lastAttributes = attributes;
            lastCallback = callback;
            return speakShouldSucceed;
        }

        @Override
        public boolean isLastVoiceGenderMismatch() {
            return voiceGenderMismatch;
        }

        @Override
        public String getLastResolvedVoiceName() {
            return resolvedVoiceName;
        }

        @Override
        public void stop() {
            stopCount++;
        }

        @Override
        public void shutdown() {
            shutdownCount++;
            ready = false;
        }
    }

    private static final class FakeSttSession implements ViReadNativeSpeechBridge.SttSession {
        final boolean onDevice;
        final ViReadNativeSpeechBridge.SttSessionCallback callback;
        Intent startedIntent;
        int startCount;
        int stopListeningCount;
        int cancelCount;
        int destroyCount;

        FakeSttSession(boolean onDevice, ViReadNativeSpeechBridge.SttSessionCallback callback) {
            this.onDevice = onDevice;
            this.callback = callback;
        }

        @Override
        public boolean isOnDevice() {
            return onDevice;
        }

        @Override
        public void startListening(Intent recognizerIntent) {
            startCount++;
            startedIntent = recognizerIntent;
        }

        @Override
        public void stopListening() {
            stopListeningCount++;
        }

        @Override
        public void cancel() {
            cancelCount++;
        }

        @Override
        public void destroy() {
            destroyCount++;
        }
    }

    private static final class FakeSttEngineFactory
            implements ViReadNativeSpeechBridge.SttEngineFactory {
        boolean sttAvailable = true;
        boolean onDeviceAvailable = true;
        final List<FakeSttSession> createdSessions = new ArrayList<>();

        @Override
        public boolean isSttAvailable() {
            return sttAvailable;
        }

        @Override
        public boolean isOnDeviceSttAvailable() {
            return onDeviceAvailable;
        }

        @Override
        public ViReadNativeSpeechBridge.SttSession create(
                boolean preferOnDevice, ViReadNativeSpeechBridge.SttSessionCallback callback) {
            boolean useOnDevice = preferOnDevice && onDeviceAvailable;
            FakeSttSession session = new FakeSttSession(useOnDevice, callback);
            createdSessions.add(session);
            return session;
        }

        FakeSttSession latest() {
            return createdSessions.isEmpty()
                    ? null
                    : createdSessions.get(createdSessions.size() - 1);
        }
    }

    private static final class FakeHostCallbacks implements ViReadNativeSpeechBridge.HostCallbacks {
        boolean hasAudioPermission = true;
        boolean canRequestPermission = true;
        int permissionRequestCount;
        boolean ttsSettingsOpened = true;
        int openTtsSettingsCount;

        @Override
        public boolean hasRecordAudioPermission() {
            return hasAudioPermission;
        }

        @Override
        public boolean requestRecordAudioPermission() {
            permissionRequestCount++;
            return canRequestPermission;
        }

        @Override
        public boolean openTtsInstallSettings() {
            openTtsSettingsCount++;
            return ttsSettingsOpened;
        }

        @Override
        public String getPackageName() {
            return "vn.viread.android";
        }
    }

    private static final class BridgeHarness {
        final TrustedNavigation navigation = new TrustedNavigation(TRUSTED_ORIGIN);
        final FakeClock clock = new FakeClock();
        final FakeScheduler scheduler = new FakeScheduler(clock);
        final FakeAudioFocusController audioFocus = new FakeAudioFocusController();
        final FakeTtsEngine tts = new FakeTtsEngine();
        final FakeSttEngineFactory sttFactory = new FakeSttEngineFactory();
        final FakeHostCallbacks host = new FakeHostCallbacks();
        final List<JSONObject> events = new ArrayList<>();
        final ViReadNativeSpeechBridge.ReplySender reply = json -> {
            try {
                events.add(new JSONObject(json));
            } catch (Exception ex) {
                throw new AssertionError("Bridge emitted invalid JSON: " + json, ex);
            }
        };
        final ViReadNativeSpeechBridge bridge = new ViReadNativeSpeechBridge(
                () -> navigation, tts, sttFactory, audioFocus, host, scheduler, clock);

        void sendTrusted(String json) {
            bridge.handleIncomingMessage(json, TRUSTED_ORIGIN, true, reply);
        }
    }

    // ---- Security & Parsing Tests ----

    @Test
    public void rejectsUntrustedOriginsAndSubframesWithZeroSideEffects() {
        BridgeHarness h = new BridgeHarness();
        String msg = "{\"action\":\"getCapabilities\",\"requestId\":\"cap-1\"}";

        // Subframe on exact trusted origin MUST be rejected
        h.bridge.handleIncomingMessage(msg, TRUSTED_ORIGIN, false, h.reply);
        // Untrusted origins, HTTP downgrade, lookalike host, null origin MUST be rejected
        h.bridge.handleIncomingMessage(msg, "https://attacker.example", true, h.reply);
        h.bridge.handleIncomingMessage(msg, "http://viread-frontend.vercel.app", true, h.reply);
        h.bridge.handleIncomingMessage(msg, "https://viread-frontend.vercel.app.evil.test", true, h.reply);
        h.bridge.handleIncomingMessage(msg, null, true, h.reply);

        assertTrue("Untrusted/subframe callers must receive ZERO replies", h.events.isEmpty());
        assertEquals(0, h.tts.speakCount);
        assertTrue(h.sttFactory.createdSessions.isEmpty());
    }

    @Test
    public void rejectsMalformedJsonAndUnknownActionsSafely() throws Exception {
        BridgeHarness h = new BridgeHarness();

        h.sendTrusted("{malformed-json");
        h.sendTrusted("");
        h.sendTrusted(null);
        h.sendTrusted("{\"action\":\"execArbitraryShell\",\"requestId\":\"bad-1\"}");

        assertEquals(4, h.events.size());
        assertEquals("bridge_error", h.events.get(0).getString("type"));
        assertEquals("invalid_json", h.events.get(0).getString("code"));
        assertEquals("invalid_json", h.events.get(1).getString("code"));
        assertEquals("invalid_json", h.events.get(2).getString("code"));
        assertEquals("unknown_action", h.events.get(3).getString("code"));
        assertEquals("bad-1", h.events.get(3).getString("requestId"));
        assertEquals(0, h.tts.speakCount);
        assertTrue(h.sttFactory.createdSessions.isEmpty());
    }

    // ---- Capabilities & TTS Tests ----

    @Test
    public void getCapabilitiesAwaitsAsyncTtsInitAndReportsAccuratePlatformMetadata() throws Exception {
        BridgeHarness h = new BridgeHarness();
        h.tts.autoCompleteInit = false;
        h.tts.viVoicesCount = 3;
        h.sttFactory.sttAvailable = true;
        h.sttFactory.onDeviceAvailable = true;

        h.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-async\"}");
        assertTrue("Should wait for async TTS init before replying", h.events.isEmpty());

        h.tts.completeInit(true);
        assertEquals(1, h.events.size());
        JSONObject cap = h.events.get(0);
        assertEquals("capabilities", cap.getString("type"));
        assertEquals("cap-async", cap.getString("requestId"));
        assertTrue(cap.getBoolean("ttsAvailable"));
        assertEquals(3, cap.getInt("viVoicesCount"));
        assertTrue(cap.getBoolean("sttAvailable"));
        assertTrue(cap.getBoolean("onDeviceSttAvailable"));
        assertEquals("android-webview", cap.getString("platform"));
    }

    @Test
    public void speakValidatesTextClampsRateStreamsRangesAndReleasesAudioFocus() throws Exception {
        BridgeHarness h = new BridgeHarness();

        // Empty text rejected
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"t-empty\",\"text\":\"   \"}");
        assertEquals("tts_error", h.events.get(0).getString("type"));
        assertEquals("invalid_text", h.events.get(0).getString("code"));

        // >2500 chars rejected
        StringBuilder oversized = new StringBuilder();
        for (int i = 0; i < 2501; i++) oversized.append('a');
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"t-long\",\"text\":\"" + oversized + "\"}");
        assertEquals("tts_error", h.events.get(1).getString("type"));
        assertEquals("text_too_long", h.events.get(1).getString("code"));
        assertEquals(0, h.tts.speakCount);

        // Valid speak clamps rate [0.6, 1.4] and uses USAGE_MEDIA + CONTENT_TYPE_SPEECH
        h.events.clear();
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"t-1\",\"text\":\"Hoa thơm ngát\",\"rate\":2.8,\"pitch\":1.1}");
        assertEquals(1, h.tts.speakCount);
        assertEquals("Hoa thơm ngát", h.tts.lastText);
        assertEquals(1.4f, h.tts.lastRate, 0.001f);
        assertEquals(1.1f, h.tts.lastPitch, 0.001f);
        assertEquals(AudioAttributes.USAGE_MEDIA, h.tts.lastAttributes.getUsage());
        assertEquals(AudioAttributes.CONTENT_TYPE_SPEECH, h.tts.lastAttributes.getContentType());
        assertTrue("Audio focus must be held during TTS", h.audioFocus.currentlyHeld);

        // Emit onStart -> onRangeStart -> onDone
        h.tts.lastCallback.onStart(h.tts.lastUtteranceId);
        h.tts.lastCallback.onRangeStart(h.tts.lastUtteranceId, 4, 8, 120);
        h.tts.lastCallback.onDone(h.tts.lastUtteranceId);

        assertEquals(3, h.events.size());
        assertEquals("tts_start", h.events.get(0).getString("type"));
        assertEquals("tts_range", h.events.get(1).getString("type"));
        assertEquals(4, h.events.get(1).getInt("start"));
        assertEquals(8, h.events.get(1).getInt("end"));
        assertEquals(120, h.events.get(1).getInt("frame"));
        assertEquals("tts_done", h.events.get(2).getString("type"));
        assertFalse("Audio focus must be released on tts_done", h.audioFocus.currentlyHeld);

        // Lower rate clamp [0.6] + stopSpeak releases audio focus
        h.events.clear();
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"t-2\",\"text\":\"Con mèo\",\"rate\":0.1}");
        assertEquals(0.6f, h.tts.lastRate, 0.001f);
        assertTrue(h.audioFocus.currentlyHeld);

        h.sendTrusted("{\"action\":\"stopSpeak\",\"requestId\":\"stop-2\"}");
        assertFalse(h.audioFocus.currentlyHeld);
        assertEquals(1, h.tts.stopCount);
        assertEquals("tts_stopped", h.events.get(0).getString("type"));
        assertEquals("t-2", h.events.get(0).getString("requestId"));
        assertEquals("tts_stopped", h.events.get(1).getString("type"));
        assertEquals("stop-2", h.events.get(1).getString("requestId"));
    }

    @Test
    public void selectBestVietnameseVoicePrefersOfflineHighQualityViVnAndOpenTtsSettingsReplies()
            throws Exception {
        Locale viVn = Locale.forLanguageTag("vi-VN");
        Locale enUs = Locale.forLanguageTag("en-US");
        Voice onlineHighVi = new Voice(
                "vi-vn-online", viVn, Voice.QUALITY_VERY_HIGH, Voice.LATENCY_NORMAL, true, Collections.emptySet());
        Voice offlineNormalVi = new Voice(
                "vi-vn-offline-normal", viVn, Voice.QUALITY_NORMAL, Voice.LATENCY_NORMAL, false, Collections.emptySet());
        Voice offlineHighVi = new Voice(
                "vi-vn-offline-high", viVn, Voice.QUALITY_HIGH, Voice.LATENCY_LOW, false, Collections.emptySet());
        Voice notInstalledVi = new Voice(
                "vi-vn-missing",
                viVn,
                Voice.QUALITY_VERY_HIGH,
                Voice.LATENCY_VERY_LOW,
                false,
                new HashSet<>(Collections.singletonList(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)));
        Voice offlineEn = new Voice(
                "en-us-offline", enUs, Voice.QUALITY_VERY_HIGH, Voice.LATENCY_VERY_LOW, false, Collections.emptySet());

        Set<Voice> voices = new HashSet<>(Arrays.asList(
                onlineHighVi, offlineNormalVi, offlineHighVi, notInstalledVi, offlineEn));
        Voice chosen = ViReadNativeSpeechBridge.selectBestVietnameseVoice(voices);
        assertNotNull(chosen);
        assertEquals("vi-vn-offline-high", chosen.getName());
        assertEquals(3, ViReadNativeSpeechBridge.countUsableVietnameseVoices(voices));

        // openTtsInstallSettings available vs unavailable
        BridgeHarness h = new BridgeHarness();
        h.host.ttsSettingsOpened = true;
        h.sendTrusted("{\"action\":\"openTtsInstallSettings\",\"requestId\":\"set-1\"}");
        assertEquals("tts_settings_opened", h.events.get(0).getString("type"));

        h.host.ttsSettingsOpened = false;
        h.sendTrusted("{\"action\":\"openTtsInstallSettings\",\"requestId\":\"set-2\"}");
        assertEquals("tts_settings_unavailable", h.events.get(1).getString("type"));
    }

    // ---- STT, Extras, Permission, Fallback & Mutual Exclusion Tests ----

    @Test
    public void startSttPopulatesVietnameseExtrasStreamsOnsetPartialsFinalAndHandlesPermission()
            throws Exception {
        BridgeHarness h = new BridgeHarness();
        h.host.hasAudioPermission = false;
        h.host.canRequestPermission = true;

        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-1\",\"lang\":\"vi-VN\",\"partialResults\":true,\"maxResults\":3}");
        assertEquals(1, h.host.permissionRequestCount);
        assertTrue("Recognizer must wait until permission granted", h.sttFactory.createdSessions.isEmpty());

        // Grant permission -> recognizer starts immediately with exact Vietnamese extras
        h.host.hasAudioPermission = true;
        h.bridge.onRecordAudioPermissionResult(true);
        assertEquals(1, h.sttFactory.createdSessions.size());
        FakeSttSession session = h.sttFactory.latest();
        assertTrue("Must prefer on-device recognizer when available", session.onDevice);
        assertNotNull(session.startedIntent);
        assertEquals("vi-VN", session.startedIntent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE));
        assertEquals("vi-VN", session.startedIntent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE));
        assertTrue(session.startedIntent.getBooleanExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, false));
        assertTrue(session.startedIntent.getBooleanExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false));
        assertEquals(3, session.startedIntent.getIntExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 0));
        assertEquals(
                1500,
                session.startedIntent.getIntExtra(
                        RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 0));
        assertEquals(
                1000,
                session.startedIntent.getIntExtra(
                        RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 0));

        // Drive full SpeechRecognizer event stream
        session.callback.onReadyForSpeech();
        h.clock.advance(50);
        long expectedOnset = h.clock.currentTimeMillis();
        session.callback.onBeginningOfSpeech();
        session.callback.onRmsChanged(7.5f);
        session.callback.onPartialResults(Collections.singletonList("hoa thơm"));
        session.callback.onFinalResults(Arrays.asList("hoa thơm ngát", "hoa thôm ngát"), new float[]{0.95f, 0.4f});

        assertEquals(6, h.events.size());
        assertEquals("stt_ready", h.events.get(0).getString("type"));
        assertEquals("stt_onset", h.events.get(1).getString("type"));
        assertEquals(expectedOnset, h.events.get(1).getLong("onsetAt"));
        assertEquals("stt_rms", h.events.get(2).getString("type"));
        assertEquals(7.5, h.events.get(2).getDouble("rmsDb"), 0.01);
        assertEquals("stt_partial", h.events.get(3).getString("type"));
        assertEquals("hoa thơm", h.events.get(3).getString("transcript"));
        assertEquals("stt_final", h.events.get(4).getString("type"));
        assertEquals("hoa thơm ngát", h.events.get(4).getString("transcript"));
        assertEquals(expectedOnset, h.events.get(4).getLong("onsetAt"));
        JSONArray alts = h.events.get(4).getJSONArray("alternatives");
        assertEquals(2, alts.length());
        assertEquals("hoa thơm ngát", alts.getString(0));
        assertEquals("hoa thôm ngát", alts.getString(1));
        assertEquals("stt_end", h.events.get(5).getString("type"));
        assertEquals(1, session.destroyCount);

        // Permission denial emits permission_denied + stt_end
        h.events.clear();
        h.host.hasAudioPermission = false;
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-denied\"}");
        h.bridge.onRecordAudioPermissionResult(false);
        assertEquals("stt_error", h.events.get(0).getString("type"));
        assertEquals("permission_denied", h.events.get(0).getString("code"));
        assertEquals("stt_end", h.events.get(1).getString("type"));
    }

    @Test
    public void onDeviceSttLanguageUnavailableAutomaticallyFallsBackToStandardRecognizer()
            throws Exception {
        BridgeHarness h = new BridgeHarness();
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-fb\"}");
        assertEquals(1, h.sttFactory.createdSessions.size());
        FakeSttSession onDeviceSession = h.sttFactory.createdSessions.get(0);
        assertTrue(onDeviceSession.onDevice);

        // Simulate missing offline vi-VN pack (ERROR_LANGUAGE_UNAVAILABLE = 13)
        onDeviceSession.callback.onError(13);
        assertEquals(1, onDeviceSession.destroyCount);
        assertEquals("Must immediately spawn fallback standard recognizer", 2, h.sttFactory.createdSessions.size());
        FakeSttSession standardSession = h.sttFactory.createdSessions.get(1);
        assertFalse(standardSession.onDevice);
        assertTrue("No error event should be exposed before fallback fails", h.events.isEmpty());

        standardSession.callback.onFinalResults(Collections.singletonList("con mèo"), null);
        assertEquals("stt_final", h.events.get(0).getString("type"));
        assertEquals("con mèo", h.events.get(0).getString("transcript"));
        assertEquals("stt_end", h.events.get(1).getString("type"));
    }

    @Test
    public void atomicMutualExclusionBetweenSttAndTtsEnforces150msSettleAndPreemption()
            throws Exception {
        BridgeHarness h = new BridgeHarness();

        // 1. Start STT
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-active\"}");
        FakeSttSession stt1 = h.sttFactory.latest();
        assertTrue(h.bridge.hasActiveSttForTest());

        // 2. Request speak while STT is active -> STT canceled/destroyed IMMEDIATELY; TTS waits 150ms
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"tts-after-stt\",\"text\":\"Xin chào bé\"}");
        assertEquals("STT must be canceled immediately before TTS", 1, stt1.cancelCount);
        assertEquals("STT must be destroyed immediately before TTS", 1, stt1.destroyCount);
        assertFalse(h.bridge.hasActiveSttForTest());
        assertEquals("stt_end", h.events.get(0).getString("type"));
        assertEquals("stt-active", h.events.get(0).getString("requestId"));
        assertEquals("TTS must NOT start before 150ms settle", 0, h.tts.speakCount);
        assertTrue(h.bridge.hasPendingSpeakSettleForTest());

        // At 100ms, still settling
        h.scheduler.advanceBy(100L);
        assertEquals(0, h.tts.speakCount);

        // At 150ms, TTS fires cleanly
        h.scheduler.advanceBy(50L);
        assertEquals(1, h.tts.speakCount);
        assertTrue(h.audioFocus.currentlyHeld);
        assertTrue(h.bridge.hasActiveTtsForTest());

        // 3. Start STT while TTS is speaking -> TTS stopped & audio focus abandoned immediately
        h.events.clear();
        int stopCountBeforePreempt = h.tts.stopCount;
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-preempt\"}");
        assertFalse("Audio focus must be released immediately on startStt", h.audioFocus.currentlyHeld);
        assertEquals(stopCountBeforePreempt + 1, h.tts.stopCount);
        assertFalse(h.bridge.hasActiveTtsForTest());
        assertEquals("tts_stopped", h.events.get(0).getString("type"));
        assertEquals("tts-after-stt", h.events.get(0).getString("requestId"));
        assertTrue(h.bridge.hasActiveSttForTest());

        // 4. stopStt calls stopListening and cancelStt destroys cleanly
        FakeSttSession preemptSession = h.sttFactory.latest();
        h.sendTrusted("{\"action\":\"stopStt\",\"requestId\":\"stt-stop-1\"}");
        assertEquals(1, preemptSession.stopListeningCount);
        h.sendTrusted("{\"action\":\"cancelStt\",\"requestId\":\"stt-cancel-1\"}");
        assertEquals(1, preemptSession.cancelCount);
        assertEquals(1, preemptSession.destroyCount);
        assertFalse(h.bridge.hasActiveSttForTest());

        // 5. Cancel settle if startStt arrives during 150ms window
        h.events.clear();
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-before-abort\"}");
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"tts-aborted\",\"text\":\"Sẽ bị hủy\"}");
        assertTrue(h.bridge.hasPendingSpeakSettleForTest());
        h.scheduler.advanceBy(60L);
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-override\"}");
        h.scheduler.advanceBy(200L);
        assertEquals("Superseded delayed TTS must NEVER fire", 1, h.tts.speakCount);
        assertTrue(h.bridge.hasActiveSttForTest());
    }

    @Test
    public void lifecycleStopAndDestroyCleanUpTtsSttAndAudioFocus() {
        BridgeHarness h = new BridgeHarness();

        // Active TTS -> onHostStop stops TTS & releases focus
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"tts-life\",\"text\":\"Đọc thử\"}");
        assertTrue(h.audioFocus.currentlyHeld);
        h.bridge.onHostStop();
        assertFalse(h.audioFocus.currentlyHeld);
        assertFalse(h.bridge.hasActiveTtsForTest());
        assertEquals(1, h.tts.stopCount);

        // Active STT -> onHostStop cancels & destroys recognizer
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-life\"}");
        FakeSttSession sttSession = h.sttFactory.latest();
        assertTrue(h.bridge.hasActiveSttForTest());
        h.bridge.onHostStop();
        assertFalse(h.bridge.hasActiveSttForTest());
        assertEquals(1, sttSession.cancelCount);
        assertEquals(1, sttSession.destroyCount);

        // Active STT + TTS -> onHostDestroy permanently shuts down TTS & ignores further messages
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-destroy\"}");
        FakeSttSession stt2 = h.sttFactory.latest();
        h.bridge.onHostDestroy();
        assertEquals(1, stt2.cancelCount);
        assertEquals(1, stt2.destroyCount);
        assertEquals(1, h.tts.shutdownCount);
        assertFalse(h.audioFocus.currentlyHeld);

        int prevEvents = h.events.size();
        h.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"after-destroy\"}");
        assertEquals("Destroyed bridge must ignore all incoming messages", prevEvents, h.events.size());
    }

    // ---- MainActivity Startup & Shell Optimization Tests ----

    @Test
    public void mainActivityEarlyRevealAuthDirectDashboardWarmupAndShellColors() {
        AtomicReference<String> warmedUrl = new AtomicReference<>();
        MainActivity.backendWarmupRunnerForTest = warmedUrl::set;

        // Seed Supabase auth cookie before cold launch
        String origin = BuildConfig.FRONTEND_URL;
        CookieManager.getInstance().setCookie(
                origin, "sb-akjxbkakbbabpblmsktm-auth-token=base64-session-token");
        CookieManager.getInstance().flush();

        // Verify helper excludes PKCE code-verifier cookie and empty cookie
        assertFalse(MainActivity.hasSupabaseAuthCookie(null));
        assertFalse(MainActivity.hasSupabaseAuthCookie("theme=light; sb-ref-auth-token-code-verifier=abc"));
        assertFalse(MainActivity.hasSupabaseAuthCookie("sb-ref-auth-token=; theme=light"));
        assertTrue(MainActivity.hasSupabaseAuthCookie("sb-ref-auth-token=abc123; path=/"));
        assertTrue(MainActivity.hasSupabaseAuthCookie("sb-ref-auth-token.0=chunk0"));

        ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        WebView webView = activity.getWebViewForTest();
        WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();

        // 1. Authenticated cold start skips "/" -> 307 redirect and loads /dashboard directly
        assertEquals(origin + "/dashboard", Shadows.shadowOf(webView).getLastLoadedUrl());
        // 2. Render backend health warmup fired non-blocking on cold start
        assertEquals(MainActivity.BACKEND_HEALTH_WARMUP_URL, warmedUrl.get());
        // 3. Cache mode stays LOAD_DEFAULT and shell colors match #FFFAF0 / #FFFFFF
        assertEquals(WebSettings.LOAD_DEFAULT, webView.getSettings().getCacheMode());
        assertEquals(
                MainActivity.COLOR_APP_CANVAS,
                ((ColorDrawable) ((View) webView.getParent()).getBackground()).getColor());
        assertEquals(
                MainActivity.COLOR_APP_CANVAS,
                ((ColorDrawable) activity.getStartupOverlayForTest().getBackground()).getColor());
        assertEquals(MainActivity.COLOR_BAR_WHITE, activity.getWindow().getStatusBarColor());
        assertEquals(MainActivity.COLOR_BAR_WHITE, activity.getWindow().getNavigationBarColor());
        assertNotNull(activity.getNativeSpeechBridgeForTest());

        // 4. Early reveal via onPageCommitVisible BEFORE onPageFinished
        assertEquals(View.VISIBLE, activity.getStartupOverlayForTest().getVisibility());
        assertEquals(View.INVISIBLE, webView.getVisibility());

        // Internal chrome-error / about:blank must NOT reveal WebView
        client.onPageCommitVisible(webView, "about:blank");
        client.onPageCommitVisible(webView, "chrome-error://chromewebdata/");
        assertEquals(View.INVISIBLE, webView.getVisibility());

        // Real page commit reveals WebView immediately
        client.onPageCommitVisible(webView, origin + "/dashboard");
        assertEquals(View.VISIBLE, webView.getVisibility());
        assertEquals(View.GONE, activity.getStartupOverlayForTest().getVisibility());

        // Clean lifecycle teardown
        controller.pause().stop().destroy();
    }

    @Test
    public void stopSttDoesNotEmitPrematureSttEndAndStartSttHonorsPreferOnDeviceFlag()
            throws Exception {
        BridgeHarness h = new BridgeHarness();

        // 1. preferOnDevice: false must request standard recognizer rather than on-device
        h.sendTrusted(
                "{\"action\":\"startStt\",\"requestId\":\"stt-cloud\",\"lang\":\"vi-VN\",\"preferOnDevice\":false}");
        assertEquals(1, h.sttFactory.createdSessions.size());
        FakeSttSession cloudSession = h.sttFactory.latest();
        assertFalse("preferOnDevice=false must skip on-device recognizer", cloudSession.onDevice);
        assertTrue(h.bridge.isAudioSessionActive());

        // 2. stopStt with a distinct requestId must NOT emit a premature stt_end before final results
        h.events.clear();
        h.sendTrusted("{\"action\":\"stopStt\",\"requestId\":\"stop-distinct\"}");
        assertEquals(1, cloudSession.stopListeningCount);
        assertTrue(
                "stopStt must wait for recognizer finalization instead of emitting premature stt_end",
                h.events.isEmpty());
        assertTrue(h.bridge.hasActiveSttForTest());

        // 3. Final results deliver stt_final + single terminal stt_end for active requestId
        cloudSession.callback.onFinalResults(Collections.singletonList("xin chào"), null);
        assertEquals(2, h.events.size());
        assertEquals("stt_final", h.events.get(0).getString("type"));
        assertEquals("stt-cloud", h.events.get(0).getString("requestId"));
        assertEquals("stt_end", h.events.get(1).getString("type"));
        assertEquals("stt-cloud", h.events.get(1).getString("requestId"));
        assertFalse(h.bridge.isAudioSessionActive());

        // 4. Stopping when idle still resolves immediately with stt_end
        h.events.clear();
        h.sendTrusted("{\"action\":\"stopStt\",\"requestId\":\"stop-idle\"}");
        assertEquals(1, h.events.size());
        assertEquals("stt_end", h.events.get(0).getString("type"));
        assertEquals("stop-idle", h.events.get(0).getString("requestId"));

        // 5. On-device error 13 AFTER stopStt must NOT spawn a zombie cloud recognizer
        h.events.clear();
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-stop-err13\"}");
        int sessionsBeforeStop = h.sttFactory.createdSessions.size();
        FakeSttSession stoppingSession = h.sttFactory.latest();
        assertTrue(stoppingSession.onDevice);
        h.sendTrusted("{\"action\":\"stopStt\",\"requestId\":\"stop-err13\"}");
        stoppingSession.callback.onError(13);
        assertEquals(
                "stopStt followed by on-device error 13 must not spawn cloud fallback",
                sessionsBeforeStop,
                h.sttFactory.createdSessions.size());
        assertFalse(h.bridge.hasActiveSttForTest());
        assertEquals("stt_error", h.events.get(0).getString("type"));
        assertEquals("stt_end", h.events.get(1).getString("type"));
    }

    @Test
    public void selectBestVietnameseVoiceMatchesRequestedGenderAndSpeakForwardsVoiceMetadata()
            throws Exception {
        Locale viVn = Locale.forLanguageTag("vi-VN");
        Voice femaleOffline = new Voice(
                "vi-vn-x-gft-local", viVn, Voice.QUALITY_HIGH, Voice.LATENCY_LOW, false, Collections.emptySet());
        Voice maleOffline = new Voice(
                "vi-vn-x-vid-local", viVn, Voice.QUALITY_HIGH, Voice.LATENCY_LOW, false, Collections.emptySet());
        Set<Voice> voices = new HashSet<>(Arrays.asList(femaleOffline, maleOffline));

        assertTrue(ViReadNativeSpeechBridge.hasUsableVietnameseVoiceForGender(voices, "male"));
        assertTrue(ViReadNativeSpeechBridge.hasUsableVietnameseVoiceForGender(voices, "female"));
        Voice chosenMale = ViReadNativeSpeechBridge.selectBestVietnameseVoice(voices, "male");
        Voice chosenFemale = ViReadNativeSpeechBridge.selectBestVietnameseVoice(voices, "female");
        assertNotNull(chosenMale);
        assertNotNull(chosenFemale);
        assertEquals("vi-vn-x-vid-local", chosenMale.getName());
        assertEquals("vi-vn-x-gft-local", chosenFemale.getName());

        BridgeHarness h = new BridgeHarness();
        h.tts.hasMaleViVoice = true;
        h.tts.hasFemaleViVoice = true;
        h.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-gender\"}");
        assertTrue(h.events.get(0).getBoolean("hasMaleViVoice"));
        assertTrue(h.events.get(0).getBoolean("hasFemaleViVoice"));

        h.events.clear();
        h.sendTrusted(
                "{\"action\":\"speak\",\"requestId\":\"tts-male\",\"text\":\"Xin chào\",\"voiceId\":\"local_north_thien_minh\"}");
        assertEquals("male", h.tts.lastVoiceGender);
        assertEquals("local_north_thien_minh", h.tts.lastVoiceId);
        h.tts.lastCallback.onStart(h.tts.lastUtteranceId);
        assertEquals("tts_start", h.events.get(0).getString("type"));
        assertEquals("male", h.events.get(0).getString("actualVoiceGender"));
    }

    @Test
    public void ttsInitFailureTimeoutAndSpeakFailureRecoverCleanly() throws Exception {
        // 1. Synchronous init failure -> getCapabilities reports false, explicit speak retries cleanly
        BridgeHarness h = new BridgeHarness();
        h.tts.autoCompleteInit = false;
        h.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-fail-1\"}");
        assertEquals(1, h.tts.initCount);
        h.tts.completeInit(false);
        assertEquals(1, h.events.size());
        assertFalse(h.events.get(0).getBoolean("ttsAvailable"));

        h.events.clear();
        h.tts.initSuccess = true;
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"spk-recover\",\"text\":\"Xin chào\"}");
        assertEquals(2, h.tts.initCount);
        h.tts.completeInit(true);
        assertEquals(1, h.tts.speakCount);
        assertEquals("Xin chào", h.tts.lastText);

        // 2. Init timeout -> suppresses rapid cap retry before cooldown, recovers after cooldown
        BridgeHarness t = new BridgeHarness();
        t.tts.autoCompleteInit = false;
        t.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-to-1\"}");
        assertEquals(1, t.tts.initCount);
        t.scheduler.advanceBy(ViReadNativeSpeechBridge.TTS_INIT_TIMEOUT_MS);
        assertEquals(1, t.events.size());
        assertFalse(t.events.get(0).getBoolean("ttsAvailable"));

        t.events.clear();
        t.scheduler.advanceBy(1_000L);
        t.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-cooldown\"}");
        assertEquals("Cooldown must suppress rapid cap retry", 1, t.tts.initCount);
        assertFalse(t.events.get(0).getBoolean("ttsAvailable"));

        t.events.clear();
        t.tts.initSuccess = true;
        t.scheduler.advanceBy(ViReadNativeSpeechBridge.TTS_INIT_RETRY_COOLDOWN_MS);
        t.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-recover\"}");
        assertEquals(2, t.tts.initCount);
        t.tts.completeInit(true);
        assertEquals(1, t.events.size());
        assertTrue(t.events.get(0).getBoolean("ttsAvailable"));

        // 3. speak() failure marks binding unready and next speak() re-initializes
        t.events.clear();
        t.tts.speakShouldSucceed = false;
        t.sendTrusted("{\"action\":\"speak\",\"requestId\":\"spk-fail\",\"text\":\"Thử lại\"}");
        assertEquals("tts_error", t.events.get(0).getString("type"));
        assertEquals("tts_speak_failed", t.events.get(0).getString("code"));

        t.events.clear();
        t.tts.speakShouldSucceed = true;
        t.sendTrusted("{\"action\":\"speak\",\"requestId\":\"spk-rebind\",\"text\":\"Thành công\"}");
        assertEquals(3, t.tts.initCount);
        t.tts.completeInit(true);
        assertEquals(2, t.tts.speakCount);
    }

    @Test
    public void sttBusyRetryCancelledOnSpeakStopAndHostStopWithoutZombieSession() throws Exception {
        // 1. Preempted by speak during 220ms busy retry backoff
        BridgeHarness h = new BridgeHarness();
        h.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-busy-1\"}");
        FakeSttSession s1 = h.sttFactory.latest();
        s1.callback.onError(SpeechRecognizer.ERROR_RECOGNIZER_BUSY);
        assertTrue(h.bridge.isAudioSessionActive());
        int sessionsAfterBusy = h.sttFactory.createdSessions.size();

        h.events.clear();
        h.sendTrusted("{\"action\":\"speak\",\"requestId\":\"tts-preempt\",\"text\":\"Đọc mẫu\"}");
        assertTrue(
                h.events.stream()
                        .anyMatch(e -> e.optString("type").equals("stt_end")
                                && e.optString("requestId").equals("stt-busy-1")));
        h.scheduler.advanceBy(400L);
        assertEquals("Cancelled busy retry must NOT spawn zombie STT", sessionsAfterBusy, h.sttFactory.createdSessions.size());
        assertEquals(1, h.tts.speakCount);

        // 2. Cancelled by stopStt during 220ms busy retry backoff
        BridgeHarness h2 = new BridgeHarness();
        h2.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-busy-2\"}");
        h2.sttFactory.latest().callback.onError(SpeechRecognizer.ERROR_RECOGNIZER_BUSY);
        int sessionsBeforeStop = h2.sttFactory.createdSessions.size();
        h2.events.clear();
        h2.sendTrusted("{\"action\":\"stopStt\",\"requestId\":\"stop-busy-2\"}");
        assertFalse(h2.bridge.isAudioSessionActive());
        assertTrue(
                h2.events.stream()
                        .anyMatch(e -> e.optString("type").equals("stt_end")
                                && e.optString("requestId").equals("stt-busy-2")));
        h2.scheduler.advanceBy(400L);
        assertEquals(sessionsBeforeStop, h2.sttFactory.createdSessions.size());

        // 3. Cancelled by onHostStop during 220ms busy retry backoff
        BridgeHarness h3 = new BridgeHarness();
        h3.sendTrusted("{\"action\":\"startStt\",\"requestId\":\"stt-busy-3\"}");
        h3.sttFactory.latest().callback.onError(SpeechRecognizer.ERROR_RECOGNIZER_BUSY);
        int sessionsBeforeHostStop = h3.sttFactory.createdSessions.size();
        h3.events.clear();
        h3.bridge.onHostStop();
        assertFalse(h3.bridge.isAudioSessionActive());
        h3.scheduler.advanceBy(400L);
        assertEquals(sessionsBeforeHostStop, h3.sttFactory.createdSessions.size());
    }

    @Test
    public void warmUpTtsPreBindsEngineOnceAndSharesPendingInitWithCapabilities() throws Exception {
        BridgeHarness h = new BridgeHarness();
        h.tts.autoCompleteInit = false;

        h.bridge.warmUpTts();
        assertEquals(1, h.tts.initCount);

        // Repeated warmUpTts or getCapabilities while init is pending must reuse the active bind
        h.bridge.warmUpTts();
        h.sendTrusted("{\"action\":\"getCapabilities\",\"requestId\":\"cap-warm-share\"}");
        assertEquals(1, h.tts.initCount);
        assertTrue(h.events.isEmpty());

        h.tts.completeInit(true);
        assertEquals(1, h.events.size());
        assertEquals("cap-warm-share", h.events.get(0).getString("requestId"));
        assertTrue(h.events.get(0).getBoolean("ttsAvailable"));

        // Subsequent warmUpTts after completion must be a no-op
        h.bridge.warmUpTts();
        assertEquals(1, h.tts.initCount);
    }

    @Test
    public void teacherVoiceGenderSelectionAndMismatchTelemetry() throws Exception {
        Locale viVn = Locale.forLanguageTag("vi-VN");
        Voice femaleVoice = new Voice(
                "vi-vn-x-vie-local",
                viVn,
                Voice.QUALITY_HIGH,
                Voice.LATENCY_LOW,
                false,
                Collections.singleton("female"));
        Voice maleVoice = new Voice(
                "vi-vn-x-gft-local",
                viVn,
                Voice.QUALITY_HIGH,
                Voice.LATENCY_LOW,
                false,
                Collections.singleton("male"));
        Set<Voice> voices = new HashSet<>(Arrays.asList(femaleVoice, maleVoice));

        Voice chosenMale = ViReadNativeSpeechBridge.selectBestVietnameseVoice(voices, "male");
        assertNotNull(chosenMale);
        assertEquals("vi-vn-x-gft-local", chosenMale.getName());

        Voice chosenFemale = ViReadNativeSpeechBridge.selectBestVietnameseVoice(voices, "female");
        assertNotNull(chosenFemale);
        assertEquals("vi-vn-x-vie-local", chosenFemale.getName());

        BridgeHarness h = new BridgeHarness();
        h.tts.voiceGenderMismatch = true;
        h.tts.resolvedVoiceName = "vi-vn-x-vie-local";
        h.sendTrusted(
                "{\"action\":\"speak\",\"requestId\":\"req-male-1\",\"text\":\"Thầy chào con\","
                        + "\"voiceGender\":\"male\",\"voiceId\":\"local_north_thien_minh\"}");
        assertEquals("male", h.tts.lastVoiceGender);
        assertEquals("local_north_thien_minh", h.tts.lastVoiceId);

        assertNotNull(h.tts.lastCallback);
        h.tts.lastCallback.onStart(h.tts.lastUtteranceId);

        JSONObject startEvent = null;
        for (JSONObject ev : h.events) {
            if ("tts_start".equals(ev.optString("type"))) {
                startEvent = ev;
            }
        }
        assertNotNull("Expected tts_start event", startEvent);
        assertTrue(startEvent.optBoolean("voiceGenderMismatch", false));
        assertEquals("vi-vn-x-vie-local", startEvent.optString("resolvedVoiceName"));
    }
}
