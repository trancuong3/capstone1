package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.net.Uri;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class OAuthLoopbackBridgeTest {

    @Test
    public void extractOAuthLoopbackNonce_acceptsValidGoogleAndFacebookSupabaseUrls() throws Exception {
        String nonce = "4f8a2b9011cc43de9811aabbccddeeff";
        String redirect = "http://127.0.0.1:3000/auth/callback?viread_nonce=" + nonce;
        String encodedRedirect = URLEncoder.encode(redirect, "UTF-8");

        String googleUrl = "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize"
                + "?provider=google&redirect_to=" + encodedRedirect + "&code_challenge=abc";
        String facebookUrl = "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize"
                + "?provider=facebook&redirect_to=" + encodedRedirect + "&scopes=email";

        assertEquals(nonce, TrustedNavigation.extractOAuthLoopbackNonce(googleUrl));
        assertEquals(nonce, TrustedNavigation.extractOAuthLoopbackNonce(facebookUrl));
    }

    @Test
    public void extractOAuthLoopbackNonce_rejectsNonOAuthWrongPortHttpOrBadNonce() throws Exception {
        String validRedirect = URLEncoder.encode(
                "http://127.0.0.1:3000/auth/callback?viread_nonce=4f8a2b9011cc43de9811aabbccddeeff",
                "UTF-8");
        assertNull(TrustedNavigation.extractOAuthLoopbackNonce(
                "http://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize?redirect_to=" + validRedirect));
        assertNull(TrustedNavigation.extractOAuthLoopbackNonce(
                "https://hgkklatgepyzbkkmwfvp.supabase.co/rest/v1/books?redirect_to=" + validRedirect));

        String wrongPort = URLEncoder.encode(
                "http://127.0.0.1:8080/auth/callback?viread_nonce=4f8a2b9011cc43de9811aabbccddeeff",
                "UTF-8");
        assertNull(TrustedNavigation.extractOAuthLoopbackNonce(
                "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize?redirect_to=" + wrongPort));

        String externalHost = URLEncoder.encode(
                "https://evil.example/auth/callback?viread_nonce=4f8a2b9011cc43de9811aabbccddeeff",
                "UTF-8");
        assertNull(TrustedNavigation.extractOAuthLoopbackNonce(
                "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize?redirect_to=" + externalHost));

        String shortNonce = URLEncoder.encode(
                "http://127.0.0.1:3000/auth/callback?viread_nonce=short",
                "UTF-8");
        assertNull(TrustedNavigation.extractOAuthLoopbackNonce(
                "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize?redirect_to=" + shortNonce));
    }

    @Test
    public void loopbackServer_ignoresFaviconRejectsSpoofedNonceAndDeliversSanitizedPkceCode() throws Exception {
        OAuthLoopbackServer server = new OAuthLoopbackServer();
        String expectedNonce = "nonce_valid_1234567890abcdef";
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> deliveredQuery = new AtomicReference<>();

        int port = server.start(0, expectedNonce, query -> {
            deliveredQuery.set(query);
            latch.countDown();
        });
        try {
            assertTrue(port > 0);
            assertTrue(server.isRunning());

            // 1. Browser /favicon.ico probe must return 204 and NOT close listener
            HttpURLConnection favConn = openNoRedirect(
                    "http://127.0.0.1:" + port + "/favicon.ico");
            assertEquals(204, favConn.getResponseCode());
            favConn.disconnect();
            assertTrue(server.isRunning());

            // 2. Spoofed or missing nonce must return 403 and NOT trigger callback
            HttpURLConnection badConn = openNoRedirect(
                    "http://127.0.0.1:" + port + "/auth/callback?viread_nonce=wrong_nonce_0000000000&code=spoofed");
            assertEquals(403, badConn.getResponseCode());
            badConn.disconnect();
            assertNull(deliveredQuery.get());
            assertTrue(server.isRunning());

            // 3. Legitimate callback with matching nonce returns 302 -> viread://oauth-callback & strips nonce
            HttpURLConnection okConn = openNoRedirect(
                    "http://127.0.0.1:" + port + "/auth/callback?viread_nonce=" + expectedNonce + "&code=pkce_code_999");
            assertEquals(302, okConn.getResponseCode());
            assertEquals("viread://oauth-callback", okConn.getHeaderField("Location"));
            okConn.disconnect();

            assertTrue(latch.await(5, TimeUnit.SECONDS));
            assertEquals("?code=pkce_code_999", deliveredQuery.get());
            assertFalse(server.isRunning());
        } finally {
            server.stop();
        }
    }

    @Test
    public void mainActivity_marksAndroidUserAgentAndLaunchesCustomTabForSocialOAuth() throws Exception {
        try (ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class).setup()) {
            MainActivity activity = controller.get();
            String ua = activity.getWebViewForTest().getSettings().getUserAgentString();
            assertNotNull(ua);
            assertTrue("WebView UA must include ViReadAndroid marker", ua.contains("ViReadAndroid/1.0"));

            String nonce = "abcdef1234567890abcdef1234567890";
            String encodedRedirect = URLEncoder.encode(
                    "http://127.0.0.1:3000/auth/callback?viread_nonce=" + nonce,
                    "UTF-8");
            Uri oauthUri = Uri.parse(
                    "https://hgkklatgepyzbkkmwfvp.supabase.co/auth/v1/authorize?provider=google&redirect_to="
                            + encodedRedirect);

            boolean intercepted = activity.handleNavigation(oauthUri);
            assertTrue(intercepted);

            Intent started = Shadows.shadowOf(activity).getNextStartedActivity();
            assertNotNull("Expected Chrome Custom Tab / VIEW intent for OAuth", started);
            assertEquals(Intent.ACTION_VIEW, started.getAction());
            assertEquals(oauthUri, started.getData());
        }
    }

    private static HttpURLConnection openNoRedirect(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(3000);
        return conn;
    }
}
