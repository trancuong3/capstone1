import type { MessageTree } from "@/lib/i18n/types";

export const offlinePackVi = {
  controls: {
    downloadSingle: "Tải đọc ngoại tuyến",
    downloadingSingle: "Đang tải gói ngoại tuyến...",
    downloadedBadge: "Đã tải ngoại tuyến",
    redownloadSingle: "Cập nhật gói ngoại tuyến",
    deletePack: "Xóa gói ngoại tuyến",
    deletingPack: "Đang xóa...",
    openOfflineNow: "Đọc ngoại tuyến ngay",
    weeklyPlanTitle: "Gói đọc ngoại tuyến tuần này",
    weeklyPlanSubtitle:
      "Tải trước tối đa 3 cuốn trong kế hoạch tuần để bé đọc mượt khi không có mạng.",
    downloadWeeklyPack: "Tải gói đọc tuần này",
    downloadingWeeklyPack: "Đang tải gói tuần ({done}/{total})...",
    weeklyPackReadyCount: "Đã sẵn sàng {count}/{total} sách tuần này",
    noWeeklyBooksHint:
      "Chọn sách trong kế hoạch đọc để tải gói đọc tuần này (tối đa 3 cuốn).",
    sizeEstimate: "Ước tính ~{sizeMb} MB",
    storedSize: "Đã lưu {sizeMb} MB · {pages} trang",
    privateIsolationNote:
      "Lưu riêng theo tài khoản phụ huynh & hồ sơ bé; tự động xóa sạch khi đăng xuất.",
    childRequiredHint: "Chọn hồ sơ của bé để tải gói đọc ngoại tuyến.",
    downloadError:
      "Chưa tải được gói đọc ngoại tuyến. Ba mẹ kiểm tra kết nối mạng rồi thử lại nhé.",
  },
  wasmStt: {
    ready: "Nhận diện giọng nói ngoại tuyến (WASM): Sẵn sàng",
    cachedPartial: "Bộ nhận diện ngoại tuyến: Đã tải {done}/{total} tệp",
    notDownloaded: "Nhận diện ngoại tuyến (~34 MB): Chưa tải sẵn",
    warming: "Đang chuẩn bị bộ nhận diện giọng nói ngoại tuyến...",
    warmButton: "Tải sẵn nhận diện giọng nói",
    unsupported: "Thiết bị này dùng chế độ nghe & đánh vần ngoại tuyến",
  },
  outbox: {
    syncing: "Đang đồng bộ ({count})",
    synced: "Đã đồng bộ xong",
    pendingOffline: "Chờ mạng để đồng bộ ({count})",
    syncError: "Tạm chờ đồng bộ lại ({count})",
    syncNowButton: "Đồng bộ ngay",
  },
  reader: {
    offlineBannerTitle: "Chế độ đọc ngoại tuyến",
    offlineBannerBody:
      "Đang mở từ gói đọc đã tải cho {alias}. Lượt đọc và đánh vần sẽ tự đồng bộ khi có mạng lại.",
    offlineAudioUnavailable:
      "Trang này chưa có tiếng đọc mẫu ngoại tuyến. Bé vẫn có thể tự đọc và chạm từ để xem đánh vần nhé.",
    offlineAttemptSaved:
      "Đã lưu lượt đọc ngoại tuyến của con. Hệ thống sẽ tự đồng bộ khi có mạng.",
  },
} as const satisfies MessageTree;

export const offlinePackEn = {
  controls: {
    downloadSingle: "Download for offline reading",
    downloadingSingle: "Downloading offline pack...",
    downloadedBadge: "Available offline",
    redownloadSingle: "Refresh offline pack",
    deletePack: "Delete offline pack",
    deletingPack: "Removing...",
    openOfflineNow: "Read offline now",
    weeklyPlanTitle: "This week's offline reading pack",
    weeklyPlanSubtitle:
      "Pre-download up to 3 books from this week's reading plan for Airplane Mode.",
    downloadWeeklyPack: "Download this week's pack",
    downloadingWeeklyPack: "Downloading weekly pack ({done}/{total})...",
    weeklyPackReadyCount: "{count}/{total} weekly books ready offline",
    noWeeklyBooksHint:
      "Link books in your reading plans to pre-download up to 3 books for the week.",
    sizeEstimate: "Est. ~{sizeMb} MB",
    storedSize: "Stored {sizeMb} MB · {pages} pages",
    privateIsolationNote:
      "Strictly isolated per parent & child profile; automatically wiped on sign-out.",
    childRequiredHint: "Select a child profile to download an offline pack.",
    downloadError:
      "Could not download the offline reading pack. Please check your connection and retry.",
  },
  wasmStt: {
    ready: "Offline speech recognition (WASM): Ready",
    cachedPartial: "Offline speech model: {done}/{total} files cached",
    notDownloaded: "Offline speech model (~34 MB): Not cached yet",
    warming: "Preparing offline speech recognition...",
    warmButton: "Preload offline speech model",
    unsupported: "Listen & phonics mode available offline on this device",
  },
  outbox: {
    syncing: "Syncing ({count})",
    synced: "All synced",
    pendingOffline: "Queued for sync ({count})",
    syncError: "Will retry sync ({count})",
    syncNowButton: "Sync now",
  },
  reader: {
    offlineBannerTitle: "Offline reading mode",
    offlineBannerBody:
      "Loaded from {alias}'s downloaded pack. Reading progress will sync automatically once online.",
    offlineAudioUnavailable:
      "Sample audio wasn't pre-cached for this page. Your child can still read aloud and tap words for phonics.",
    offlineAttemptSaved:
      "Saved offline reading progress. It will sync automatically when back online.",
  },
} as const satisfies MessageTree;
