package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class ServerEndpointConfigTest {
    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(ServerEndpointStore.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    @Test(expected = SecurityException.class)
    public void releaseBuildStrictlyForbidsLanAcceptanceMode() {
        new ServerEndpointStore(context, "https://192.168.1.4:8443", false, true);
    }

    @Test
    public void releaseBuildIgnoresAndPurgesAnyStoredOverrideAndBlocksCustomSave() {
        SharedPreferences prefs = context.getSharedPreferences(
                ServerEndpointStore.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(
                ServerEndpointStore.KEY_CUSTOM_LAN_ORIGIN, "https://192.168.1.99:8443").commit();

        ServerEndpointStore releaseStore = new ServerEndpointStore(
                context, "https://viread.example.com", false, false);
        assertFalse(releaseStore.canOverrideEndpoint());
        assertFalse(releaseStore.hasCustomOverride());
        assertEquals("https://viread.example.com", releaseStore.getActiveOrigin());
        assertFalse(prefs.contains(ServerEndpointStore.KEY_CUSTOM_LAN_ORIGIN));

        try {
            releaseStore.saveCustomLanOrigin("https://192.168.1.10:8443");
            fail("Release build must throw SecurityException on custom LAN override");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("disabled"));
        }
    }

    @Test(expected = SecurityException.class)
    public void debugNonLanBuildAlsoForbidsCustomLanOverride() {
        ServerEndpointStore debugPublicStore = new ServerEndpointStore(
                context, "https://viread.example.com", true, false);
        assertFalse(debugPublicStore.canOverrideEndpoint());
        debugPublicStore.saveCustomLanOrigin("https://192.168.1.10:8443");
    }

    @Test
    public void debugLanBuildAllowsValidatedHttpsLanSwitchAndRejectsInsecureCandidates() {
        ServerEndpointStore lanStore = new ServerEndpointStore(
                context, "https://192.168.1.4:8443", true, true);
        assertTrue(lanStore.canOverrideEndpoint());
        assertEquals("https://192.168.1.4:8443", lanStore.getActiveOrigin());

        TrustedNavigation updated = lanStore.saveCustomLanOrigin("https://192.168.1.25:8443/");
        assertEquals("https://192.168.1.25:8443", updated.getOrigin());
        assertTrue(lanStore.hasCustomOverride());
        assertEquals("https://192.168.1.25:8443", lanStore.getActiveOrigin());

        String[] invalidCandidates = new String[]{
                "http://192.168.1.25:8443",
                "https://localhost:8443",
                "https://127.0.0.1:8443",
                "https://8.8.8.8:8443",
                "https://192.168.1.25:8443/login",
                "https://user:pass@192.168.1.25:8443"
        };
        for (String bad : invalidCandidates) {
            try {
                lanStore.saveCustomLanOrigin(bad);
                fail("Expected IllegalArgumentException for invalid LAN candidate: " + bad);
            } catch (IllegalArgumentException expected) {
                // Keep previous valid override intact
                assertEquals("https://192.168.1.25:8443", lanStore.getActiveOrigin());
            }
        }

        TrustedNavigation reset = lanStore.clearCustomLanOrigin();
        assertEquals("https://192.168.1.4:8443", reset.getOrigin());
        assertFalse(lanStore.hasCustomOverride());
    }
}
