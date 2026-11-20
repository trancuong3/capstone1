package vn.viread.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Exact-origin policy for top-level navigation and WebRTC permission requests.
 * XHR, signed media URLs and Supabase API requests are still subject to web CORS.
 */
public final class TrustedNavigation {
    private final String host;
    private final int port;

    public TrustedNavigation(String frontendUrl) {
        URI uri = parse(frontendUrl);
        if (uri == null || !secureHost(uri) || !rootOnly(uri)) {
            throw new IllegalArgumentException("A public HTTPS frontend origin is required.");
        }
        host = uri.getHost().toLowerCase(Locale.ROOT);
        port = effectivePort(uri);
    }

    public boolean isTrusted(String candidateUrl) {
        URI uri = parse(candidateUrl);
        return uri != null && secureHost(uri)
                && host.equals(uri.getHost().toLowerCase(Locale.ROOT))
                && port == effectivePort(uri);
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

    private static boolean secureHost(URI uri) {
        String h = uri.getHost();
        return "https".equalsIgnoreCase(uri.getScheme()) && h != null
                && uri.getRawUserInfo() == null
                && effectivePort(uri) == 443;
    }

    private static boolean rootOnly(URI uri) {
        String path = uri.getRawPath();
        return (path == null || path.isEmpty() || "/".equals(path))
                && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }
}
