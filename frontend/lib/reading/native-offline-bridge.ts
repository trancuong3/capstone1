/**
 * Exact-origin WebView bridge wrapper for Android `ViReadNativeOffline` (#3).
 * Never uses `@JavascriptInterface`; relies strictly on `WebViewCompat.addWebMessageListener`.
 */

export interface AndroidOfflinePackSummary {
  readonly bookId: string;
  readonly title: string;
  readonly pageCount: number;
  readonly savedAt: string;
}

interface WebMessagePortLike {
  postMessage: (message: string) => void;
  addEventListener?: (
    type: "message",
    listener: (event: MessageEvent<string>) => void,
  ) => void;
  removeEventListener?: (
    type: "message",
    listener: (event: MessageEvent<string>) => void,
  ) => void;
}

function getNativeOfflineBridge(): WebMessagePortLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (
    window as unknown as { ViReadNativeOffline?: WebMessagePortLike }
  ).ViReadNativeOffline;
  if (candidate && typeof candidate.postMessage === "function") {
    return candidate;
  }
  return null;
}

export function isAndroidNativeOfflineBridgeAvailable(): boolean {
  return getNativeOfflineBridge() !== null;
}

export async function syncAndroidOfflinePackMeta(
  userId: string,
  packs: readonly AndroidOfflinePackSummary[],
): Promise<boolean> {
  const bridge = getNativeOfflineBridge();
  if (!bridge || !userId.trim()) return false;
  try {
    bridge.postMessage(
      JSON.stringify({
        requestId: `offline-sync-${Date.now()}`,
        action: "syncPacks",
        userId: userId.trim(),
        packs: packs.slice(0, 40).map((item) => ({
          bookId: item.bookId,
          title: item.title.slice(0, 140),
          pageCount: item.pageCount,
          savedAt: item.savedAt,
        })),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearAndroidOfflinePacks(): Promise<void> {
  const bridge = getNativeOfflineBridge();
  if (!bridge) return;
  try {
    bridge.postMessage(
      JSON.stringify({
        requestId: `offline-clear-${Date.now()}`,
        action: "clearPacks",
      }),
    );
  } catch {
    // Safe ignore outside Android shell.
  }
}
