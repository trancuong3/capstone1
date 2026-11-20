package vn.viread.android;

import org.junit.Test;
import static org.junit.Assert.*;

public final class TrustedNavigationTest {
    @Test public void permitsExactHttpsOriginAndRoute() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertTrue(policy.isTrusted("https://viread.example.com/dashboard"));
        assertTrue(policy.isTrusted("https://VIREAD.example.com:443/reading/abc"));
        assertTrue(policy.isTrusted("https://viread.example.com/auth/callback?code=abc"));
    }

    @Test public void deniesForeignOriginsAndDowngrades() {
        TrustedNavigation policy = new TrustedNavigation("https://viread.example.com");
        assertFalse(policy.isTrusted("http://viread.example.com/login"));
        assertFalse(policy.isTrusted("https://viread.example.com.evil.test/login"));
        assertFalse(policy.isTrusted("https://evil.test@viread.example.com/login"));
        assertFalse(policy.isTrusted("https://viread.example.com:444/login"));
        assertFalse(policy.isTrusted("javascript:alert(1)"));
        assertFalse(policy.isTrusted("file:///android_asset/index.html"));
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
    }
}
