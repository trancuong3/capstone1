package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.res.Configuration;
import android.os.LocaleList;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.core.app.ApplicationProvider;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.shadows.ShadowWebView;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class LocalePersistenceAndResourcesTest {

    private static final List<String> ALL_30_LOCALE_TAGS = Arrays.asList(
            "vi",
            "en",
            "zh-Hans",
            "zh-Hant",
            "ja",
            "ko",
            "fr",
            "de",
            "es",
            "pt",
            "it",
            "ru",
            "th",
            "id",
            "ms",
            "fil",
            "hi",
            "bn",
            "ar",
            "tr",
            "nl",
            "sv",
            "pl",
            "uk",
            "el",
            "he",
            "km",
            "lo",
            "my",
            "ne");

    private static final int[] ALL_STRING_IDS = new int[] {
        R.string.app_name,
        R.string.loading_title,
        R.string.loading_subtitle,
        R.string.loading_hint_stage2,
        R.string.loading_hint_stage3,
        R.string.loading_cold_start_hint,
        R.string.error_title_network,
        R.string.error_title_server,
        R.string.error_title_timeout,
        R.string.error_title_tls,
        R.string.offline_message,
        R.string.timeout_message,
        R.string.server_5xx_message,
        R.string.tls_error_message,
        R.string.no_network_toast,
        R.string.network_ready_toast,
        R.string.retry_button,
        R.string.open_home_button,
        R.string.check_connection_button,
        R.string.configure_lan_server_button,
        R.string.lan_dialog_title,
        R.string.lan_dialog_hint,
        R.string.lan_dialog_save,
        R.string.lan_dialog_reset,
        R.string.lan_dialog_cancel,
        R.string.lan_invalid_url_toast,
        R.string.file_chooser_title,
        R.string.permission_denied_title,
        R.string.permission_denied_message,
        R.string.open_app_settings_button,
        R.string.back_exit_confirm_toast,
    };

    @Before
    public void resetLocaleState() {
        Context app = ApplicationProvider.getApplicationContext();
        app.getSharedPreferences(MainActivity.LOCALE_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        CookieManager.getInstance().removeAllCookies(null);
    }

    private static Context localizedContext(Context base, String languageTag) {
        Locale locale = Locale.forLanguageTag(languageTag);
        Configuration config = new Configuration(base.getResources().getConfiguration());
        config.setLocales(new LocaleList(locale));
        return base.createConfigurationContext(config);
    }

    @Test
    public void all30LocaleResourceBundlesLoadCleanlyWithBrandAndPlaceholders() {
        Context base = ApplicationProvider.getApplicationContext();
        assertEquals(30, ALL_30_LOCALE_TAGS.size());

        String defaultRetry = localizedContext(base, "vi").getString(R.string.retry_button);
        assertEquals("Thử lại", defaultRetry);

        for (String tag : ALL_30_LOCALE_TAGS) {
            Context ctx = localizedContext(base, tag);
            assertEquals("app_name must stay ViRead for " + tag, "ViRead", ctx.getString(R.string.app_name));

            for (int resId : ALL_STRING_IDS) {
                String value = ctx.getString(resId);
                assertNotNull("Missing string resource for " + tag, value);
                assertFalse("Empty string resource for " + tag, value.trim().isEmpty());
            }

            String raw5xx = ctx.getString(R.string.server_5xx_message);
            assertTrue("server_5xx_message must preserve %1$d for " + tag, raw5xx.contains("%1$d"));
            Locale effectiveLocale = ctx.getResources().getConfiguration().getLocales().get(0);
            String formatted5xx = ctx.getString(R.string.server_5xx_message, 503);
            String expectedNumber = String.format(effectiveLocale, "%d", 503);
            assertTrue(
                    "server_5xx_message formatted output must include status code for " + tag,
                    formatted5xx.contains(expectedNumber));

            String lanHint = ctx.getString(R.string.lan_dialog_hint);
            assertTrue("lan_dialog_hint must preserve example URL for " + tag,
                    lanHint.contains("https://192.168.1.10:8443"));

            if (!"vi".equals(tag)) {
                assertNotEquals(
                        "Expected distinct localized retry_button bundle for " + tag,
                        defaultRetry,
                        ctx.getString(R.string.retry_button));
            }
        }
    }

    @Test
    public void localeTagValidationRejectsTraversalAndNormalizesAliases() {
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag(null));
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag(""));
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag("../etc/passwd"));
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag("en\u0000vi"));
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag("xx-YY"));
        assertEquals("vi", MainActivity.resolveSupportedLocaleTag("<script>"));
        assertEquals("zh-Hans", MainActivity.resolveSupportedLocaleTag("zh-CN"));
        assertEquals("zh-Hant", MainActivity.resolveSupportedLocaleTag("zh-TW"));
        assertEquals("id", MainActivity.resolveSupportedLocaleTag("in-ID"));
        assertEquals("he", MainActivity.resolveSupportedLocaleTag("iw"));
        assertEquals("fil", MainActivity.resolveSupportedLocaleTag("tl-PH"));
        assertEquals("ja", MainActivity.resolveSupportedLocaleTag("ja-JP"));
    }

    @Test
    @Config(sdk = 34, qualifiers = "en-rUS")
    public void englishOsDoesNotOverrideVietnameseDefaultAndPersistedVireadLocaleReplacesItOnRecreate() {
        Locale previousDefault = Locale.getDefault();
        try {
            Locale.setDefault(Locale.US);
            Context app = ApplicationProvider.getApplicationContext();
            // Confirm underlying OS simulator context really resolves English
            assertEquals("Retry", app.getString(R.string.retry_button));

            // 1. Fresh MainActivity with NO viread_locale MUST still render Vietnamese default
            try (ActivityController<MainActivity> initialController =
                    Robolectric.buildActivity(MainActivity.class).setup()) {
                MainActivity initial = initialController.get();
                assertEquals("Thử lại", initial.getString(R.string.retry_button));
                assertEquals("Thử lại", initial.getRetryButtonForTest().getText().toString());
                initial.handleBackNavigation();
                assertEquals("Bấm lần nữa để thoát ViRead", ShadowToast.getTextOfLatestToast());

                WebView webView = initial.getWebViewForTest();
                WebSettings settings = webView.getSettings();
                String origin = new ServerEndpointStore(initial).getActiveOrigin();
                assertTrue("DOM storage must stay enabled", settings.getDomStorageEnabled());
                assertTrue("JavaScript must stay enabled", settings.getJavaScriptEnabled());
                assertTrue("WebView cookies must be accepted", CookieManager.getInstance().acceptCookie());

                // User selects Japanese in WebView -> cookie written -> synced on page finish / stop
                CookieManager.getInstance().setCookie(origin, "viread_locale=ja; Path=/");
                assertEquals(origin, initial.resolveInitialStartupUrl(CookieManager.getInstance().getCookie(origin)));
                assertFalse(
                        "viread_locale cookie must never be mistaken for Supabase auth cookie",
                        MainActivity.hasSupabaseAuthCookie("viread_locale=ja"));

                WebViewClient client = Shadows.shadowOf(webView).getWebViewClient();
                client.onPageFinished(webView, origin + "/settings");
                initialController.pause().stop();
                Shadows.shadowOf(Looper.getMainLooper()).idle();

                String persistedCookie = CookieManager.getInstance().getCookie(origin);
                assertNotNull(persistedCookie);
                assertTrue(persistedCookie.contains("viread_locale=ja"));
                assertEquals(
                        "ja",
                        app.getSharedPreferences(MainActivity.LOCALE_PREFS_NAME, Context.MODE_PRIVATE)
                                .getString(MainActivity.KEY_UI_LOCALE, null));
            }

            // 2. Recreated MainActivity under German OS MUST honor persisted Japanese ("ja")
            Locale.setDefault(Locale.GERMANY);
            try (ActivityController<MainActivity> recreatedController =
                    Robolectric.buildActivity(MainActivity.class).setup()) {
                MainActivity recreated = recreatedController.get();
                assertEquals(
                        "ja",
                        recreated.getResources().getConfiguration().getLocales().get(0).getLanguage());
                assertEquals("再試行", recreated.getString(R.string.retry_button));
                assertEquals("再試行", recreated.getRetryButtonForTest().getText().toString());

                // History back works cleanly for in-page modals / sheets that push history state
                WebView webView = recreated.getWebViewForTest();
                String origin = new ServerEndpointStore(recreated).getActiveOrigin();
                ShadowWebView shadowWebView = Shadows.shadowOf(webView);
                shadowWebView.pushEntryToHistory(origin + "/dashboard");
                shadowWebView.pushEntryToHistory(origin + "/settings");
                assertTrue(webView.canGoBack());
                assertTrue(recreated.handleBackNavigation());
                assertFalse(recreated.isFinishing());
                assertEquals(1, shadowWebView.getGoBackInvocations());
                Shadows.shadowOf(Looper.getMainLooper()).idle();
            }
        } finally {
            Locale.setDefault(previousDefault);
        }
    }
}
