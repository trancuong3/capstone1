package vn.viread.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Branded server-backed Android shell for ViRead.
 * - Preserves strict SSR / PKCE security (zero JS bridge, zero secrets, exact HTTPS origin).
 * - Never exposes raw Chromium error HTML (hides WebView immediately on main-frame error).
 * - Supports Adaptive Icons, Splash transition, Edge-to-Edge insets, Android 13-15 Back gestures,
 *   multi-format document picker (.jpg/.png/.webp/.bmp/.tiff/.pdf/.docx), and direct Camera capture
 *   via FileProvider.
 */
public final class MainActivity extends Activity {
    static final int WEB_PERMISSION_CODE = 151;
    static final int FILE_CHOOSER_CODE = 152;
    static final int CAMERA_CHOOSER_PERMISSION_CODE = 153;

    private static final long COLD_START_HINT_MS = 8_000L;
    private static final long LOAD_TIMEOUT_MS = 25_000L;
    private static final long BACK_EXIT_WINDOW_MS = 2_000L;
    static final String VIREAD_ANDROID_UA_MARKER = "ViReadAndroid/1.0";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OAuthLoopbackServer oauthLoopbackServer = new OAuthLoopbackServer();

    private ServerEndpointStore endpointStore;
    private TrustedNavigation navigation;

    private WebView webView;
    private ProgressBar progress;
    private LinearLayout startupOverlay;
    private TextView startupSubtitleView;
    private ScrollView errorOverlay;
    private TextView errorTitleView;
    private TextView errorMessageView;
    private TextView errorDetailView;
    private Button retryButton;
    private Button homeButton;
    private Button checkConnectionButton;
    private Button configureLanButton;

    private PermissionRequest pendingPermission;
    private boolean awaitingSystemPermission;
    private ValueCallback<Uri[]> pendingFiles;
    private WebChromeClient.FileChooserParams pendingCameraChooserParams;
    private Uri pendingCameraCaptureUri;
    private File pendingCameraCaptureFile;

    private boolean mainFrameHasError;
    private boolean hasLoadedCleanPage;
    private String activeTargetUrl;
    private String lastFailedUrl;
    private long lastBackPressMs;
    private OnBackInvokedCallback backInvokedCallback;

    private final Runnable coldStartHintRunnable = () -> {
        if (!hasLoadedCleanPage && !mainFrameHasError && startupSubtitleView != null) {
            startupSubtitleView.setText(R.string.loading_cold_start_hint);
        }
    };
    private final Runnable loadTimeoutRunnable = () -> {
        if (!hasLoadedCleanPage && !mainFrameHasError) {
            onMainFrameFailure(
                    activeTargetUrl,
                    getString(R.string.error_title_server),
                    getString(R.string.timeout_message),
                    "LOAD_TIMEOUT");
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        setTheme(R.style.Theme_ViRead);
        super.onCreate(state);

        endpointStore = new ServerEndpointStore(this);
        navigation = endpointStore.resolveNavigation();
        activeTargetUrl = navigation.getOrigin();

        configureSystemBarsAndEdgeToEdge();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF6FAF8);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
                            | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        webView = new WebView(this);
        webView.setBackgroundColor(0xFFF6FAF8);
        webView.setVisibility(View.INVISIBLE);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        startupOverlay = buildStartupOverlay();
        root.addView(startupOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorOverlay = buildErrorOverlay();
        errorOverlay.setVisibility(View.GONE);
        root.addView(errorOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(4));
        progressParams.gravity = Gravity.TOP;
        root.addView(progress, progressParams);

        setContentView(root);
        configureWebViewSettings(webView.getSettings());
        installWebViewClients();
        registerModernBackCallback();
        cleanupStaleCameraCaptures(true);

        String initialDeepLinkCallback = resolveAuthCallbackIntent(getIntent());
        if (initialDeepLinkCallback != null) {
            loadTrustedUrl(initialDeepLinkCallback);
        } else if (state != null && webView.restoreState(state) != null) {
            hasLoadedCleanPage = true;
            startupOverlay.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
        } else {
            loadTrustedUrl(navigation.getOrigin());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (webView != null) {
            webView.onResume();
        }
        String callbackUrl = resolveAuthCallbackIntent(intent);
        if (callbackUrl != null) {
            loadTrustedUrl(callbackUrl);
        }
    }

    String resolveAuthCallbackIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return null;
        }
        Uri data = intent.getData();
        return data != null ? navigation.extractTrustedAuthCallbackUrl(data.toString()) : null;
    }

