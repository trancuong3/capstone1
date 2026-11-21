package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class ErrorAndOfflineRecoveryTest {

    private static WebResourceRequest resourceRequest(final String url, final boolean mainFrame) {
        return new WebResourceRequest() {
            @Override
            public Uri getUrl() {
                return Uri.parse(url);
            }

            @Override
            public boolean isForMainFrame() {
                return mainFrame;
            }

            @Override
            public boolean isRedirect() {
                return false;
            }

            @Override
            public boolean hasGesture() {
                return false;
            }

            @Override
            public String getMethod() {
                return "GET";
            }

            @Override
            public Map<String, String> getRequestHeaders() {
                return Collections.emptyMap();
            }
        };
    }

    @Test
    public void connectionAbortedHidesWebViewAndSuppressesRawChromiumErrorPage() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView webView = activity.getWebViewForTest();
        WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();
        assertNotNull(client);

        // Before first page finishes, branded startup overlay covers the invisible WebView
        assertEquals(View.VISIBLE, activity.getStartupOverlayForTest().getVisibility());
        assertEquals(View.INVISIBLE, webView.getVisibility());

        String origin = new ServerEndpointStore(activity).getActiveOrigin();
        activity.handleMainFrameResourceError(
                resourceRequest(origin + "/", true),
                WebViewClient.ERROR_CONNECT,
                "net::ERR_CONNECTION_ABORTED");

        // Simulate Chromium internally attempting to finish chrome-error://chromewebdata/
        client.onPageStarted(webView, "chrome-error://chromewebdata/", null);
        client.onPageFinished(webView, "chrome-error://chromewebdata/");

        assertEquals(
                "WebView MUST stay INVISIBLE so raw Chromium error HTML is never exposed",
                View.INVISIBLE,
                webView.getVisibility());
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
        assertEquals(View.GONE, activity.getStartupOverlayForTest().getVisibility());
        assertTrue(activity.getErrorTitleViewForTest().getText().toString().contains("ViRead"));
        assertTrue(activity.getErrorMessageViewForTest().getText().toString().contains("Thử lại"));

        // Subresource errors on an active page must NOT hide WebView
        activity.getRetryButtonForTest().performClick();
        assertEquals(View.GONE, activity.getErrorOverlayForTest().getVisibility());
        assertEquals(View.INVISIBLE, webView.getVisibility());

        client.onPageStarted(webView, origin + "/login", null);
        client.onPageFinished(webView, origin + "/login");
        assertEquals(View.VISIBLE, webView.getVisibility());
        assertEquals(View.GONE, activity.getErrorOverlayForTest().getVisibility());

        activity.handleMainFrameResourceError(
                resourceRequest(origin + "/favicon.ico", false),
                WebViewClient.ERROR_FILE_NOT_FOUND,
                "net::ERR_FAILED");
        assertEquals(View.VISIBLE, webView.getVisibility());
        assertEquals(View.GONE, activity.getErrorOverlayForTest().getVisibility());
    }

    @Test
    public void dnsTimeoutAndHttp5xxShowFriendlyVietnameseDiagnosticsAndHomeRecovery() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView webView = activity.getWebViewForTest();
        WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();
        String origin = new ServerEndpointStore(activity).getActiveOrigin();

        // DNS failure via WebViewClient.onReceivedError
        client.onReceivedError(webView, resourceRequest(origin + "/", true), null);
        assertEquals(View.INVISIBLE, webView.getVisibility());
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());

        // Timeout
        activity.handleMainFrameResourceError(
                resourceRequest(origin + "/dashboard", true),
                WebViewClient.ERROR_TIMEOUT,
                "net::ERR_TIMED_OUT");
        assertEquals(View.INVISIBLE, webView.getVisibility());
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
        assertTrue(activity.getErrorMessageViewForTest().getText().toString().contains("chậm"));

        // HTTP 500/502/503 cold-start / maintenance
        for (int status : new int[]{500, 502, 503}) {
            WebResourceResponse resp = new WebResourceResponse(
                    "text/html",
                    "utf-8",
                    status,
                    "Server Error",
                    Collections.emptyMap(),
                    new ByteArrayInputStream("upstream error".getBytes(StandardCharsets.UTF_8)));
            client.onReceivedHttpError(webView, resourceRequest(origin + "/books", true), resp);
            assertEquals(View.INVISIBLE, webView.getVisibility());
            assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
            assertTrue(activity.getErrorMessageViewForTest().getText().toString()
                    .contains(String.valueOf(status)));
        }

        // Open Home button navigates cleanly to /login
        activity.getHomeButtonForTest().performClick();
        assertEquals(origin + "/login", Shadows.shadowOf(webView).getLastLoadedUrl());
    }

    @Test
    public void sslErrorsAlwaysCancelAndShowSecurityCard() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView webView = activity.getWebViewForTest();
        WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();
        String origin = new ServerEndpointStore(activity).getActiveOrigin();

        // 1. Direct verification of cancel callback
        AtomicBoolean canceled = new AtomicBoolean(false);
        activity.handleSslError(() -> canceled.set(true), origin + "/login");
        assertTrue("SSL error handler MUST invoke cancel()", canceled.get());
        assertEquals(View.INVISIBLE, webView.getVisibility());
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
        assertTrue(activity.getErrorMessageViewForTest().getText().toString().contains("HTTPS"));

        // 2. Full WebViewClient.onReceivedSslError invocation with real SDK SslErrorHandler
        Constructor<SslErrorHandler> ctor = SslErrorHandler.class.getDeclaredConstructor();
        ctor.setAccessible(true);
        SslErrorHandler sdkHandler = ctor.newInstance();
        SslError sslError = new SslError(
                SslError.SSL_UNTRUSTED,
                new SslCertificate("CN=untrusted", "CN=untrusted", "", ""),
                origin + "/login");
        client.onReceivedSslError(webView, sdkHandler, sslError);
        assertEquals(View.INVISIBLE, webView.getVisibility());
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
    }
}
