package vn.viread.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Application;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.core.app.ApplicationProvider;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowToast;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class LifecyclePermissionAndBackNavTest {

    private static PermissionRequest fakePermissionRequest(
            final String origin,
            final String[] resources,
            final AtomicReference<String[]> grantedOut,
            final AtomicBoolean deniedOut) {
        return new PermissionRequest() {
            @Override
            public Uri getOrigin() {
                return origin != null ? Uri.parse(origin) : null;
            }

            @Override
            public String[] getResources() {
                return resources;
            }

            @Override
            public void grant(String[] grantedResources) {
                grantedOut.set(grantedResources);
            }

            @Override
            public void deny() {
                deniedOut.set(true);
            }
        };
    }

    @Test
    public void webPermissionDeniesForeignOriginAndPreservesPendingGrantAcrossDialogPause() {
        Application app = ApplicationProvider.getApplicationContext();
        ShadowApplication shadowApp = Shadows.shadowOf(app);
        shadowApp.denyPermissions(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO);

        ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        WebChromeClient chrome = Shadows.shadowOf(activity.getWebViewForTest()).getWebChromeClient();
        String trustedOrigin = new ServerEndpointStore(activity).getActiveOrigin();

        // 1. Foreign origin MUST be immediately denied
        AtomicReference<String[]> foreignGranted = new AtomicReference<>();
        AtomicBoolean foreignDenied = new AtomicBoolean(false);
        chrome.onPermissionRequest(fakePermissionRequest(
                "https://attacker.example",
                new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE},
                foreignGranted,
                foreignDenied));
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(foreignDenied.get());

        // 2. Trusted origin triggers runtime permission prompt; transient onPause() MUST NOT cancel it
        AtomicReference<String[]> grantedResources = new AtomicReference<>();
        AtomicBoolean trustedDenied = new AtomicBoolean(false);
        chrome.onPermissionRequest(fakePermissionRequest(
                trustedOrigin,
                new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE},
                grantedResources,
                trustedDenied));
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(activity.isAwaitingSystemPermissionForTest());

        controller.pause();
        assertFalse(
                "System permission dialog pause must NOT prematurely deny WebRTC PermissionRequest",
                trustedDenied.get());

        shadowApp.grantPermissions(Manifest.permission.CAMERA);
        activity.onRequestPermissionsResult(
                MainActivity.WEB_PERMISSION_CODE,
                new String[]{Manifest.permission.CAMERA},
                new int[]{PackageManager.PERMISSION_GRANTED});
        controller.resume();
        assertArrayEquals(
                new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE},
                grantedResources.get());
    }

    @Test
    public void permanentPermissionDenialShowsSettingsGuidanceAndRealBackgroundReleasesMedia() {
        ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        WebChromeClient chrome = Shadows.shadowOf(activity.getWebViewForTest()).getWebChromeClient();
        String trustedOrigin = new ServerEndpointStore(activity).getActiveOrigin();

        AtomicReference<String[]> granted = new AtomicReference<>();
        AtomicBoolean denied = new AtomicBoolean(false);
        chrome.onPermissionRequest(fakePermissionRequest(
                trustedOrigin,
                new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE},
                granted,
                denied));
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        activity.onRequestPermissionsResult(
                MainActivity.WEB_PERMISSION_CODE,
                new String[]{Manifest.permission.RECORD_AUDIO},
                new int[]{PackageManager.PERMISSION_DENIED});
        assertTrue(denied.get());
        AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
        assertNotNull("Permanently denied permission should offer Settings dialog", dialog);
        assertTrue(dialog.isShowing());
        dialog.dismiss();

        // Real backgrounding (no permission/file picker active) unregisters noisy receiver and defers WebView pause
        assertTrue(activity.isNoisyReceiverRegisteredForTest());
        controller.pause().stop();
        assertFalse(activity.isNoisyReceiverRegisteredForTest());
        assertFalse(activity.isAwaitingSystemPermissionForTest());
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(
                java.time.Duration.ofMillis(300));
        assertTrue(activity.isWebViewPausedForStopForTest());
    }

    @Test
    public void backNavigationDismissesOverlayNavigatesHistoryAndConfirmsRootExit() {
        ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        WebView webView = activity.getWebViewForTest();
        WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();
        String origin = new ServerEndpointStore(activity).getActiveOrigin();

        // Finish clean initial load
        client.onPageStarted(webView, origin + "/dashboard", null);
        client.onPageFinished(webView, origin + "/dashboard");
        assertEquals(View.VISIBLE, webView.getVisibility());

        // Trigger transient error after clean load -> first Back dismisses overlay
        activity.onMainFrameFailure(origin + "/books", "Lỗi", "Thử lại", "ERR");
        assertEquals(View.VISIBLE, activity.getErrorOverlayForTest().getVisibility());
        activity.handleBackNavigation();
        assertEquals(View.GONE, activity.getErrorOverlayForTest().getVisibility());
        assertEquals(View.VISIBLE, webView.getVisibility());

        // State save does not crash across rotation
        Bundle saved = new Bundle();
        controller.saveInstanceState(saved);
        assertNotNull(saved);

        // Root back requires double-press confirmation
        activity.handleBackNavigation();
        assertFalse("Single back press at root must show confirmation toast, not exit", activity.isFinishing());
        assertEquals("Bấm lần nữa để thoát ViRead", ShadowToast.getTextOfLatestToast());

        activity.handleBackNavigation();
        assertTrue("Second back press within 2s exits cleanly", activity.isFinishing());
    }
}
