package vn.viread.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Parcelable;
import android.provider.MediaStore;
import android.webkit.WebChromeClient;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowPackageManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class FileChooserAndCameraCaptureTest {

    @Before
    public void setUpCameraCapabilities() {
        Application app = ApplicationProvider.getApplicationContext();
        ShadowPackageManager spm = Shadows.shadowOf(app.getPackageManager());
        spm.setSystemFeature(PackageManager.FEATURE_CAMERA_ANY, true);
        ShadowApplication sa = Shadows.shadowOf(app);
        sa.grantPermissions(Manifest.permission.CAMERA);
    }

    private static WebChromeClient.FileChooserParams fakeParams(
            final String[] acceptTypes,
            final int mode,
            final boolean captureEnabled) {
        return new WebChromeClient.FileChooserParams() {
            @Override
            public int getMode() {
                return mode;
            }

            @Override
            public String[] getAcceptTypes() {
                return acceptTypes;
            }

            @Override
            public boolean isCaptureEnabled() {
                return captureEnabled;
            }

            @Override
            public CharSequence getTitle() {
                return "Choose";
            }

            @Override
            public String getFilenameHint() {
                return null;
            }

            @Override
            public Intent createIntent() {
                return new Intent(Intent.ACTION_GET_CONTENT);
            }
        };
    }

    @Test
    public void imageChooserIncludesBothDocumentPickerAndFileProviderCameraCapture() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebChromeClient chrome = Shadows.shadowOf(activity.getWebViewForTest()).getWebChromeClient();
        assertNotNull(chrome);

        AtomicReference<Uri[]> resultRef = new AtomicReference<>(new Uri[0]);
        boolean handled = chrome.onShowFileChooser(
                activity.getWebViewForTest(),
                resultRef::set,
                fakeParams(
                        new String[]{"image/jpeg,image/png,image/webp"},
                        WebChromeClient.FileChooserParams.MODE_OPEN,
                        false));
        assertTrue(handled);
        assertTrue(activity.hasPendingFilesForTest());

        ShadowActivity shadowActivity = Shadows.shadowOf(activity);
        ShadowActivity.IntentForResult launched = shadowActivity.getNextStartedActivityForResult();
        assertNotNull(launched);
        assertEquals(Intent.ACTION_CHOOSER, launched.intent.getAction());

        Intent primary = launched.intent.getParcelableExtra(Intent.EXTRA_INTENT);
        assertNotNull(primary);
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, primary.getAction());
        assertEquals("image/*", primary.getType());

        Parcelable[] initial = launched.intent.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS);
        assertNotNull("Camera capture intent must be offered alongside gallery", initial);
        assertEquals(1, initial.length);
        Intent cameraIntent = (Intent) initial[0];
        assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, cameraIntent.getAction());
        Uri outputUri = cameraIntent.getParcelableExtra(MediaStore.EXTRA_OUTPUT);
        assertNotNull(outputUri);
        assertEquals("content", outputUri.getScheme());
        assertEquals("vn.viread.android.fileprovider", outputUri.getAuthority());

        // Simulate camera writing bytes to the temp JPEG and returning RESULT_OK with null data
        File captureDir = new File(activity.getCacheDir(), "camera_captures");
        File[] files = captureDir.listFiles();
        assertNotNull(files);
        assertEquals(1, files.length);
        try (FileOutputStream fos = new FileOutputStream(files[0])) {
            fos.write("fake-jpeg-bytes".getBytes(StandardCharsets.UTF_8));
        }

        activity.onActivityResult(MainActivity.FILE_CHOOSER_CODE, Activity.RESULT_OK, null);
        assertNotNull(resultRef.get());
        assertEquals(1, resultRef.get().length);
        assertEquals(outputUri, resultRef.get()[0]);
        assertFalse(activity.hasPendingFilesForTest());
    }

    @Test
    public void privateBookMultiFormatChooserMapsPdfDocxBmpTiffAndHandlesCancelCleanly() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebChromeClient chrome = Shadows.shadowOf(activity.getWebViewForTest()).getWebChromeClient();

        AtomicReference<Uri[]> firstCallback = new AtomicReference<>(new Uri[]{Uri.parse("https://sentinel")});
        chrome.onShowFileChooser(
                activity.getWebViewForTest(),
                firstCallback::set,
                fakeParams(
                        new String[]{".jpg,.png,.bmp,.tiff,.pdf,.docx"},
                        WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE,
                        false));

        ShadowActivity shadowActivity = Shadows.shadowOf(activity);
        ShadowActivity.IntentForResult launched = shadowActivity.getNextStartedActivityForResult();
        Intent docIntent = launched.intent.getParcelableExtra(Intent.EXTRA_INTENT);
        assertNotNull(docIntent);
        assertEquals("*/*", docIntent.getType());
        assertTrue(docIntent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));

        String[] mimeExtras = docIntent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES);
        assertNotNull(mimeExtras);
        Set<String> mimeSet = new HashSet<>(Arrays.asList(mimeExtras));
        assertTrue(mimeSet.contains("image/jpeg"));
        assertTrue(mimeSet.contains("image/png"));
        assertTrue(mimeSet.contains("image/bmp"));
        assertTrue(mimeSet.contains("image/tiff"));
        assertTrue(mimeSet.contains("application/pdf"));
        assertTrue(mimeSet.contains(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));

        // User cancels picker -> callback receives null and cleans up state for next picker
        activity.onActivityResult(MainActivity.FILE_CHOOSER_CODE, Activity.RESULT_CANCELED, null);
        assertNull("Canceled picker must deliver null so HTML input never deadlocks", firstCallback.get());
        assertFalse(activity.hasPendingFilesForTest());

        // Subsequent PDF-only picker works immediately and omits Camera intent
        AtomicReference<Uri[]> secondCallback = new AtomicReference<>();
        chrome.onShowFileChooser(
                activity.getWebViewForTest(),
                secondCallback::set,
                fakeParams(
                        new String[]{".pdf"},
                        WebChromeClient.FileChooserParams.MODE_OPEN,
                        false));
        ShadowActivity.IntentForResult secondLaunched = shadowActivity.getNextStartedActivityForResult();
        assertNull(
                "PDF-only chooser should not attach camera capture intent",
                secondLaunched.intent.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS));

        // Multi-file ClipData selection returns all URIs
        Uri u1 = Uri.parse("content://com.android.providers.media.documents/document/image%3A1");
        Uri u2 = Uri.parse("content://com.android.providers.media.documents/document/image%3A2");
        Intent multiData = new Intent();
        ClipData clip = ClipData.newRawUri("pages", u1);
        clip.addItem(new ClipData.Item(u2));
        multiData.setClipData(clip);
        activity.onActivityResult(MainActivity.FILE_CHOOSER_CODE, Activity.RESULT_OK, multiData);
        assertArrayEquals(new Uri[]{u1, u2}, secondCallback.get());
    }
}
