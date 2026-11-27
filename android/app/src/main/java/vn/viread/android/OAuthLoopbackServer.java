package vn.viread.android;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Ephemeral RFC 8252 Section 7.3 loopback OAuth 2.0 callback listener on {@code 127.0.0.1:3000}.
 *
 * <p>Why this exists:
 * <ul>
 *   <li>Google OAuth ({@code accounts.google.com}) blocks embedded Android WebViews
 *       ({@code 403 disallowed_useragent}) and requires Chrome Custom Tabs / system browser.</li>
 *   <li>Supabase GoTrue whitelists loopback callback {@code /auth/callback} on port 3000 while
 *       preserving PKCE {@code code} and a per-attempt cryptographic {@code viread_nonce}.</li>
 *   <li>Accepting the callback on {@code 127.0.0.1} inside the app and immediately loading
 *       {@code https://<origin>/auth/callback?code=...} in {@code WebView} preserves the PKCE
 *       {@code code_verifier} cookie stored in {@code WebView}, while returning {@code 302} to
 *       {@code viread://oauth-callback} closes the Chrome Custom Tab cleanly on Android 8-16.</li>
 * </ul>
 */
public final class OAuthLoopbackServer {
    public static final int DEFAULT_PORT = 3000;
    private static final int ACCEPT_TIMEOUT_MS = 180_000;
    private static final int CLIENT_TIMEOUT_MS = 5_000;
    private static final String CALLBACK_PATH = "/auth/callback";
    private static final String NONCE_PARAM = "viread_nonce";
    private static final String APP_RETURN_URI = "viread://oauth-callback";
    private static final String APP_RETURN_INTENT_URI =
            "intent://oauth-callback#Intent;scheme=viread;package=vn.viread.android;end";

    public interface CallbackListener {
        void onOAuthCallbackReceived(String sanitizedQuerySuffix);
    }

    private final Object lock = new Object();
    private ServerSocket serverSocket;
    private volatile boolean running;

    /**
     * Bind strictly to {@code 127.0.0.1:<port>} (pass {@code 0} in unit tests for an ephemeral port)
     * and wait for a single nonce-verified {@code GET /auth/callback} redirect.
     *
     * @return the bound local TCP port
     */
    public int start(int port, String expectedNonce, CallbackListener listener) throws IOException {
        if (expectedNonce == null || expectedNonce.trim().isEmpty()) {
            throw new IllegalArgumentException("expectedNonce is required.");
        }
        if (listener == null) {
            throw new IllegalArgumentException("listener is required.");
        }
        stop();

        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 8);
        socket.setSoTimeout(ACCEPT_TIMEOUT_MS);

        synchronized (lock) {
            this.serverSocket = socket;
            this.running = true;
        }

        final int boundPort = socket.getLocalPort();
        final String requiredNonce = expectedNonce.trim();
        Thread worker = new Thread(() -> acceptLoop(socket, requiredNonce, listener), "ViRead-OAuth-Loopback");
        worker.setDaemon(true);
        worker.start();
        return boundPort;
    }

    public boolean isRunning() {
        synchronized (lock) {
            return running && serverSocket != null && !serverSocket.isClosed();
        }
    }

    public void stop() {
        ServerSocket current;
        synchronized (lock) {
            running = false;
            current = serverSocket;
            serverSocket = null;
        }
        if (current != null) {
            try {
                current.close();
            } catch (IOException ignored) {
                // Safe close on shutdown
            }
        }
    }

    private void acceptLoop(
            ServerSocket socket,
            String expectedNonce,
            CallbackListener listener) {
        try {
            long deadline = System.currentTimeMillis() + ACCEPT_TIMEOUT_MS;
            while (isSocketActive(socket) && System.currentTimeMillis() < deadline) {
                try (Socket client = socket.accept()) {
                    client.setSoTimeout(CLIENT_TIMEOUT_MS);
                    boolean completed = handleClient(client, expectedNonce, listener);
                    if (completed) {
                        return;
                    }
                } catch (SocketTimeoutException timeout) {
                    break;
                } catch (IOException acceptEx) {
                    if (!isSocketActive(socket)) {
                        break;
                    }
                }
            }
        } finally {
            closeIfSameSocket(socket);
        }
    }

    private boolean isSocketActive(ServerSocket socket) {
        synchronized (lock) {
            return running && serverSocket == socket && !socket.isClosed();
        }
    }

    private void closeIfSameSocket(ServerSocket socket) {
        synchronized (lock) {
            if (serverSocket == socket) {
                running = false;
                serverSocket = null;
            }
        }
        try {
            socket.close();
        } catch (IOException ignored) {
            // Safe close
        }
    }

    private boolean handleClient(
            Socket client,
            String expectedNonce,
            CallbackListener listener) throws IOException {
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
        String requestLine = reader.readLine();
        if (requestLine == null || requestLine.isEmpty()) {
            return false;
        }
        // Consume remaining request headers up to a bounded line count so Chrome reads response cleanly
        for (int i = 0; i < 64; i++) {
            String header = reader.readLine();
            if (header == null || header.isEmpty()) {
                break;
            }
        }

        String[] parts = requestLine.split(" ");
        if (parts.length < 2 || !"GET".equalsIgnoreCase(parts[0])) {
            writePlainResponse(client.getOutputStream(), "405 Method Not Allowed", "Method Not Allowed");
            return false;
        }

        String target = parts[1];
        int qIdx = target.indexOf('?');
        String rawPath = qIdx >= 0 ? target.substring(0, qIdx) : target;
        String rawQuery = qIdx >= 0 ? target.substring(qIdx + 1) : "";

        if (!CALLBACK_PATH.equals(rawPath)) {
            writeNoContent(client.getOutputStream());
            return false;
        }

        String actualNonce = extractDecodedQueryParam(rawQuery, NONCE_PARAM);
        if (actualNonce == null
                || !MessageDigest.isEqual(
                        expectedNonce.getBytes(StandardCharsets.UTF_8),
                        actualNonce.getBytes(StandardCharsets.UTF_8))) {
            writePlainResponse(
                    client.getOutputStream(),
                    "403 Forbidden",
                    "Phien xac thuc OAuth khong hop le hoac da het han.");
            return false;
        }

        String sanitizedQuerySuffix = stripNonceParam(rawQuery);
        writeReturnToAppRedirect(client.getOutputStream());
        stop();
        listener.onOAuthCallbackReceived(sanitizedQuerySuffix);
        return true;
    }

    static String extractDecodedQueryParam(String rawQuery, String key) {
        if (rawQuery == null || rawQuery.isEmpty() || key == null) return null;
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String rawName = eq >= 0 ? pair.substring(0, eq) : pair;
            String rawVal = eq >= 0 ? pair.substring(eq + 1) : "";
            if (key.equals(urlDecode(rawName))) {
                return urlDecode(rawVal);
            }
        }
        return null;
    }

    static String stripNonceParam(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String rawName = eq >= 0 ? pair.substring(0, eq) : pair;
            String rawVal = eq >= 0 ? pair.substring(eq + 1) : "";
            String key = urlDecode(rawName);
            String safePair = null;
            if ("code".equals(key) && rawVal.matches("[A-Za-z0-9._~%-]{1,512}")) {
                safePair = "code=" + rawVal;
            } else if ("error".equals(key) && rawVal.matches("[A-Za-z0-9._~%-]{1,128}")) {
                safePair = "error=" + rawVal;
            } else if ("next".equals(key) && isSafeRelativeNextParam(rawVal)) {
                safePair = "next=" + rawVal;
            }
            if (safePair == null) {
                continue;
            }
            if (out.length() == 0) {
                out.append('?');
            } else {
                out.append('&');
            }
            out.append(safePair);
        }
        return out.toString();
    }

    private static boolean isSafeRelativeNextParam(String rawVal) {
        if (rawVal == null || rawVal.isEmpty() || rawVal.length() > 256) {
            return false;
        }
        if (!rawVal.matches("[A-Za-z0-9._~/%-]{1,256}")) {
            return false;
        }
        String decoded = urlDecode(rawVal);
        return decoded.startsWith("/")
                && !decoded.startsWith("//")
                && !decoded.contains("\\")
                && !decoded.contains("\r")
                && !decoded.contains("\n");
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception ex) {
            return value;
        }
    }

    private static void writeNoContent(OutputStream out) throws IOException {
        String resp = "HTTP/1.1 204 No Content\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static void writePlainResponse(
            OutputStream out, String status, String bodyText) throws IOException {
        byte[] body = bodyText.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static void writeReturnToAppRedirect(OutputStream out) throws IOException {
        String html = "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<meta http-equiv=\"refresh\" content=\"0;url=" + APP_RETURN_URI + "\">"
                + "<title>ViRead</title>"
                + "<style>body{font-family:system-ui,sans-serif;background:#F6FAF8;color:#153A53;"
                + "display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;padding:24px;}"
                + ".card{background:#fff;border:1px solid #CEDED8;border-radius:20px;padding:28px;max-width:360px;text-align:center;}"
                + "a{display:inline-block;margin-top:16px;padding:12px 20px;background:#087467;color:#fff;"
                + "text-decoration:none;border-radius:12px;font-weight:700;}</style></head>"
                + "<body><div class=\"card\"><h2>Đã xác thực tài khoản</h2>"
                + "<p>Đang quay lại ứng dụng ViRead...</p>"
                + "<a href=\"" + APP_RETURN_INTENT_URI + "\">Mở lại ứng dụng ViRead</a>"
                + "</div><script>window.location.replace('" + APP_RETURN_URI + "');</script></body></html>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 302 Found\r\n"
                + "Location: " + APP_RETURN_URI + "\r\n"
                + "Content-Type: text/html; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
