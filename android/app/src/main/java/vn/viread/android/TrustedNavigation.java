package vn.viread.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Exact-origin policy for top-level navigation and WebRTC permission requests.
 * XHR, signed media URLs and Supabase API requests are still subject to web CORS.
 *
 * Production builds enforce HTTPS on port 443 only. Explicit LAN acceptance debug
 * builds may pass {@code allowCustomPort = true} to permit an exact HTTPS LAN port
 * (e.g. 8443), while still rejecting HTTP, mismatched ports, lookalike hosts,
 * loopback addresses, public raw IPs, embedded credentials, and non-HTTPS schemes.
 */
public final class TrustedNavigation {
    private static final String DOCX_MIME =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    private final String host;
    private final int port;
    private final boolean allowCustomPort;

    public TrustedNavigation(String frontendUrl) {
        this(frontendUrl, false);
    }

    public TrustedNavigation(String frontendUrl, boolean allowCustomPort) {
        this.allowCustomPort = allowCustomPort;
        URI uri = parse(frontendUrl == null ? null : frontendUrl.trim());
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
        if (allowCustomPort && !isValidLanHost(normalizedHost)) {
            throw new IllegalArgumentException(
                    "LAN acceptance builds require a private RFC1918 IPv4 address or valid HTTPS LAN hostname.");
        }
        this.host = normalizedHost;
        this.port = effectivePort(uri);
    }

    public String getOrigin() {
        return port == 443 ? "https://" + host : "https://" + host + ":" + port;
    }

    public String getHost() {
        return host;
    }

