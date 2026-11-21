package vn.viread.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import androidx.core.content.FileProvider;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class AppBrandingAndManifestTest {
    @Test
    public void appNameAndVietnameseBrandStringsAreConsistent() {
        Context context = ApplicationProvider.getApplicationContext();
        assertEquals("ViRead", context.getString(R.string.app_name));
        assertTrue(context.getString(R.string.loading_title).contains("ViRead"));
        assertTrue(context.getString(R.string.offline_message).contains("ViRead"));
        assertTrue(context.getString(R.string.tls_error_message).contains("HTTPS"));
        assertEquals("Thử lại", context.getString(R.string.retry_button));
        assertEquals("Về trang đăng nhập", context.getString(R.string.open_home_button));
        assertEquals("Kiểm tra lại kết nối", context.getString(R.string.check_connection_button));
    }

    @Test
    public void adaptiveLauncherIconsSplashDrawablesAndThemesExist() {
        Context context = ApplicationProvider.getApplicationContext();
        Drawable squareIcon = context.getDrawable(R.mipmap.ic_launcher);
        Drawable roundIcon = context.getDrawable(R.mipmap.ic_launcher_round);
        Drawable fg = context.getDrawable(R.drawable.ic_launcher_foreground);
        Drawable bg = context.getDrawable(R.drawable.ic_launcher_background);
        Drawable mono = context.getDrawable(R.drawable.ic_launcher_monochrome);
        Drawable splashLogo = context.getDrawable(R.drawable.viread_splash_logo);
        Drawable splashWindow = context.getDrawable(R.drawable.splash_window_background);

        assertNotNull("Square launcher icon must resolve", squareIcon);
        assertNotNull("Round launcher icon must resolve", roundIcon);
        assertNotNull("Adaptive foreground vector must resolve", fg);
        assertNotNull("Adaptive background vector must resolve", bg);
        assertNotNull("Adaptive monochrome vector must resolve", mono);
        assertNotNull("Splash logo drawable must resolve", splashLogo);
        assertNotNull("Splash window background must resolve", splashWindow);

        assertTrue(R.style.Theme_ViRead != 0);
        assertTrue(R.style.Theme_ViRead_Splash != 0);
    }

    @Test
    public void manifestEnforcesSecurityFlagsPermissionsAndScopedFileProvider() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        PackageManager pm = context.getPackageManager();
        assertEquals("vn.viread.android", context.getPackageName());

        ApplicationInfo appInfo = pm.getApplicationInfo(context.getPackageName(), 0);
        assertEquals(R.mipmap.ic_launcher, appInfo.icon);
        assertEquals(
                "allowBackup must be false",
                0,
                appInfo.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        assertEquals(
                "usesCleartextTraffic must be false",
                0,
                appInfo.flags & ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC);

        PackageInfo pkgInfo = pm.getPackageInfo(
                context.getPackageName(),
                PackageManager.GET_PERMISSIONS | PackageManager.GET_PROVIDERS);
        Set<String> perms = new HashSet<>(Arrays.asList(pkgInfo.requestedPermissions));
        assertTrue(perms.contains(Manifest.permission.INTERNET));
        assertTrue(perms.contains(Manifest.permission.ACCESS_NETWORK_STATE));
        assertTrue(perms.contains(Manifest.permission.CAMERA));
        assertTrue(perms.contains(Manifest.permission.RECORD_AUDIO));
        assertTrue(perms.contains(Manifest.permission.MODIFY_AUDIO_SETTINGS));

        ProviderInfo provider = pm.resolveContentProvider(
                "vn.viread.android.fileprovider", PackageManager.GET_META_DATA);
        assertNotNull("Scoped FileProvider must be registered", provider);
        assertFalse("FileProvider must never be exported", provider.exported);
        assertTrue("FileProvider must grant temporary URI permissions", provider.grantUriPermissions);

        File captureDir = new File(context.getCacheDir(), "camera_captures");
        assertTrue(captureDir.exists() || captureDir.mkdirs());
        File sample = new File(captureDir, "test_page.jpg");
        assertTrue(sample.createNewFile());
        Uri contentUri = MainActivity.buildCameraCaptureUri(context, sample);
        assertEquals("content", contentUri.getScheme());
        assertEquals("vn.viread.android.fileprovider", contentUri.getAuthority());
        assertEquals("/camera_captures/test_page.jpg", contentUri.getPath());
        //noinspection ResultOfMethodCallIgnored
        sample.delete();
    }
}
