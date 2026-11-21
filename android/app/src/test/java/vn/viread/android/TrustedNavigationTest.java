package vn.viread.android;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public final class TrustedNavigationTest {
    @Test public void permitsExactHttpsOriginAndRoute() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertTrue(policy.isTrusted("https://viread.example.com/dashboard"));
        assertTrue(policy.isTrusted("https://VIREAD.example.com:443/reading/abc"));
        assertTrue(policy.isTrusted("https://viread.example.com/auth/callback?code=abc"));
        assertTrue(policy.isTrustedMediaOrigin("https://viread.example.com"));
        assertFalse(policy.shouldOpenExternally("https://viread.example.com/dashboard"));
    }

    @Test public void deniesForeignOriginsLookalikeHostsAndDowngrades() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrusted("http://viread.example.com/login"));
        assertFalse(policy.isTrusted("https://viread.example.com.evil.test/login"));
        assertFalse(policy.isTrusted("https://evilviread.example.com/login"));
        assertFalse(policy.isTrusted("https://evil.test@viread.example.com/login"));
        assertFalse(policy.isTrusted("https://viread.example.com:444/login"));
        assertFalse(policy.isTrusted("javascript:alert(1)"));
        assertFalse(policy.isTrusted("file:///android_asset/index.html"));
        assertFalse(policy.isTrusted("intent://scan/#Intent;scheme=https;end"));
    }

    @Test public void deniesMediaPermissionsFromForeignOrDowngradedOrigins() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrustedMediaOrigin("http://viread.example.com"));
        assertFalse(policy.isTrustedMediaOrigin("https://viread.example.com:8443"));
        assertFalse(policy.isTrustedMediaOrigin("https://other.example.com"));
        assertFalse(policy.isTrustedMediaOrigin("https://viread.example.com.attacker.test"));
    }

    @Test public void routesSafeExternalLinksAndBlocksUnsafeSchemes() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertTrue(policy.shouldOpenExternally("https://supabase.com/docs"));
        assertTrue(policy.shouldOpenExternally("mailto:support@viread.vn"));
        assertTrue(policy.shouldOpenExternally("tel:+84901234567"));
        assertFalse(policy.shouldOpenExternally("http://insecure.example.com"));
        assertFalse(policy.shouldOpenExternally("javascript:alert(1)"));
        assertFalse(policy.shouldOpenExternally("file:///etc/hosts"));
        assertFalse(policy.shouldOpenExternally("intent://evil"));
    }

    @Test public void lanAcceptanceModePermitsExactLanOriginAndRejectsMismatchedPortsOrHosts() {
        TrustedNavigation lanPolicy = new TrustedNavigation("https://192.168.1.4:8443", true);
        assertTrue(lanPolicy.isAllowCustomPort());
        assertTrue(lanPolicy.isTrusted("https://192.168.1.4:8443/login"));
        assertTrue(lanPolicy.isTrusted("https://192.168.1.4:8443/book-scanner"));
        assertTrue(lanPolicy.isTrustedMediaOrigin("https://192.168.1.4:8443"));

        // Rejects HTTP downgrade, different port, different LAN IP, lookalike host, credentials
        assertFalse(lanPolicy.isTrusted("http://192.168.1.4:8443/login"));
        assertFalse(lanPolicy.isTrusted("https://192.168.1.4:8444/login"));
        assertFalse(lanPolicy.isTrusted("https://192.168.1.4/login"));
        assertFalse(lanPolicy.isTrusted("https://192.168.1.40:8443/login"));
        assertFalse(lanPolicy.isTrusted("https://192.168.1.4.evil.test:8443/login"));
        assertFalse(lanPolicy.isTrusted("https://user@192.168.1.4:8443/login"));
        assertFalse(lanPolicy.isTrustedMediaOrigin("https://192.168.1.5:8443"));
        assertTrue(lanPolicy.shouldOpenExternally("https://trancuong3.github.io/capstone1/"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void productionModeRejectsLanCustomPortAndIp() {
        new TrustedNavigation("https://192.168.1.4:8443");
    }

    @Test(expected = IllegalArgumentException.class)
    public void lanModeStillRejectsLoopbackHost() {
        new TrustedNavigation("https://127.0.0.1:8443", true);
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsNonHttpsStartupUrl() {
        new TrustedNavigation("http://localhost:3000");
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsRedirectStartupUrl() {
        new TrustedNavigation("https://viread.example.com/reading");
    }

    @Test public void nullAndBrokenCandidatesDoNotCrash() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrusted(null));
        assertFalse(policy.isTrusted("https://["));
        assertFalse(policy.shouldOpenExternally(null));
    }

    @Test public void sslCertificateErrorsAreNeverBypassedInAnyMode() {
        TrustedNavigation prodPolicy = new TrustedNavigation("https://viread.example.com");
        TrustedNavigation lanPolicy = new TrustedNavigation("https://192.168.1.4:8443", true);
        assertFalse(prodPolicy.shouldProceedOnSslError());
        assertFalse(lanPolicy.shouldProceedOnSslError());
    }

    @Test public void normalizesCommaJoinedWebViewFileChooserAcceptMimeTypes() {
        List<String> parsed = TrustedNavigation.normalizeAcceptMimeTypes(
                new String[]{"image/jpeg, image/png, image/webp", ".jpg", "bad token", null});
        assertEquals(Arrays.asList("image/jpeg", "image/png", "image/webp"), parsed);
        assertEquals("image/*", TrustedNavigation.resolveIntentBaseMimeType(parsed));

        List<String> single = TrustedNavigation.normalizeAcceptMimeTypes(new String[]{"image/png"});
        assertEquals(Arrays.asList("image/png"), single);
        assertEquals("image/png", TrustedNavigation.resolveIntentBaseMimeType(single));

        List<String> mixed = TrustedNavigation.normalizeAcceptMimeTypes(
                new String[]{"image/jpeg", "application/pdf"});
        assertEquals("*/*", TrustedNavigation.resolveIntentBaseMimeType(mixed));
        assertEquals("*/*", TrustedNavigation.resolveIntentBaseMimeType(
                TrustedNavigation.normalizeAcceptMimeTypes(null)));
    }
}