    public int getPort() {
        return port;
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
     * Validate a {@code viread://auth/callback?...} OAuth return deep link and map it
     * strictly onto this build's trusted HTTPS {@code /auth/callback} endpoint so the
     * in-app WebView (holding the PKCE code_verifier) completes code exchange safely.
     */
    public String extractTrustedAuthCallbackUrl(String candidateDeepLink) {
        URI uri = parse(candidateDeepLink == null ? null : candidateDeepLink.trim());
        if (uri == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
            return null;
        }
        if (!"viread".equalsIgnoreCase(uri.getScheme())
                || !"auth".equalsIgnoreCase(uri.getHost())
                || uri.getPort() != -1) {
            return null;
        }
        String rawPath = uri.getRawPath();
        if (!"/callback".equals(rawPath)) {
            return null;
        }
        String rawQuery = uri.getRawQuery();
        List<String> safePairs = new ArrayList<>();
        if (rawQuery != null && !rawQuery.isEmpty()) {
            for (String pair : rawQuery.split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String key = eq >= 0 ? pair.substring(0, eq) : pair;
                String val = eq >= 0 ? pair.substring(eq + 1) : "";
                if ("code".equals(key) && val.matches("[A-Za-z0-9._~%-]{1,512}")) {
                    safePairs.add("code=" + val);
                } else if ("error".equals(key) && val.matches("[A-Za-z0-9._~%-]{1,128}")) {
                    safePairs.add("error=" + val);
                } else if ("next".equals(key) && ("%2Fprofile".equalsIgnoreCase(val) || "/profile".equals(val))) {
                    safePairs.add("next=%2Fprofile");
                }
            }
        }
        if (safePairs.isEmpty()) {
            return null;
        }
        return getOrigin() + "/auth/callback?" + String.join("&", safePairs);
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

    /**
     * TLS certificate errors must NEVER be bypassed in either production or LAN
     * acceptance builds. LAN builds trust only the explicitly scoped public test CA
     * via Android's network_security_config.xml.
     */
    public boolean shouldProceedOnSslError() {
        return false;
    }

    /**
     * Normalize WebView {@code FileChooserParams.getAcceptTypes()} entries across all
     * ViRead supported page/document formats (.jpg, .jpeg, .png, .webp, .bmp, .tif, .tiff,
     * .pdf, .docx, plus standard MIME strings and comma-separated lists).
     */
    public static List<String> normalizeAcceptMimeTypes(String[] rawTypes) {
        Set<String> out = new LinkedHashSet<>();
        if (rawTypes == null) return new ArrayList<>(out);
        for (String entry : rawTypes) {
            if (entry == null) continue;
            for (String part : entry.split(",")) {
                String token = part.trim().toLowerCase(Locale.ROOT);
                if (token.isEmpty()) continue;
                switch (token) {
                    case ".jpg":
                    case ".jpeg":
                    case "image/jpg":
                    case "image/pjpeg":
                        out.add("image/jpeg");
                        break;
                    case ".png":
                    case "image/x-png":
                        out.add("image/png");
                        break;
                    case ".webp":
                        out.add("image/webp");
                        break;
                    case ".bmp":
                    case "image/x-ms-bmp":
                        out.add("image/bmp");
                        break;
                    case ".tif":
                    case ".tiff":
                        out.add("image/tiff");
                        break;
                    case ".pdf":
                        out.add("application/pdf");
                        break;
                    case ".docx":
                        out.add(DOCX_MIME);
                        break;
                    default:
                        if (isValidMimeToken(token)) {
                            out.add(token);
                        }
                        break;
                }
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * Pick the safest base MIME type for Android's {@code ACTION_OPEN_DOCUMENT}
     * picker so image pickers open directly into Photos/Gallery when all accepted
     * types are images, while multi-category inputs (.jpg + .pdf + .docx) use wildcard
     * base + EXTRA_MIME_TYPES.
     */
    public static String resolveIntentBaseMimeType(List<String> normalizedTypes) {
        if (normalizedTypes == null || normalizedTypes.isEmpty()) return "*/*";
        if (normalizedTypes.size() == 1) return normalizedTypes.get(0);
        boolean allImages = true;
        for (String mime : normalizedTypes) {
            if (mime == null || !mime.startsWith("image/")) {
                allImages = false;
                break;
            }
        }
        return allImages ? "image/*" : "*/*";
    }

    /**
     * True when the file input accepts image captures (either unrestricted or includes image/*).
     */
    public static boolean acceptsImages(List<String> normalizedTypes) {
        if (normalizedTypes == null || normalizedTypes.isEmpty()) return true;
        for (String mime : normalizedTypes) {
            if ("*/*".equals(mime) || (mime != null && mime.startsWith("image/"))) {
                return true;
            }
        }
        return false;
    }

    /**
     * Inspect an outbound HTTPS OAuth authorize URL (e.g. {@code https://<project>.supabase.co/auth/v1/authorize})
     * and return the cryptographic {@code viread_nonce} embedded in {@code redirect_to} when it targets
     * the RFC 8252 Android loopback listener ({@code 127.0.0.1:3000/auth/callback} or {@code localhost:3000/auth/callback}).
     * Returns {@code null} for all non-OAuth or non-loopback URLs.
     */
    public static String extractOAuthLoopbackNonce(String candidateUrl) {
        URI authUri = parse(candidateUrl);
        if (authUri == null
                || !"https".equalsIgnoreCase(authUri.getScheme())
                || authUri.getHost() == null
                || authUri.getRawUserInfo() != null) {
            return null;
        }
        String authPath = authUri.getRawPath();
        if (authPath == null || !authPath.endsWith("/auth/v1/authorize")) {
            return null;
        }
        String redirectTo = OAuthLoopbackServer.extractDecodedQueryParam(
                authUri.getRawQuery(), "redirect_to");
        URI redirectUri = parse(redirectTo);
        if (redirectUri == null
                || !"http".equalsIgnoreCase(redirectUri.getScheme())
                || redirectUri.getHost() == null
                || redirectUri.getRawUserInfo() != null) {
            return null;
        }
        String redirectHost = redirectUri.getHost().toLowerCase(Locale.ROOT);
        boolean isLoopbackHost = "127.0.0.1".equals(redirectHost) || "localhost".equals(redirectHost);
        if (!isLoopbackHost
                || redirectUri.getPort() != OAuthLoopbackServer.DEFAULT_PORT
                || !"/auth/callback".equals(redirectUri.getRawPath())) {
            return null;
        }
        String nonce = OAuthLoopbackServer.extractDecodedQueryParam(
                redirectUri.getRawQuery(), "viread_nonce");
        if (nonce == null || !nonce.matches("[A-Za-z0-9_-]{16,128}")) {
            return null;
        }
        return nonce;
    }

    private static boolean isValidMimeToken(String token) {
        if (token.contains("..")) return false;
        int slash = token.indexOf('/');
        if (slash <= 0 || slash != token.lastIndexOf('/') || slash == token.length() - 1) {
            return false;
        }
        String type = token.substring(0, slash);
        String subtype = token.substring(slash + 1);
        if ("*".equals(type)) {
            return "*".equals(subtype);
        }
        if (!type.matches("[a-z0-9][a-z0-9.+_-]*")) {
            return false;
        }
        return "*".equals(subtype) || subtype.matches("[a-z0-9][a-z0-9.+_-]*");
    }

    private static URI parse(String url) {
        if (url == null || url.isEmpty()) return null;
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
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || h == null
                || h.contains(":")
                || uri.getRawUserInfo() != null) {
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
                || !host.contains(".")
                || host.endsWith(".local")
                || host.endsWith(".lan")
                || host.endsWith(".home.arpa")
                || host.endsWith(".invalid")
                || host.endsWith(".internal")
                || host.endsWith(".test")
                || host.matches("[0-9.]+");
    }

    static boolean isPrivateRfc1918Ipv4(String host) {
        if (host == null || !host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
            return false;
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                octets[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException ex) {
                return false;
            }
            if (octets[i] < 0 || octets[i] > 255) return false;
        }
        if (octets[0] == 10) return true;
        if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) return true;
        return octets[0] == 192 && octets[1] == 168;
    }

    private static boolean isValidLanHost(String host) {
        if ("localhost".equals(host)
                || host.endsWith(".invalid")
                || host.endsWith(".internal")
                || !host.contains(".")) {
            return false;
        }
        if (host.matches("[0-9.]+")) {
            return isPrivateRfc1918Ipv4(host);
        }
        String[] labels = host.split("\\.", -1);
        for (String label : labels) {
            if (label.isEmpty() || label.startsWith("-") || label.endsWith("-")) {
                return false;
            }
        }
        return true;
    }

    private static boolean rootOnly(URI uri) {
        String path = uri.getRawPath();
        return (path == null || path.isEmpty() || "/".equals(path))
                && uri.getRawQuery() == null
                && uri.getRawFragment() == null;
    }
}