    private void configureSystemBarsAndEdgeToEdge() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(0xFFF6FAF8);
        getWindow().setNavigationBarColor(0xFFF6FAF8);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        }
    }

    private void configureWebViewSettings(WebSettings settings) {
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Required for Android content:// document & camera URIs
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Safe on our isolated single-origin shell; prevents silent NotAllowedError on async Vietnamese TTS.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        String defaultUa = settings.getUserAgentString();
        if (defaultUa != null && !defaultUa.contains("ViReadAndroid/")) {
            settings.setUserAgentString(defaultUa + " " + VIREAD_ANDROID_UA_MARKER);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
    }

    private void installWebViewClients() {
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) return false;
                return handleNavigation(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return url != null && handleNavigation(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handleSslError(
                        handler != null ? handler::cancel : null,
                        error != null ? error.getUrl() : null);
            }

            @Override
            public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                int code = error != null ? error.getErrorCode() : ERROR_UNKNOWN;
                CharSequence desc = error != null ? error.getDescription() : null;
                handleMainFrameResourceError(request, code, desc);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(
                    WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return;
                boolean isTimeout = errorCode == ERROR_TIMEOUT;
                onMainFrameFailure(
                        failingUrl,
                        getString(isTimeout
                                ? R.string.error_title_server
                                : R.string.error_title_network),
                        getString(isTimeout
                                ? R.string.timeout_message
                                : R.string.offline_message),
                        description != null ? description : "ERR_" + errorCode);
            }

            @Override
            public void onReceivedHttpError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceResponse errorResponse) {
                if (request == null || !request.isForMainFrame() || errorResponse == null) {
                    return;
                }
                int status = errorResponse.getStatusCode();
                if (status >= 500) {
                    String failed = request.getUrl() != null
                            ? request.getUrl().toString()
                            : navigation.getOrigin();
                    onMainFrameFailure(
                            failed,
                            getString(R.string.error_title_server),
                            getString(R.string.server_5xx_message, status),
                            "HTTP_" + status);
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (isInternalBlankOrErrorUrl(url)) return;
                if (!mainFrameHasError && progress != null) {
                    progress.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                // Immediately persist SPA session cookies (e.g. signInWithPassword -> router.replace)
                // to Android's SQLite CookieStore so force-stop / swipe-away never loses login state.
                CookieManager.getInstance().flush();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (isInternalBlankOrErrorUrl(url)) return;
                cancelLoadWatchdog();
                if (progress != null) progress.setVisibility(View.GONE);
                if (!mainFrameHasError) {
                    hasLoadedCleanPage = true;
                    if (startupOverlay != null) startupOverlay.setVisibility(View.GONE);
                    if (errorOverlay != null) errorOverlay.setVisibility(View.GONE);
                    if (webView != null) webView.setVisibility(View.VISIBLE);
                }
                CookieManager.getInstance().flush();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                if (progress == null || mainFrameHasError) return;
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> requestWebPermission(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (pendingPermission == request) pendingPermission = null;
                });
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                return launchFileAndCameraChooser(callback, params);
            }
        });
    }

    private static boolean isInternalBlankOrErrorUrl(String url) {
        if (url == null || url.isEmpty()) return true;
        return "about:blank".equalsIgnoreCase(url)
                || url.startsWith("chrome-error://")
                || url.startsWith("data:text/html,chromewebdata");
    }

    void handleSslError(Runnable cancelAction, String failingUrl) {
        if (cancelAction != null && !navigation.shouldProceedOnSslError()) {
            cancelAction.run();
        }
        onMainFrameFailure(
                failingUrl != null ? failingUrl : navigation.getOrigin(),
                getString(R.string.error_title_tls),
                getString(R.string.tls_error_message),
                "TLS_CERT_INVALID");
    }

    void handleMainFrameResourceError(
            WebResourceRequest request, int errorCode, CharSequence description) {
        if (request == null || !request.isForMainFrame()) return;
        String failed = request.getUrl() != null
                ? request.getUrl().toString()
                : navigation.getOrigin();
        String codeLabel = (description != null && description.length() > 0)
                ? description.toString()
                : "ERR_" + errorCode;
        boolean isTimeout = errorCode == WebViewClient.ERROR_TIMEOUT;
        onMainFrameFailure(
                failed,
                getString(isTimeout
                        ? R.string.error_title_server
                        : R.string.error_title_network),
                getString(isTimeout
                        ? R.string.timeout_message
                        : R.string.offline_message),
                codeLabel);
    }

    void loadTrustedUrl(String candidateUrl) {
        String target = (candidateUrl != null && navigation.isTrusted(candidateUrl))
                ? candidateUrl
                : navigation.getOrigin();
        mainFrameHasError = false;
        activeTargetUrl = target;
        if (errorOverlay != null) errorOverlay.setVisibility(View.GONE);
        if (!hasLoadedCleanPage) {
            if (startupSubtitleView != null) {
                startupSubtitleView.setText(R.string.loading_subtitle);
            }
            if (startupOverlay != null) startupOverlay.setVisibility(View.VISIBLE);
            if (webView != null) webView.setVisibility(View.INVISIBLE);
        }
        scheduleLoadWatchdog();
        if (webView != null) {
            webView.loadUrl(target);
        }
    }

    private void scheduleLoadWatchdog() {
        cancelLoadWatchdog();
        mainHandler.postDelayed(coldStartHintRunnable, COLD_START_HINT_MS);
        mainHandler.postDelayed(loadTimeoutRunnable, LOAD_TIMEOUT_MS);
    }

    private void cancelLoadWatchdog() {
        mainHandler.removeCallbacks(coldStartHintRunnable);
        mainHandler.removeCallbacks(loadTimeoutRunnable);
    }

    void onMainFrameFailure(String failingUrl, String title, String message, String codeLabel) {
        runOnUiThread(() -> {
            cancelLoadWatchdog();
            mainFrameHasError = true;
            lastFailedUrl = (failingUrl != null && navigation.isTrusted(failingUrl))
                    ? failingUrl
                    : navigation.getOrigin();
            if (webView != null) {
                webView.stopLoading();
                // Hide WebView immediately so raw Chromium net::ERR_* HTML is NEVER visible.
                webView.setVisibility(View.INVISIBLE);
            }
            if (startupOverlay != null) startupOverlay.setVisibility(View.GONE);
            if (progress != null) progress.setVisibility(View.GONE);
            if (errorTitleView != null) errorTitleView.setText(title);
            if (errorMessageView != null) errorMessageView.setText(message);
            if (errorDetailView != null) {
                String suffix = (codeLabel != null && !codeLabel.trim().isEmpty())
                        ? " · " + codeLabel.trim()
                        : "";
                errorDetailView.setText("Máy chủ: " + navigation.getOrigin() + suffix);
            }
            if (errorOverlay != null) errorOverlay.setVisibility(View.VISIBLE);
        });
    }

    private LinearLayout buildStartupOverlay() {
        int pad = dp(28);
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setGravity(Gravity.CENTER);
        container.setBackgroundColor(0xFFF6FAF8);
        container.setPadding(pad, pad, pad, pad);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.viread_splash_logo);
        logo.setContentDescription(getString(R.string.app_name));
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(96), dp(96));
        logoParams.bottomMargin = dp(12);
        container.addView(logo, logoParams);

        TextView brand = new TextView(this);
        brand.setText(R.string.app_name);
        brand.setTextColor(0xFF153A53);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        brand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        brand.setGravity(Gravity.CENTER);
        container.addView(brand);

        startupSubtitleView = new TextView(this);
        startupSubtitleView.setText(R.string.loading_subtitle);
        startupSubtitleView.setTextColor(0xFF52676B);
        startupSubtitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        startupSubtitleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subParams.topMargin = dp(8);
        subParams.bottomMargin = dp(20);
        container.addView(startupSubtitleView, subParams);

        ProgressBar spinner = new ProgressBar(this);
        container.addView(spinner, new LinearLayout.LayoutParams(dp(36), dp(36)));

        return container;
    }

    private ScrollView buildErrorOverlay() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(0xFFF6FAF8);

        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setGravity(Gravity.CENTER);
        int outerPad = dp(20);
        outer.setPadding(outerPad, outerPad, outerPad, outerPad);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        int cardPad = dp(24);
        card.setPadding(cardPad, cardPad, cardPad, cardPad);
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(0xFFFFFFFF);
        cardBg.setCornerRadius(dp(20));
        cardBg.setStroke(dp(1), 0xFFCEDED8);
        card.setBackground(cardBg);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.viread_splash_logo);
        logo.setContentDescription(getString(R.string.app_name));
        card.addView(logo, new LinearLayout.LayoutParams(dp(72), dp(72)));

        TextView brandPill = new TextView(this);
        brandPill.setText(R.string.app_name);
        brandPill.setTextColor(0xFF087467);
        brandPill.setTypeface(Typeface.DEFAULT_BOLD);
        brandPill.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        brandPill.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams pillParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pillParams.topMargin = dp(4);
        card.addView(brandPill, pillParams);

        errorTitleView = new TextView(this);
        errorTitleView.setText(R.string.error_title_network);
        errorTitleView.setTextColor(0xFF153A53);
        errorTitleView.setTypeface(Typeface.DEFAULT_BOLD);
        errorTitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        errorTitleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(10);
        card.addView(errorTitleView, titleParams);

        errorMessageView = new TextView(this);
        errorMessageView.setText(R.string.offline_message);
        errorMessageView.setTextColor(0xFF52676B);
        errorMessageView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        errorMessageView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msgParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        msgParams.topMargin = dp(10);
        card.addView(errorMessageView, msgParams);

        errorDetailView = new TextView(this);
        errorDetailView.setTextColor(0xFF52676B);
        errorDetailView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        errorDetailView.setGravity(Gravity.CENTER);
        GradientDrawable chipBg = new GradientDrawable();
        chipBg.setColor(0xFFF6FAF8);
        chipBg.setCornerRadius(dp(10));
        errorDetailView.setBackground(chipBg);
        errorDetailView.setPadding(dp(12), dp(8), dp(12), dp(8));
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        detailParams.topMargin = dp(14);
        detailParams.bottomMargin = dp(20);
        card.addView(errorDetailView, detailParams);

        retryButton = createStyledButton(getString(R.string.retry_button), true);
        retryButton.setOnClickListener(v -> {
            String target = (lastFailedUrl != null && navigation.isTrusted(lastFailedUrl))
                    ? lastFailedUrl
                    : navigation.getOrigin();
            loadTrustedUrl(target);
        });
        card.addView(retryButton, fullWidthButtonParams(0));

        homeButton = createStyledButton(getString(R.string.open_home_button), false);
        homeButton.setOnClickListener(v -> loadTrustedUrl(navigation.getOrigin() + "/login"));
        card.addView(homeButton, fullWidthButtonParams(dp(10)));

        checkConnectionButton = createStyledButton(
                getString(R.string.check_connection_button), false);
        checkConnectionButton.setOnClickListener(v -> {
            if (!isDeviceNetworkConnected()) {
                Toast.makeText(this, R.string.no_network_toast, Toast.LENGTH_SHORT).show();
                return;
            }
            Toast.makeText(this, R.string.network_ready_toast, Toast.LENGTH_SHORT).show();
            String target = (lastFailedUrl != null && navigation.isTrusted(lastFailedUrl))
                    ? lastFailedUrl
                    : navigation.getOrigin();
            loadTrustedUrl(target);
        });
        card.addView(checkConnectionButton, fullWidthButtonParams(dp(10)));

        // Strictly compiled/instantiated ONLY in Debug + LAN Acceptance mode
        if (BuildConfig.DEBUG && endpointStore.canOverrideEndpoint()) {
            configureLanButton = createStyledButton(
                    getString(R.string.configure_lan_server_button), false);
            configureLanButton.setOnClickListener(v -> showDebugLanServerDialog());
            card.addView(configureLanButton, fullWidthButtonParams(dp(10)));
        }

        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        outer.addView(card, cardParams);
        scroll.addView(outer, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private Button createStyledButton(String label, boolean primary) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setMinHeight(dp(48));
        button.setPadding(dp(16), dp(12), dp(16), dp(12));
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        if (primary) {
            bg.setColor(0xFF087467);
            button.setTextColor(0xFFFFFFFF);
        } else {
            bg.setColor(0xFFF6FAF8);
            bg.setStroke(dp(1), 0xFFCEDED8);
            button.setTextColor(0xFF153A53);
        }
        button.setBackground(bg);
        return button;
    }

    private LinearLayout.LayoutParams fullWidthButtonParams(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = topMargin;
        return params;
    }

    private void showDebugLanServerDialog() {
        if (!BuildConfig.DEBUG || !endpointStore.canOverrideEndpoint() || isFinishing()) {
            return;
        }
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        body.setPadding(pad, dp(12), pad, dp(4));

        TextView hint = new TextView(this);
        hint.setText(R.string.lan_dialog_hint);
        hint.setTextColor(0xFF52676B);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        body.addView(hint);

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(navigation.getOrigin());
        input.setSelection(input.getText().length());
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = dp(12);
        body.addView(input, inputParams);

        new AlertDialog.Builder(this)
                .setTitle(R.string.lan_dialog_title)
                .setView(body)
                .setPositiveButton(R.string.lan_dialog_save, (dialog, which) -> {
                    String candidate = input.getText() != null
                            ? input.getText().toString().trim()
                            : "";
                    try {
                        navigation = endpointStore.saveCustomLanOrigin(candidate);
                        lastFailedUrl = null;
                        hasLoadedCleanPage = false;
                        loadTrustedUrl(navigation.getOrigin());
                    } catch (IllegalArgumentException | SecurityException ex) {
                        Toast.makeText(
                                this, R.string.lan_invalid_url_toast, Toast.LENGTH_LONG).show();
                    }
                })
                .setNeutralButton(R.string.lan_dialog_reset, (dialog, which) -> {
                    navigation = endpointStore.clearCustomLanOrigin();
                    lastFailedUrl = null;
                    hasLoadedCleanPage = false;
                    loadTrustedUrl(navigation.getOrigin());
                })
                .setNegativeButton(R.string.lan_dialog_cancel, null)
                .show();
    }

    private boolean isDeviceNetworkConnected() {
        ConnectivityManager cm =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network active = cm.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        return caps != null
                && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                        || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    boolean handleNavigation(Uri uri) {
        if (uri == null) return true;
        String url = uri.toString();
        if (navigation.isTrusted(url)) return false;

        String oauthNonce = TrustedNavigation.extractOAuthLoopbackNonce(url);
        if (oauthNonce != null) {
            if (webView != null) {
                webView.stopLoading();
            }
            CookieManager.getInstance().flush();
            try {
                oauthLoopbackServer.start(
                        OAuthLoopbackServer.DEFAULT_PORT,
                        oauthNonce,
                        this::onOAuthLoopbackCompleted);
            } catch (IOException ex) {
                Toast.makeText(
                        this,
                        "Không thể khởi tạo cổng xác thực cục bộ. Vui lòng thử lại.",
                        Toast.LENGTH_LONG).show();
                return true;
            }
            openExternalOAuthTab(uri);
            return true;
        }

        if (navigation.shouldOpenExternally(url)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(
                        this,
                        "Không tìm thấy ứng dụng để mở liên kết.",
                        Toast.LENGTH_SHORT).show();
            }
        }
        return true; // Block HTTP, file:, intent:, javascript: and untrusted navigation.
    }

    private void openExternalOAuthTab(Uri uri) {
        try {
            CustomTabColorSchemeParams colors = new CustomTabColorSchemeParams.Builder()
                    .setToolbarColor(0xFF087467)
                    .build();
            CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder()
                    .setDefaultColorSchemeParams(colors)
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build();
            customTabsIntent.launchUrl(this, uri);
        } catch (ActivityNotFoundException ex) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException inner) {
                oauthLoopbackServer.stop();
                Toast.makeText(
                        this,
                        "Không tìm thấy trình duyệt hệ thống để đăng nhập.",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    private void onOAuthLoopbackCompleted(String sanitizedQuerySuffix) {
        mainHandler.post(() -> {
            if (isFinishing() || webView == null) {
                return;
            }
            webView.onResume();
            String suffix = sanitizedQuerySuffix != null ? sanitizedQuerySuffix : "";
            loadTrustedUrl(navigation.getOrigin() + "/auth/callback" + suffix);
            try {
                Intent bringFront = new Intent(this, MainActivity.class);
                bringFront.addFlags(
                        Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(bringFront);
            } catch (Exception ignored) {
                // Foreground return is also driven by HTTP 302 -> viread://oauth-callback
            }
        });
    }

    boolean launchFileAndCameraChooser(
            ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params) {
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(null);
            pendingFiles = null;
        }
        cleanupPendingCameraTempFileIfEmpty();
        pendingFiles = callback;

        String[] rawAcceptTypes = params != null ? params.getAcceptTypes() : null;
        boolean multiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        boolean captureRequested = params != null && params.isCaptureEnabled();
        List<String> validTypes = TrustedNavigation.normalizeAcceptMimeTypes(rawAcceptTypes);
        boolean acceptsImageCapture = TrustedNavigation.acceptsImages(validTypes);

        if (acceptsImageCapture
                && captureRequested
                && checkSelfPermission(Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED) {
            pendingCameraChooserParams = params;
            awaitingSystemPermission = true;
            requestPermissions(
                    new String[]{Manifest.permission.CAMERA},
                    CAMERA_CHOOSER_PERMISSION_CODE);
            return true;
        }

        return openChooserNow(validTypes, multiple, acceptsImageCapture, captureRequested);
    }

    private boolean openChooserNow(
            List<String> validTypes,
            boolean multiple,
            boolean acceptsImageCapture,
            boolean preferCameraFirst) {
        Intent documentIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        documentIntent.addCategory(Intent.CATEGORY_OPENABLE);
        documentIntent.setType(TrustedNavigation.resolveIntentBaseMimeType(validTypes));
        if (validTypes.size() > 1) {
            documentIntent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes.toArray(new String[0]));
        }
        documentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        documentIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        Intent cameraIntent = null;
        if (acceptsImageCapture && canLaunchCameraCapture()) {
            cameraIntent = prepareCameraCaptureIntent();
        }

        Intent chooser;
        if (cameraIntent != null && preferCameraFirst) {
            chooser = Intent.createChooser(cameraIntent, getString(R.string.file_chooser_title));
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{documentIntent});
        } else {
            chooser = Intent.createChooser(documentIntent, getString(R.string.file_chooser_title));
            if (cameraIntent != null) {
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
            }
        }

        try {
            startActivityForResult(chooser, FILE_CHOOSER_CODE);
            return true;
        } catch (ActivityNotFoundException ex) {
            cleanupPendingCameraTempFileIfEmpty();
            ValueCallback<Uri[]> cb = pendingFiles;
            pendingFiles = null;
            if (cb != null) cb.onReceiveValue(null);
            return true;
        }
    }

    private boolean canLaunchCameraCapture() {
        PackageManager pm = getPackageManager();
        boolean hasCameraFeature = pm != null
                && pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
        boolean hasCameraPermission = checkSelfPermission(Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
        return hasCameraFeature && hasCameraPermission;
    }

    Intent prepareCameraCaptureIntent() {
        try {
            File dir = new File(getCacheDir(), "camera_captures");
            if (!dir.exists() && !dir.mkdirs()) {
                return null;
            }
            cleanupStaleCameraCaptures(false);
            File photoFile = File.createTempFile("viread_scan_", ".jpg", dir);
            Uri photoUri = buildCameraCaptureUri(this, photoFile);
            pendingCameraCaptureFile = photoFile;
            pendingCameraCaptureUri = photoUri;

            Intent captureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            captureIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            captureIntent.addFlags(
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            captureIntent.setClipData(ClipData.newRawUri("viread_camera_capture", photoUri));
            return captureIntent;
        } catch (IOException | IllegalArgumentException ex) {
            pendingCameraCaptureFile = null;
            pendingCameraCaptureUri = null;
            return null;
        }
    }

    static Uri buildCameraCaptureUri(Context context, File photoFile) throws IOException {
        String authority = context.getPackageName() + ".fileprovider";
        try {
            return FileProvider.getUriForFile(context, authority, photoFile);
        } catch (IllegalArgumentException ex) {
            // Work around androidx FileProvider SimplePathStrategy hardcoding '/' on Windows JVM tests
            if (File.separatorChar != '\\') {
                throw ex;
            }
            File allowedRoot = new File(context.getCacheDir(), "camera_captures").getCanonicalFile();
            File canonicalFile = photoFile.getCanonicalFile();
            String rootPrefix = allowedRoot.getPath() + File.separator;
            if (!canonicalFile.getPath().startsWith(rootPrefix)) {
                throw ex;
            }
            return new Uri.Builder()
                    .scheme("content")
                    .authority(authority)
                    .appendPath("camera_captures")
                    .appendPath(canonicalFile.getName())
                    .build();
        }
    }

    private void cleanupPendingCameraTempFileIfEmpty() {
        if (pendingCameraCaptureFile != null
                && pendingCameraCaptureFile.exists()
                && pendingCameraCaptureFile.length() == 0L) {
            // Safe delete of unused placeholder capture file
            //noinspection ResultOfMethodCallIgnored
            pendingCameraCaptureFile.delete();
        }
        pendingCameraCaptureFile = null;
        pendingCameraCaptureUri = null;
    }

    private void cleanupStaleCameraCaptures(boolean deleteAll) {
        File dir = new File(getCacheDir(), "camera_captures");
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - 30 * 60 * 1000L;
        for (File f : files) {
            if (deleteAll || f.lastModified() < cutoff || f.length() == 0L) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    private void requestWebPermission(PermissionRequest request) {
        String origin = request.getOrigin() != null ? request.getOrigin().toString() : null;
        if (isFinishing() || !navigation.isTrustedMediaOrigin(origin)) {
            request.deny();
            return;
        }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        List<String> needed = new ArrayList<>();
        String[] resources = request.getResources();
        if (resources == null || resources.length == 0) {
            denyPending();
            return;
        }
        for (String resource : resources) {
            final String permission;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                permission = Manifest.permission.RECORD_AUDIO;
            } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                permission = Manifest.permission.CAMERA;
            } else {
                denyPending();
                return;
            }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED
                    && !needed.contains(permission)) {
                needed.add(permission);
            }
        }
        if (needed.isEmpty()) {
            grantPending();
        } else {
            awaitingSystemPermission = true;
            requestPermissions(needed.toArray(new String[0]), WEB_PERMISSION_CODE);
        }
    }

    private void grantPending() {
        awaitingSystemPermission = false;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        String origin = request != null && request.getOrigin() != null
                ? request.getOrigin().toString()
                : null;
        if (request != null && navigation.isTrustedMediaOrigin(origin)) {
            request.grant(request.getResources());
        } else if (request != null) {
            request.deny();
        }
    }

    private void denyPending() {
        awaitingSystemPermission = false;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (request != null) request.deny();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == CAMERA_CHOOSER_PERMISSION_CODE) {
            awaitingSystemPermission = false;
            WebChromeClient.FileChooserParams params = pendingCameraChooserParams;
            pendingCameraChooserParams = null;
            List<String> validTypes = TrustedNavigation.normalizeAcceptMimeTypes(
                    params != null ? params.getAcceptTypes() : null);
            boolean multiple = params != null
                    && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
            boolean granted = results != null
                    && results.length > 0
                    && results[0] == PackageManager.PERMISSION_GRANTED;
            openChooserNow(validTypes, multiple, true, granted);
            return;
        }

        if (code != WEB_PERMISSION_CODE) return;
        awaitingSystemPermission = false;
        boolean granted = results != null && results.length > 0;
        if (results != null) {
            for (int result : results) {
                granted &= result == PackageManager.PERMISSION_GRANTED;
            }
        }
        if (granted) {
            grantPending();
        } else {
            denyPending();
            boolean permanentlyDenied = false;
            if (permissions != null) {
                for (String perm : permissions) {
                    if (perm != null && !shouldShowRequestPermissionRationale(perm)) {
                        permanentlyDenied = true;
                        break;
                    }
                }
            }
            if (permanentlyDenied && !isFinishing()) {
                showPermissionSettingsDialog();
            }
        }
    }

    private void showPermissionSettingsDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.permission_denied_title)
                .setMessage(R.string.permission_denied_message)
                .setPositiveButton(R.string.open_app_settings_button, (dialog, which) -> {
                    Intent settingsIntent = new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", getPackageName(), null));
                    settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(settingsIntent);
                    } catch (ActivityNotFoundException ignored) {
                        // Ignore on restricted OEM shells
                    }
                })
                .setNegativeButton(R.string.lan_dialog_cancel, null)
                .show();
    }

    static Uri[] extractSelectedUris(
            int resultCode,
            Intent data,
            Uri cameraCaptureUri,
            File cameraCaptureFile) {
        if (resultCode != RESULT_OK) {
            return null;
        }
        if (data != null) {
            ClipData clipData = data.getClipData();
            if (clipData != null && clipData.getItemCount() > 0) {
                List<Uri> uris = new ArrayList<>(clipData.getItemCount());
                for (int i = 0; i < clipData.getItemCount(); i++) {
                    Uri itemUri = clipData.getItemAt(i).getUri();
                    if (itemUri != null) uris.add(itemUri);
                }
                if (!uris.isEmpty()) {
                    return uris.toArray(new Uri[0]);
                }
            }
            if (data.getData() != null) {
                return new Uri[]{data.getData()};
            }
            Uri[] parsed = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            if (parsed != null && parsed.length > 0) {
                return parsed;
            }
        }
        if (cameraCaptureUri != null
                && cameraCaptureFile != null
                && cameraCaptureFile.exists()
                && cameraCaptureFile.length() > 0L) {
            return new Uri[]{cameraCaptureUri};
        }
        return null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_CHOOSER_CODE || pendingFiles == null) return;
        ValueCallback<Uri[]> callback = pendingFiles;
        pendingFiles = null;

        Uri[] selected = extractSelectedUris(
                result, data, pendingCameraCaptureUri, pendingCameraCaptureFile);
        boolean usedCameraFile = selected != null
                && selected.length == 1
                && pendingCameraCaptureUri != null
                && pendingCameraCaptureUri.equals(selected[0]);
        if (!usedCameraFile && pendingCameraCaptureFile != null) {
            //noinspection ResultOfMethodCallIgnored
            pendingCameraCaptureFile.delete();
        }
        pendingCameraCaptureFile = null;
        pendingCameraCaptureUri = null;
        callback.onReceiveValue(selected);
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            // Flush session/PKCE cookies immediately, while keeping WebView JS timers active
            // if a translucent OEM overlay (e.g. Honor Keychain / Google Autofill dialog)
            // appears above the still-visible Activity. Full media release + webView.onPause()
            // happens in onStop() when ViRead actually leaves the visible screen.
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (webView != null && !awaitingSystemPermission && pendingFiles == null) {
            webView.evaluateJavascript(
                    "document.dispatchEvent(new Event('viread:android-background'))", null);
            webView.onPause();
        }
        if (!awaitingSystemPermission) {
            denyPending();
        }
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        if (webView != null) webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    private void registerModernBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = this::handleBackNavigation;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backInvokedCallback);
        }
    }

    boolean handleBackNavigation() {
        if (errorOverlay != null
                && errorOverlay.getVisibility() == View.VISIBLE
                && hasLoadedCleanPage) {
            mainFrameHasError = false;
            errorOverlay.setVisibility(View.GONE);
            if (webView != null) webView.setVisibility(View.VISIBLE);
            return true;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressMs < BACK_EXIT_WINDOW_MS) {
            finish();
            return true;
        }
        lastBackPressMs = now;
        Toast.makeText(this, R.string.back_exit_confirm_toast, Toast.LENGTH_SHORT).show();
        return true;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBackNavigation();
    }

    @Override
    protected void onDestroy() {
        cancelLoadWatchdog();
        oauthLoopbackServer.stop();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
            backInvokedCallback = null;
        }
        denyPending();
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(null);
            pendingFiles = null;
        }
        cleanupStaleCameraCaptures(true);
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // Package-private inspection helpers for JVM/Robolectric unit tests
    WebView getWebViewForTest() {
        return webView;
    }

    View getStartupOverlayForTest() {
        return startupOverlay;
    }

    View getErrorOverlayForTest() {
        return errorOverlay;
    }

    TextView getErrorTitleViewForTest() {
        return errorTitleView;
    }

    TextView getErrorMessageViewForTest() {
        return errorMessageView;
    }

    Button getRetryButtonForTest() {
        return retryButton;
    }

    Button getHomeButtonForTest() {
        return homeButton;
    }

    Button getCheckConnectionButtonForTest() {
        return checkConnectionButton;
    }

    Button getConfigureLanButtonForTest() {
        return configureLanButton;
    }

    boolean isAwaitingSystemPermissionForTest() {
        return awaitingSystemPermission;
    }

    boolean hasPendingFilesForTest() {
        return pendingFiles != null;
    }
}
