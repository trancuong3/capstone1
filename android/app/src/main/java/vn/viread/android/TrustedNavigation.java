package vn.viread.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Exact-origin policy for top-level navigation and WebRTC permission requests.
 * XHR, signed media URLs and Supabase API requests are still subject to web CORS.
 *
 * Production builds enforce HTTPS on port 443 only. Explicit LAN acceptance debug
 * builds may pass {@code allowCustomPort = true} to permit an exact HTTPS LAN port
 * (e.g. 8443), while still rejecting HTTP, mismatched ports, lookalike hosts,
 * embedded credentials, and non-HTTPS schemes.
 */
public final class TrustedNavigation {
    private final String host;
    private final int port;
    private final boolean allowCustomPort;

    public TrustedNavigation(String frontendUrl) {
        this(frontendUrl, false);
    }

    public TrustedNavigation(String frontendUrl, boolean allowCustomPort) {
        this.allowCustomPort = allowCustomPort;
        URI uri = parse(frontendUrl);
        if (uri == null || !secureHost(uri, allowCustomPort) || !rootOnly(uri)) {
            throw new IllegalArgumentException(
                    allowCustomPort
                            ? "A valid HTTPS LAN acceptance frontend origin is required."
                            : "A public HTTPS frontend origin is required.");
        }
        String normalizedHost = uri.getHost().toLowerCase(Locale.ROOT);
        if (!allowCustomPort && isPrivateOrLocalHost(normalizedHost)) {
            throw new IllegalArgumentException("Production builds reject local or private IP hosts.");
        }
        if (allowCustomPort && ("localhost".equals(normalizedHost) || "127.0.0.1".equals(normalizedHost))) {
            throw new IllegalArgumentException("LAN acceptance builds reject loopback hosts unreachable from a phone.");
        }
        this.host = normalizedHost;
        this.port = effectivePort(uri);
    }

    public boolean isTrusted(String candidateUrl) {
        URI uri = parse(candidateUrl);
        return uri != null
                && secureHost(uri, allowCustomPort)
                && host.equals(uri.getHost().toLowerCase(Locale.ROOT))
                && port == effectivePort(uri);
    }

    /**
     * WebRTC camera/microphone permission requests must originate strictly from the
     * configured exact origin; any other origin or downgrade is denied.
     */
    public boolean isTrustedMediaOrigin(String candidateOrigin) {
        return isTrusted(candidateOrigin);
    }

    /**
     * External links opened in the system browser instead of the authenticated WebView.
     * HTTP, file:, javascript:, and intent: are strictly blocked.
     */
    public boolean shouldOpenExternally(String candidateUrl) {
        if (isTrusted(candidateUrl)) return false;
        URI uri = parse(candidateUrl);
        if (uri == null || uri.getScheme() == null) return false;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        return "https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme);
    }

    public boolean isAllowCustomPort() {
        return allowCustomPort;
    }

    private static URI parse(String url) {
        if (url == null) return null;
        try {
            return new URI(url);
        } catch (URISyntaxException | IllegalArgumentException e) {
            return null;
        }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }

    private static boolean secureHost(URI uri, boolean allowCustomPort) {
        String h = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || h == null || uri.getRawUserInfo() != null) {
            return false;
        }
        int p = effectivePort(uri);
        if (allowCustomPort) {
            return p >= 1 && p <= 65535;
        }
        return p == 443;
    }

    private static boolean isPrivateOrLocalHost(String host) {
        return "localhost".equals(host)
                || host.endsWith(".local")
                || host.endsWith(".invalid")
                || host.endsWith(".internal")
                || host.matches("[0-9.]+");
    }

    private static boolean rootOnly(URI uri) {
        String path = uri.getRawPath();
        return (path == null || path.isEmpty() || "/".equals(path))
                && uri.getRawQuery() == null
                && uri.getRawFragment() == null;
    }
}
