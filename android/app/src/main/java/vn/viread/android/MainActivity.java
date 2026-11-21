package vn.viread.android;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/**
 * Server-backed Android shell, not a static copy of the Next.js application.
 * No JS bridge, no service secrets, no permission grants to untrusted origins,
 * and never bypasses TLS/SSL certificate verification.
 */
public final class MainActivity extends Activity {
    private static final int WEB_PERMISSION_CODE = 151;
    private static final int FILE_CHOOSER_CODE = 152;
    private WebView webView;
    private ProgressBar progress;
    private LinearLayout errorOverlay;
    private TextView errorMessageView;
    private TrustedNavigation navigation;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> pendingFiles;
    private String lastFailedUrl;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        navigation = new TrustedNavigation(
                BuildConfig.FRONTEND_URL, BuildConfig.LAN_ACCEPTANCE_MODE);
        getWindow().setStatusBarColor(0xFF153A53);
        getWindow().setNavigationBarColor(0xFF153A53);

        FrameLayout content = new FrameLayout(this);
        webView = new WebView(this);
        content.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        errorOverlay = buildErrorOverlay();
        errorOverlay.setVisibility(View.GONE);
        content.addView(errorOverlay, new FrameLayout.LayoutParams(-1, -1));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        content.addView(progress, new FrameLayout.LayoutParams(-1, 6));
        setContentView(content);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Android document/photo picker content://
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Main-frame navigations only. Embedded frames keep browser security checks.
                if (!request.isForMainFrame()) return false;
                return handleNavigation(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // Never disable TLS verification.
                lastFailedUrl = error != null ? error.getUrl() : BuildConfig.FRONTEND_URL;
                showErrorOverlay(getString(R.string.tls_error_message));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    lastFailedUrl = request.getUrl() != null
                            ? request.getUrl().toString()
                            : BuildConfig.FRONTEND_URL;
                    showErrorOverlay(getString(R.string.offline_message));
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                if (url != null && !"about:blank".equals(url)) {
                    errorOverlay.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE);
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
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] types = params.getAcceptTypes();
                List<String> validTypes = new ArrayList<>();
                for (String type : types) {
                    if (type != null && !type.trim().isEmpty() && type.contains("/")) {
                        validTypes.add(type.trim());
                    }
                }
                if (validTypes.size() == 1) intent.setType(validTypes.get(0));
                else if (!validTypes.isEmpty()) {
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes.toArray(new String[0]));
                }
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "Chọn ảnh hoặc tài liệu"),
                            FILE_CHOOSER_CODE);
                } catch (ActivityNotFoundException ex) {
                    pendingFiles = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });
        if (state != null) {
            webView.restoreState(state);
        } else {
            webView.loadUrl(BuildConfig.FRONTEND_URL);
        }
    }

    private LinearLayout buildErrorOverlay() {
        int pad = dp(28);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(0xFFF6FAF8);
        layout.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(0xFF153A53);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setGravity(Gravity.CENTER);
        layout.addView(title);

        errorMessageView = new TextView(this);
        errorMessageView.setText(R.string.offline_message);
        errorMessageView.setTextColor(0xFF334E58);
        errorMessageView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        errorMessageView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msgParams = new LinearLayout.LayoutParams(-1, -2);
        msgParams.topMargin = dp(12);
        msgParams.bottomMargin = dp(24);
        layout.addView(errorMessageView, msgParams);

        Button retryBtn = new Button(this);
        retryBtn.setText(R.string.retry_button);
        retryBtn.setMinHeight(dp(48));
        retryBtn.setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            if (webView != null) {
                String target = (lastFailedUrl != null && navigation.isTrusted(lastFailedUrl))
                        ? lastFailedUrl
                        : BuildConfig.FRONTEND_URL;
                webView.loadUrl(target);
            }
        });
        layout.addView(retryBtn, new LinearLayout.LayoutParams(-1, -2));

        Button homeBtn = new Button(this);
        homeBtn.setText(R.string.open_home_button);
        homeBtn.setMinHeight(dp(48));
        homeBtn.setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            if (webView != null) {
                webView.loadUrl(BuildConfig.FRONTEND_URL);
            }
        });
        LinearLayout.LayoutParams homeParams = new LinearLayout.LayoutParams(-1, -2);
        homeParams.topMargin = dp(12);
        layout.addView(homeBtn, homeParams);

        return layout;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void showErrorOverlay(String message) {
        runOnUiThread(() -> {
            if (errorMessageView != null) errorMessageView.setText(message);
            if (errorOverlay != null) errorOverlay.setVisibility(View.VISIBLE);
            if (progress != null) progress.setVisibility(View.GONE);
        });
    }

    private boolean handleNavigation(Uri uri) {
        String url = uri.toString();
        if (navigation.isTrusted(url)) return false;
        if (navigation.shouldOpenExternally(url)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, "Không tìm thấy ứng dụng để mở liên kết.", Toast.LENGTH_SHORT).show();
            }
        }
        return true; // Block HTTP, file:, intent:, javascript: and untrusted navigation.
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
        if (resources.length == 0) {
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
                return; // No protected-media or unknown WebView grants.
            }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED
                    && !needed.contains(permission)) needed.add(permission);
        }
        if (needed.isEmpty()) {
            grantPending();
        } else {
            requestPermissions(needed.toArray(new String[0]), WEB_PERMISSION_CODE);
        }
    }

    private void grantPending() {
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
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (request != null) request.deny();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != WEB_PERMISSION_CODE) return;
        boolean granted = results.length > 0;
        for (int result : results) granted &= result == PackageManager.PERMISSION_GRANTED;
        if (granted) grantPending();
        else denyPending();
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_CHOOSER_CODE || pendingFiles == null) return;
        ValueCallback<Uri[]> callback = pendingFiles;
        pendingFiles = null;
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            // Frontend hooks listen for this event and release camera/recording tracks.
            webView.evaluateJavascript("document.dispatchEvent(new Event('viread:android-background'))", null);
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        denyPending();
        super.onPause();
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

    @Override
    public void onBackPressed() {
        if (errorOverlay != null && errorOverlay.getVisibility() == View.VISIBLE) {
            errorOverlay.setVisibility(View.GONE);
            return;
        }
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        denyPending();
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(null);
            pendingFiles = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
