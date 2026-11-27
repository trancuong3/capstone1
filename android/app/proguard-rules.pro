# Keep ViRead Android classes and any future WebView JS bridge methods intact under R8.
-keep class vn.viread.android.** { *; }
-keepclassmembers class vn.viread.android.** {
    @android.webkit.JavascriptInterface <methods>;
}
