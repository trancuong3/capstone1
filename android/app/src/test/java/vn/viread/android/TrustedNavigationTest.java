package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public final class TrustedNavigationTest {
    private static final String DOCX_MIME =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    @Test
    public void permitsExactHttpsOriginAndRoute() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertEquals("https://viread.example.com", policy.getOrigin());
        assertEquals("viread.example.com", policy.getHost());
        assertEquals(443, policy.getPort());
        assertTrue(policy.isTrusted("https://viread.example.com/dashboard"));
        assertTrue(policy.isTrusted("https://VIREAD.example.com:443/reading/abc"));
        assertTrue(policy.isTrusted("https://viread.example.com/auth/callback?code=abc"));
        assertTrue(policy.isTrustedMediaOrigin("https://viread.example.com"));
        assertFalse(policy.shouldOpenExternally("https://viread.example.com/dashboard"));
    }

    @Test
    public void deniesForeignOriginsLookalikeHostsAndDowngrades() {
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

    @Test
    public void deniesMediaPermissionsFromForeignOrDowngradedOrigins() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrustedMediaOrigin("http://viread.example.com"));
        assertFalse(policy.isTrustedMediaOrigin("https://viread.example.com:8443"));
        assertFalse(policy.isTrustedMediaOrigin("https://other.example.com"));
        assertFalse(policy.isTrustedMediaOrigin("https://viread.example.com.attacker.test"));
    }

    @Test
    public void routesSafeExternalLinksAndBlocksUnsafeSchemes() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertTrue(policy.shouldOpenExternally("https://supabase.com/docs"));
        assertTrue(policy.shouldOpenExternally("mailto:support@viread.vn"));
        assertTrue(policy.shouldOpenExternally("tel:+84901234567"));
        assertFalse(policy.shouldOpenExternally("http://insecure.example.com"));
        assertFalse(policy.shouldOpenExternally("javascript:alert(1)"));
        assertFalse(policy.shouldOpenExternally("file:///etc/hosts"));
        assertFalse(policy.shouldOpenExternally("intent://evil"));
    }

    @Test
    public void lanAcceptanceModePermitsRfc1918AndRejectsMismatchedPortsOrPublicIps() {
        TrustedNavigation lanPolicy = new TrustedNavigation("https://192.168.1.4:8443", true);
        assertTrue(lanPolicy.isAllowCustomPort());
        assertEquals("https://192.168.1.4:8443", lanPolicy.getOrigin());
        assertTrue(lanPolicy.isTrusted("https://192.168.1.4:8443/login"));
        assertTrue(lanPolicy.isTrusted("https://192.168.1.4:8443/book-scanner"));
        assertTrue(lanPolicy.isTrusted("https://192.168.1.4:8443/my-books"));
        assertTrue(lanPolicy.isTrustedMediaOrigin("https://192.168.1.4:8443"));

        TrustedNavigation tenNetPolicy = new TrustedNavigation("https://10.0.2.2:8443", true);
        assertTrue(tenNetPolicy.isTrusted("https://10.0.2.2:8443/login"));
        TrustedNavigation bClassPolicy = new TrustedNavigation("https://172.16.12.8:8443", true);
        assertTrue(bClassPolicy.isTrusted("https://172.16.12.8:8443/dashboard"));

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
    public void lanModeRejectsPublicRawIp() {
        new TrustedNavigation("https://8.8.8.8:8443", true);
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsNonHttpsStartupUrl() {
        new TrustedNavigation("http://localhost:3000");
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsRedirectStartupUrl() {
        new TrustedNavigation("https://viread.example.com/reading");
    }

    @Test
    public void nullAndBrokenCandidatesDoNotCrash() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrusted(null));
        assertFalse(policy.isTrusted(""));
        assertFalse(policy.isTrusted("https://["));
        assertFalse(policy.shouldOpenExternally(null));
    }

    @Test
    public void sslCertificateErrorsAreNeverBypassedInAnyMode() {
        TrustedNavigation prodPolicy = new TrustedNavigation("https://viread.example.com");
        TrustedNavigation lanPolicy = new TrustedNavigation("https://192.168.1.4:8443", true);
        assertFalse(prodPolicy.shouldProceedOnSslError());
        assertFalse(lanPolicy.shouldProceedOnSslError());
    }

    @Test
    public void normalizesAllVireadImageAndDocumentExtensionsAndRejectsMaliciousTokens() {
        List<String> allFormats = TrustedNavigation.normalizeAcceptMimeTypes(new String[]{
                ".jpg, .JPEG, .png, .webp, .bmp, .tif, .TIFF, .pdf, .DOCX",
                "image/jpg",
                "../etc/passwd",
                "javascript:alert(1)",
                "text/html;charset=utf-8",
                "",
                null
        });
        assertEquals(
                Arrays.asList(
                        "image/jpeg",
                        "image/png",
                        "image/webp",
                        "image/bmp",
                        "image/tiff",
                        "application/pdf",
                        DOCX_MIME),
                allFormats);
        assertEquals("*/*", TrustedNavigation.resolveIntentBaseMimeType(allFormats));
        assertTrue(TrustedNavigation.acceptsImages(allFormats));

        List<String> imagesOnly = TrustedNavigation.normalizeAcceptMimeTypes(
                new String[]{"image/jpeg, image/png, image/webp, .bmp, .tiff"});
        assertEquals("image/*", TrustedNavigation.resolveIntentBaseMimeType(imagesOnly));
        assertTrue(TrustedNavigation.acceptsImages(imagesOnly));

        List<String> pdfOnly = TrustedNavigation.normalizeAcceptMimeTypes(new String[]{".pdf"});
        assertEquals(Collections.singletonList("application/pdf"), pdfOnly);
        assertEquals("application/pdf", TrustedNavigation.resolveIntentBaseMimeType(pdfOnly));
        assertFalse(TrustedNavigation.acceptsImages(pdfOnly));

        List<String> empty = TrustedNavigation.normalizeAcceptMimeTypes(null);
        assertEquals("*/*", TrustedNavigation.resolveIntentBaseMimeType(empty));
        assertTrue(TrustedNavigation.acceptsImages(empty));
    }
}
