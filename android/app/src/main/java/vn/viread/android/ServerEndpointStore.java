package vn.viread.android;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Resolves the active ViRead HTTPS frontend origin with strict build-mode isolation:
 * - In Release builds (or non-LAN builds), ALWAYS enforces {@code compiledFrontendUrl}
 *   and refuses/clears any custom override.
 * - ONLY when {@code isDebugBuild && isLanAcceptanceMode} is true may a developer/tester
 *   switch the RFC1918 LAN HTTPS origin (e.g. when DHCP Wi-Fi IP changes from
 *   https://192.168.1.4:8443 to https://192.168.1.12:8443) without weakening TLS CA checks.
 */
public final class ServerEndpointStore {
    static final String PREFS_NAME = "viread_endpoint_config";
    static final String KEY_CUSTOM_LAN_ORIGIN = "custom_lan_https_origin";

    private final SharedPreferences prefs;
    private final String compiledFrontendUrl;
    private final boolean isDebugBuild;
    private final boolean isLanAcceptanceMode;
    private final TrustedNavigation defaultNavigation;

    public ServerEndpointStore(Context context) {
        this(
                context,
                BuildConfig.FRONTEND_URL,
                BuildConfig.DEBUG,
                BuildConfig.LAN_ACCEPTANCE_MODE);
    }

    public ServerEndpointStore(
            Context context,
            String compiledFrontendUrl,
            boolean isDebugBuild,
            boolean isLanAcceptanceMode) {
        if (context == null) {
            throw new IllegalArgumentException("Context is required.");
        }
        if (!isDebugBuild && isLanAcceptanceMode) {
            throw new SecurityException(
                    "LAN acceptance mode is strictly forbidden in Release builds.");
        }
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.compiledFrontendUrl = compiledFrontendUrl;
        this.isDebugBuild = isDebugBuild;
        this.isLanAcceptanceMode = isLanAcceptanceMode;
        this.defaultNavigation = new TrustedNavigation(
                compiledFrontendUrl, isDebugBuild && isLanAcceptanceMode);

        if (!canOverrideEndpoint() && prefs.contains(KEY_CUSTOM_LAN_ORIGIN)) {
            prefs.edit().remove(KEY_CUSTOM_LAN_ORIGIN).apply();
        }
    }

    public boolean canOverrideEndpoint() {
        return isDebugBuild && isLanAcceptanceMode;
    }

    public TrustedNavigation getDefaultNavigation() {
        return defaultNavigation;
    }

    public TrustedNavigation resolveNavigation() {
        if (!canOverrideEndpoint()) {
            return defaultNavigation;
        }
        String stored = prefs.getString(KEY_CUSTOM_LAN_ORIGIN, null);
        if (stored == null || stored.trim().isEmpty()) {
            return defaultNavigation;
        }
        try {
            return new TrustedNavigation(stored.trim(), true);
        } catch (IllegalArgumentException invalidStored) {
            prefs.edit().remove(KEY_CUSTOM_LAN_ORIGIN).apply();
            return defaultNavigation;
        }
    }

    public String getActiveOrigin() {
        return resolveNavigation().getOrigin();
    }

    public boolean hasCustomOverride() {
        if (!canOverrideEndpoint()) return false;
        String stored = prefs.getString(KEY_CUSTOM_LAN_ORIGIN, null);
        return stored != null && !stored.trim().isEmpty();
    }

    public TrustedNavigation saveCustomLanOrigin(String candidateOrigin) {
        if (!canOverrideEndpoint()) {
            throw new SecurityException(
                    "Custom LAN server override is strictly disabled outside Debug LAN builds.");
        }
        TrustedNavigation validated = new TrustedNavigation(candidateOrigin, true);
        prefs.edit().putString(KEY_CUSTOM_LAN_ORIGIN, validated.getOrigin()).apply();
        return validated;
    }

    public TrustedNavigation clearCustomLanOrigin() {
        prefs.edit().remove(KEY_CUSTOM_LAN_ORIGIN).apply();
        return defaultNavigation;
    }
}
