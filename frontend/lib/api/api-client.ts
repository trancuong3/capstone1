import type { ZodType } from "zod";

import { readingManagementMessageKeys } from "@/lib/api/reading-management-messages";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { clearApiReadCache, runCoalescedApiGet } from "@/lib/api/read-cache";
import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary, TranslationParams } from "@/lib/i18n/types";
import { getApiBaseUrl } from "@/lib/supabase/config";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

function resolveExplicitLocale(): SupportedLocale | null {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang);
  }
  return null;
}

function getActiveLocale(): SupportedLocale {
  return resolveExplicitLocale() ?? DEFAULT_LOCALE;
}

function tApiError(key: string, params?: TranslationParams): string {
  const locale = getActiveLocale();
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(activeMessages, viMessages, locale, key, params);
}

// Only deliberately authored backend details are shown to users. Unknown server
// messages may contain SQL, tokens, file paths, or other private diagnostic data.
const safeBackendMessageKeys: Record<string, string> = {
  "Copyright scanner is not configured. Admin must confirm rights before approving this book.":
    "errors.backend.copyrightScannerNotConfigured",
  "Book approval requires current OCR, Proofreading and Child Safety results on every active page.":
    "errors.backend.bookApprovalRequiresCurrentChecks",
  "High severity or NOT_RECOMMENDED content is blocked by the current child access policy.":
    "errors.backend.highSeverityContentBlocked",
  "A page Safety result is stale or incomplete.":
    "errors.backend.pageSafetyStaleOrIncomplete",
  "A category is required for a false-positive decision.":
    "errors.backend.falsePositiveCategoryRequired",
  "Resolve Child Safety findings and REVIEW_REQUIRED pages before approving this book.":
    "errors.backend.resolveFindingsBeforeApprove",
  "Bạn đã gửi nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.":
    "errors.backend.reportRateLimited",
  "Trang chưa có nội dung VERIFIED để lưu snapshot báo cáo.":
    "errors.backend.reportVerifiedSnapshotMissing",
  "Cần ghi chú xử lý khi giải quyết hoặc từ chối báo cáo.":
    "errors.backend.reportResolutionNoteRequired",
  "Cần tạo và xác minh revision mới cho trang được báo lỗi trước khi giải quyết báo cáo.":
    "errors.backend.reportNeedsNewVerifiedRevision",
  "Revision hiện tại chưa được xác minh; chưa thể giải quyết báo cáo.":
    "errors.backend.reportCurrentRevisionUnverified",
  "Cần ghi chú khi mở lại báo cáo đã đóng.":
    "errors.backend.reportReopenNoteRequired",
  "Cần ghi lý do khi bỏ qua cảnh báo.":
    "errors.backend.dismissFindingReasonRequired",
  "Revision nguồn đã thay đổi; finding đã được chuyển sang STALE.":
    "errors.backend.sourceRevisionChangedStale",
  "Chỉ đánh dấu đã sửa sau khi một revision VERIFIED mới được xuất bản.":
    "errors.backend.markFixedRequiresNewVerified",
  AI_AUTO_VERIFY_DISABLED: "errors.backend.aiAutoVerifyDisabled",
  WORKFLOW_REQUIRED: "errors.backend.workflowRequired",
  WORKFLOW_REVISION_MISMATCH: "errors.backend.workflowRevisionMismatch",
  WORKFLOW_NOT_FOUND: "errors.backend.workflowNotFound",
  IMAGE_REVISION_MISMATCH: "errors.backend.imageRevisionMismatch",
  CANDIDATE_HASH_MISMATCH: "errors.backend.candidateHashMismatch",
  WORKFLOW_NOT_READY: "errors.backend.workflowNotReady",
  TEXT_SAFETY_INCOMPLETE_CHUNKS: "errors.backend.textSafetyIncompleteChunks",
  TEXT_SAFETY_NOT_READY: "errors.backend.textSafetyNotReady",
  TEXT_SAFETY_HIGH_RISK_BLOCKED: "errors.backend.textSafetyHighRiskBlocked",
  IMAGE_SAFETY_UNASSESSED: "errors.backend.imageSafetyUnassessed",
  IMAGE_SAFETY_FLAGGED_UNSAFE: "errors.backend.imageSafetyFlaggedUnsafe",
  IMAGE_SAFETY_STALE: "errors.backend.imageSafetyStale",
  IMAGE_SAFETY_REASON_REQUIRED: "errors.backend.imageSafetyReasonRequired",
  SAFETY_REVIEW_REASON_REQUIRED: "errors.backend.safetyReviewReasonRequired",
  RIGHTS_EVIDENCE_REQUIRED: "errors.backend.rightsEvidenceRequired",
  RIGHTS_CONCERN_BLOCKED: "errors.backend.rightsConcernBlocked",
  RIGHTS_EVIDENCE_STALE: "errors.backend.rightsEvidenceStale",
  RIGHTS_VERSION_MISMATCH: "errors.backend.rightsVersionMismatch",
  RIGHTS_EVIDENCE_INCOMPLETE: "errors.backend.rightsEvidenceIncomplete",
  RIGHTS_CONCERN_NOTE_REQUIRED: "errors.backend.rightsConcernNoteRequired",
  RIGHTS_PAGE_ID_REQUIRED: "errors.backend.rightsPageIdRequired",
  RIGHTS_BOOK_SCOPE_PAGE_FORBIDDEN:
    "errors.backend.rightsBookScopePageForbidden",
  ...readingManagementMessageKeys,
  INSUFFICIENT_CONTENT: "errors.backend.insufficientContent",
  SESSION_NOT_ACTIVE: "errors.backend.sessionNotActive",
  ROUND_NOT_ACTIVE: "errors.backend.roundNotActive",
  ROUND_NOT_COMPLETE: "errors.backend.roundNotComplete",
  TOKEN_ALREADY_USED: "errors.backend.tokenAlreadyUsed",
  TOKEN_NOT_IN_SESSION: "errors.backend.tokenNotInSession",
  INVALID_IMAGE: "errors.backend.invalidImage",
  IMAGE_FILE_REQUIRED: "errors.backend.imageFileRequired",
  INVALID_SAMPLE: "errors.backend.invalidSample",
  BOOK_PAGE_REQUIRED: "errors.backend.bookPageRequired",
  UNSAFE_PICTURE: "errors.backend.unsafePicture",
  AI_NOT_CONFIGURED: "errors.backend.aiNotConfigured",
  AI_AUTH_FAILED: "errors.backend.aiAuthFailed",
  AI_RATE_LIMITED: "errors.backend.aiRateLimited",
  AI_TIMEOUT: "errors.backend.aiTimeout",
  AI_UNAVAILABLE: "errors.backend.aiUnavailable",
  SAMPLE_IMAGE_UNAVAILABLE: "errors.backend.sampleImageUnavailable",
  "Supabase Storage is not configured": "errors.backend.storageNotConfigured",
  "Server-side Supabase Storage credentials are not configured":
    "errors.backend.storageCredentialsMissing",
  "Supabase Storage client initialization failed; check the server configuration":
    "errors.backend.storageInitFailed",
  "Supabase Storage is unavailable": "errors.backend.storageUnavailable",
  "Could not save the image to Supabase Storage":
    "errors.backend.storageSaveFailed",
  "Supabase Storage bucket was not found; verify SUPABASE_STORAGE_BUCKET in the configured project":
    "errors.backend.storageBucketNotFound",
  "Supabase Storage rejected the server credentials or upload permission":
    "errors.backend.storageUploadRejected",
  "Tesseract OCR 5.x is not installed or TESSERACT_CMD is invalid":
    "errors.backend.tesseractNotInstalled",
  "Tesseract language data vie.traineddata is missing":
    "errors.backend.tesseractLangMissing",
  "Tesseract is unavailable; install Tesseract 5.x and its language data":
    "errors.backend.tesseractUnavailable",
  "Tesseract failed to process the image with Vietnamese language data":
    "errors.backend.tesseractFailed",
  "OCR processing failed; check the local OCR configuration":
    "errors.backend.ocrProcessingFailed",
  "No usable text was detected; check the image quality":
    "errors.backend.ocrNoUsableText",
  "Local OCR engine is unavailable": "errors.backend.localOcrUnavailable",
  "Local OCR processing timed out; please retry":
    "errors.backend.localOcrTimeout",
  "Unsupported upload format; use JPEG, PNG, or WebP":
    "errors.backend.unsupportedUploadFormat",
  "Upload identity already belongs to a different image":
    "errors.backend.uploadIdentityConflict",
  "Could not read the image from Supabase Storage":
    "errors.backend.storageReadImageFailed",
  "Could not create an image preview URL":
    "errors.backend.storagePreviewUrlFailed",
  "Page has no revision yet": "errors.backend.pageNoRevisionYet",
  "Page not found": "errors.backend.pageNotFound",
  "Cannot edit a retired page": "errors.backend.cannotEditRetiredPage",
  "Page has no current verified revision":
    "errors.backend.pageNoVerifiedRevision",
  "The verified revision changed; reload the page before creating a draft":
    "errors.backend.verifiedRevisionChanged",
  "A revision is already awaiting review; finish or reload it before creating another draft":
    "errors.backend.revisionAlreadyAwaitingReview",
  "Current verified revision is not available":
    "errors.backend.currentVerifiedRevisionUnavailable",
  "Current verified revision has no editable word data":
    "errors.backend.currentVerifiedMissingWordData",
  "Current verified text and word data are inconsistent":
    "errors.backend.currentVerifiedTextInconsistent",
  "Stored word coordinates cannot be copied safely":
    "errors.backend.storedCoordinatesInvalid",
  "Stored OCR word ordering cannot be copied safely":
    "errors.backend.storedWordOrderInvalid",
  "Stored OCR confidence cannot be copied safely":
    "errors.backend.storedConfidenceInvalid",
  "A concurrent edit created this revision number; retry":
    "errors.backend.concurrentEditRevision",
  "A concurrent OCR revision was created; reload and retry":
    "errors.backend.concurrentOcrRevision",
  "Admin access required": "errors.backend.adminAccessRequired",
  "Stored bounding box does not match the OCR contract":
    "errors.backend.storedBoundingBoxInvalid",
  "The source page image is unavailable for visual OCR verification.":
    "errors.backend.sourcePageImageUnavailable",
  "AI OCR chỉ chấp nhận địa chỉ HTTP loopback trên máy chủ.":
    "errors.backend.aiOcrLoopbackOnly",
  "Cấu hình AI OCR cục bộ chưa hợp lệ.": "errors.backend.aiOcrConfigInvalid",
  "AI OCR chỉ sử dụng địa chỉ HTTP loopback trên máy chủ.":
    "errors.backend.aiOcrLoopbackOnly",
  "Ollama cục bộ chưa phản hồi.": "errors.backend.ollamaNotResponding",
  "Model AI OCR cục bộ chưa được cài đặt.":
    "errors.backend.ollamaModelNotInstalled",
  "Không thể kết nối tới Ollama cục bộ.":
    "errors.backend.ollamaConnectionFailed",
  "Ollama hoặc model OCR cục bộ chưa sẵn sàng; văn bản hiện tại được giữ nguyên.":
    "errors.backend.ollamaOrModelNotReady",
  "Không thể kết nối Ollama trên máy này; văn bản hiện tại được giữ nguyên.":
    "errors.backend.ollamaCannotConnectKeepCurrent",
  "AI OCR cục bộ hết thời gian xử lý; văn bản hiện tại được giữ nguyên.":
    "errors.backend.aiOcrTimeoutKeepCurrent",
  "AI OCR cục bộ vượt quá thời gian xử lý tối đa; văn bản hiện tại được giữ nguyên.":
    "errors.backend.aiOcrMaxDurationKeepCurrent",
  "AI OCR đang xử lý quá nhiều yêu cầu. Hãy đợi tác vụ hiện tại hoàn tất rồi thử lại.":
    "errors.backend.aiOcrBusy",
  "AI OCR job not found": "errors.backend.aiOcrJobNotFound",
  "Model OCR cục bộ trả kết quả không đầy đủ hoặc sai cấu trúc; nội dung hiện tại được giữ nguyên.":
    "errors.backend.aiOcrMalformedResponse",
  "Draft text and OCR word data are inconsistent":
    "errors.backend.draftTextWordsInconsistent",
  "Stored image reference is invalid":
    "errors.backend.storedImageReferenceInvalid",
  "Image metadata does not match the admin contract":
    "errors.backend.imageMetadataContractMismatch",
  "Page list contract is not available yet":
    "errors.backend.pageListContractMismatch",
  "Revision contract is not available yet":
    "errors.backend.revisionContractMismatch",
  "Page contract is not available yet": "errors.backend.pageContractMismatch",
  "Page status contract is not available yet":
    "errors.backend.pageStatusContractMismatch",
  "Revision number contract is not available yet":
    "errors.backend.revisionNumberContractMismatch",
  "Book contract is not available yet": "errors.backend.bookContractMismatch",
  "Catalog contract is not available yet":
    "errors.backend.catalogContractMismatch",
  "The stored image is not a Storage object path":
    "errors.backend.storedImageNotStoragePath",
  "OCR did not produce any valid word": "errors.backend.ocrNoValidWords",
  "OCR engine returned an invalid bounding box":
    "errors.backend.ocrInvalidBoundingBox",
  "OCR engine returned a bounding box outside the image":
    "errors.backend.ocrBoundingBoxOutOfBounds",
  "This page number already exists for the book":
    "errors.backend.pageNumberAlreadyExists",
  "Cannot upload pages to a retired book":
    "errors.backend.cannotUploadToRetiredBook",
  "Book not found": "errors.backend.bookNotFound",
  "Only revisions with status NEEDS_REVIEW can be verified":
    "errors.backend.onlyNeedsReviewVerify",
  "Only revisions with status NEEDS_REVIEW can be edited":
    "errors.backend.onlyNeedsReviewEdit",
  "Page has no revision to reprocess":
    "errors.backend.pageNoRevisionToReprocess",
  "Reprocess requires the latest revision; refresh the page history":
    "errors.backend.reprocessRequiresLatestRevision",
  "page_number is out of range": "errors.backend.pageNumberOutOfRange",
  "Image decoding failed": "errors.backend.imageDecodingFailed",
  "Image dimensions are invalid": "errors.backend.imageDimensionsInvalid",
  "A file is required": "errors.backend.fileRequired",
  "Document exceeds the 50 MB limit": "errors.backend.documentExceeds50Mb",
  "Image exceeds the 12 MB limit": "errors.backend.imageExceeds12Mb",
  "Image dimensions must not exceed 6000 by 6000 pixels":
    "errors.backend.imageDimensionsExceed6000",
  "Document exceeds the 30-page limit per upload":
    "errors.backend.documentExceeds30Pages",
  "Password-protected PDF files are not supported":
    "errors.backend.passwordProtectedPdf",
  "Password-protected documents are not supported":
    "errors.backend.passwordProtectedDoc",
  "Legacy .doc files are not supported; convert to .docx or .pdf":
    "errors.backend.legacyDocUnsupported",
  "Macro-enabled Word documents are not permitted":
    "errors.backend.macroWordNotPermitted",
  "Archive structure exceeds safe extraction limits":
    "errors.backend.archiveUnsafeLimits",
  "Document XML contains unsafe declarations":
    "errors.backend.documentXmlUnsafe",
  "Unsupported upload format; use JPEG, PNG, WebP, BMP, TIFF, PDF, or DOCX":
    "errors.backend.unsupportedDocumentOrImageFormat",
  "File content does not match the declared file type or extension":
    "errors.backend.fileContentMismatch",
  "Weights file must end with .pth or .pt":
    "errors.backend.weightsInvalidExtension",
  "Checkpoint file magic bytes are invalid; expected PyTorch .pth/.pt format":
    "errors.backend.checkpointMagicInvalid",
  "Checkpoint shard exceeds 40 MiB": "errors.backend.checkpointShardTooLarge",
  "Comparison JSON file must be between 1 byte and 2 MiB":
    "errors.backend.comparisonJsonSizeInvalid",
  "Comparison file must be valid UTF-8 JSON":
    "errors.backend.comparisonJsonUtf8Invalid",
  "Comparison JSON must be an object": "errors.backend.comparisonJsonNotObject",
  "Comparison JSON missing 'models' object":
    "errors.backend.comparisonJsonMissingModels",
  "Comparison JSON must define 'baseline' and at least one fine-tuned model":
    "errors.backend.comparisonJsonMissingBaseline",
  "Comparison JSON must contain at least one dataset block with cer_pct and wer_pct":
    "errors.backend.comparisonJsonMissingDataset",
  "Configuration file must have a .yml or .yaml extension":
    "errors.backend.configFileExtensionInvalid",
  "Configuration file exceeds 1 MiB": "errors.backend.configFileTooLarge",
  "Configuration YAML syntax is invalid": "errors.backend.configYamlInvalid",
  "Configuration YAML must be a non-empty mapping":
    "errors.backend.configYamlNotMapping",
  "Checkpoint shard failed integrity verification":
    "errors.backend.checkpointIntegrityFailed",
  "Checkpoint and configuration are identical to the currently active model":
    "errors.backend.checkpointIdentical",
  "The uploaded document is empty or corrupted":
    "errors.backend.uploadedDocumentEmpty",
  "No usable text was detected in the uploaded document":
    "errors.backend.uploadedDocumentNoText",
  "Document upload failed to produce any valid OCR page":
    "errors.backend.uploadedDocumentNoPages",
  "Server Unicode font for DOCX rendering is unavailable":
    "errors.backend.serverDocxFontMissing",
  "PDF rendering engine is not available on the server":
    "errors.backend.serverPdfEngineUnavailable",
  DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE:
    "errors.backend.difficultWordStorageUnavailable",
  DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED:
    "errors.backend.difficultWordAlreadyCompleted",
  DIFFICULT_WORD_ATTEMPT_NOT_FOUND:
    "errors.backend.difficultWordAttemptNotFound",
  INVALID_PRACTICE_WORD: "errors.backend.invalidPracticeWord",
  EMPTY_AUDIO: "errors.backend.emptyAudio",
  AUDIO_TOO_LARGE: "errors.backend.audioTooLarge",
  UNSUPPORTED_AUDIO: "errors.backend.unsupportedAudio",
  "Khóa idempotency không hợp lệ.": "errors.backend.invalidIdempotencyKey",
  "Loại nguồn sử dụng không hợp lệ.": "errors.backend.invalidSourceUsageType",
  "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể tải thêm trang.":
    "errors.backend.privateBookSuspendedUpload",
  "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.":
    "errors.backend.privateBookSuspended",
  "Phiên bản trang đã thay đổi. Hãy tải lại trước khi chấp nhận chính tả.":
    "errors.backend.pageVersionChangedProofread",
  "Bước rà chính tả chưa hoàn tất.": "errors.backend.proofreadNotCompleted",
  "Không thể chỉnh sửa bản nộp đã hoàn tất hoặc đã hủy.":
    "errors.backend.cannotEditCompletedSubmission",
  "Phiên bản trang vừa thay đổi. Hãy tải lại.":
    "errors.backend.pageVersionJustChanged",
  "Khi thay ảnh cho một trang cụ thể, hãy chọn đúng 1 ảnh hoặc tài liệu 1 trang.":
    "errors.backend.replaceSinglePageRule",
  "Chỉ có thể thử lại các trang đang ở trạng thái kiểm tra lỗi hoặc cần kiểm tra lại.":
    "errors.backend.retryOnlyErrorOrReview",
  "Không thể hủy trang đã thêm vào sách.":
    "errors.backend.cannotCancelCommittedPage",
  "Phiên bản trang không khớp snapshot hiện tại. Hãy tải lại trước khi gửi Admin.":
    "errors.backend.pageSnapshotMismatchAdmin",
  "Chỉ trang đang ở trạng thái Cần Admin duyệt mới có thể gửi yêu cầu xem xét.":
    "errors.backend.onlyNeedsAdminReview",
  "Phiên bản hoặc hash của trang không khớp kết quả kiểm tra hiện hành.":
    "errors.backend.pageVersionHashMismatch",
  "Trang có nội dung vi phạm mức chặn theo chính sách an toàn trẻ em nên không thể thêm vào sách.":
    "errors.backend.blockedBySafetyPolicy",
  "Trang chưa hoàn tất sạch OCR, rà chính tả và Tool Check cho đúng phiên bản hiện tại.":
    "errors.backend.pageNotCleanForCommit",
  "Vui lòng xem và chấp nhận đề xuất chính tả trước khi thêm trang vào sách.":
    "errors.backend.acceptProofreadBeforeCommit",
  "Phê duyệt của Admin không khớp đúng phiên bản/hash hiện tại của trang.":
    "errors.backend.adminApprovalVersionMismatch",
  "Không tìm thấy quyết định phê duyệt hợp lệ của Admin cho đúng phiên bản này.":
    "errors.backend.adminApprovalNotFound",
  "Trang đang chờ kiểm tra, bị gắn cờ hoặc chưa được Admin phê duyệt nên không thể thêm vào sách.":
    "errors.backend.pageNotApprovedYet",
  "Phiên bản trang đã thay đổi hoặc vừa được Admin khác xử lý. Hãy tải lại dữ liệu trước khi quyết định.":
    "errors.backend.adminConcurrentDecision",
  "Không thể phê duyệt trang của sách đang bị đình chỉ.":
    "errors.backend.cannotApproveSuspendedBookPage",
  "Nội dung vi phạm mức chặn theo chính sách an toàn trẻ em không thể duyệt trực tiếp; phải yêu cầu chỉnh sửa hoặc từ chối.":
    "errors.backend.cannotDirectApproveBlockedContent",
  "Trang hiện không ở trạng thái chờ Admin phê duyệt.":
    "errors.backend.pageNotAwaitingAdminReview",
  "Sách riêng đang bị đình chỉ hoặc không còn khả dụng.":
    "errors.backend.privateBookSuspendedOrUnavailable",
};

const safeFlow2BackendMessages: Readonly<Record<string, string>> = {
  DRIVE_QUOTA_EXCEEDED:
    "Dung lượng Google Drive miễn phí sắp chạm ngưỡng an toàn. Hãy dọn Thùng rác Drive hoặc xóa snapshot/run cũ trước khi tiếp tục.",
  DRIVE_ACCOUNT_EMAIL_MISMATCH:
    "Tài khoản Google vừa chọn không khớp tài khoản chủ sở hữu Drive được khóa trên server.",
  DRIVE_BRIDGE_ACCESS_DENIED:
    "Apps Script Web App đang chặn truy cập. Trong script.google.com hãy Deploy lại với 'Who has access: Anyone' (bảo vệ bằng HMAC-SHA256).",
  DRIVE_BRIDGE_SECRET_NOT_SET:
    "Chưa cài VIREAD_BRIDGE_SECRET trong Script Properties của Apps Script Bridge.",
  DRIVE_AUTH_FAILED:
    "Xác thực chữ ký Apps Script Bridge hoặc phiên Google Drive thất bại. Hãy kiểm tra lại VIREAD_BRIDGE_SECRET.",
  DRIVE_ENCRYPTION_KEY_MISSING:
    "Server chưa cấu hình đủ VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY (>= 32 ký tự).",
  GOOGLE_DRIVE_DESKTOP_UNAVAILABLE_ON_CLOUD_SERVER:
    "Cloud server (Render) không thể đọc ổ G:\\ trên máy cá nhân; hãy kết nối qua Apps Script Bridge.",
  GOOGLE_DRIVE_DESKTOP_REQUIRES_WINDOWS_HOST:
    "Máy chủ Linux không hỗ trợ Google Drive for Desktop; hãy kết nối qua Apps Script Bridge.",
  FLOW2_INGESTION_PAUSED:
    "Luồng 2 đang tạm dừng thu thập (VIREAD_FLOW2_INGESTION_PAUSED=true).",
  UNRESOLVED_TRAINING_JOB_EXISTS:
    "Đang có một job huấn luyện chưa kết thúc trong hàng đợi; hãy hoàn tất hoặc xử lý job đó trước.",
  TRAIN_AND_VALIDATION_REQUIRED:
    "Dataset Luồng 2 cần có đồng thời cả mẫu train và validation (tối thiểu 2 nhóm sách/trang độc lập).",
  NO_ELIGIBLE_FLOW2_SAMPLES:
    "Chưa có mẫu Luồng 2 sạch nào đủ điều kiện tạo snapshot huấn luyện.",
  "Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive":
    "Cần áp dụng migration 20261121210000_flow2_google_drive_storage.sql trên database trước khi kết nối Google Drive.",
  "A queued or running training job cannot be deleted":
    "Không thể xóa job đang chờ worker hoặc đang chạy.",
  "Only a pre-run failure or an unbenchmarked candidate with a recoverable Colab error can be retried":
    "Chỉ có thể thử lại job lỗi trước khi tạo run hoặc candidate Colab có lỗi có thể khôi phục.",
  "The pinned Locked Test is missing or no longer meets its integrity requirements":
    "Locked Test gắn với job bị thiếu hoặc không còn đạt chuẩn toàn vẹn.",
  "Locked Test is not ready":
    "Locked Test chưa sẵn sàng hoặc chưa đủ số lượng mẫu/nhóm độc lập.",
  "The active model has changed since this training job was created":
    "Model active trên hệ thống đã đổi kể từ khi job này được tạo.",
  "Another training job is already active":
    "Đang có một job huấn luyện hoặc đánh giá khác đang hoạt động.",
  "Candidate evaluation is already running or queued":
    "Job đánh giá candidate này đã được xếp hàng hoặc đang chạy.",
  "Pilot holdout does not meet minimum samples or groups":
    "Tập holdout sạch chưa đạt mức tối thiểu 20 mẫu và 5 nhóm sách/trang độc lập để chạy Pilot.",
  "Remote OCR worker is offline; live page scan is temporarily unavailable.":
    "Máy chủ OCR Windows hiện đang ngoại tuyến nên tính năng quét trang trực tiếp tạm thời không khả dụng. Ba mẹ hãy bật máy trạm OCR hoặc chọn sách trong Thư viện nhé.",
  "Remote OCR worker is offline; cannot run synchronous page OCR":
    "Máy chủ OCR Windows đang ngoại tuyến; chưa thể chạy nhận diện OCR đồng bộ lúc này. Hãy bật máy trạm OCR rồi thử lại.",
  "Remote OCR worker is offline; cannot run synchronous replacement OCR":
    "Máy chủ OCR Windows đang ngoại tuyến; chưa thể thay ảnh và chạy OCR đồng bộ lúc này. Hãy bật máy trạm OCR rồi thử lại.",
  "Remote OCR worker is offline; cannot reprocess page synchronously":
    "Máy chủ OCR Windows đang ngoại tuyến; chưa thể chạy lại OCR đồng bộ lúc này. Hãy bật máy trạm OCR rồi thử lại.",
  "Remote OCR worker did not finish before sync timeout; poll job status asynchronously.":
    "Máy chủ OCR xử lý lâu hơn thời gian chờ trực tiếp. Tác vụ đã được xếp hàng — vui lòng kiểm tra lại trạng thái sau ít giây.",
  "Remote OCR worker failed":
    "Máy chủ OCR gặp sự cố khi nhận diện trang. Vui lòng thử lại sau ít giây.",
  "Database temporarily unavailable":
    "Hệ thống dữ liệu tạm thời đang bận. Vui lòng thử lại sau vài giây.",
  "Database temporarily unavailable; please retry":
    "Hệ thống dữ liệu tạm thời đang bận. Vui lòng thử lại sau vài giây.",
  "Idempotency key already used for a different OCR payload.":
    "Mã gửi ảnh đã dùng cho một ảnh khác. Hãy chọn lại ảnh để quét mới.",
  "OCR inference job not found.":
    "Không tìm thấy tác vụ OCR hoặc tác vụ đã hết hạn.",
  "Scan OCR job not found":
    "Không tìm thấy tác vụ quét trang sách hoặc tác vụ đã hết hạn.",
};

const SAFE_BACKEND_PREFIX_CODES = [
  "DRIVE_QUOTA_EXCEEDED",
  "DRIVE_ACCOUNT_EMAIL_MISMATCH",
  "DRIVE_BRIDGE_ACCESS_DENIED",
  "DRIVE_BRIDGE_SECRET_NOT_SET",
  "DRIVE_AUTH_FAILED",
  "DRIVE_ENCRYPTION_KEY_MISSING",
  "GOOGLE_DRIVE_DESKTOP_UNAVAILABLE_ON_CLOUD_SERVER",
  "GOOGLE_DRIVE_DESKTOP_REQUIRES_WINDOWS_HOST",
  "FLOW2_INGESTION_PAUSED",
  "UNRESOLVED_TRAINING_JOB_EXISTS",
  "TRAIN_AND_VALIDATION_REQUIRED",
  "NO_ELIGIBLE_FLOW2_SAMPLES",
] as const;

function errorCode(status: number): ServiceErrorCode {
  switch (status) {
    case 401:
      return "AUTH_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "RESOURCE_NOT_FOUND";
    case 409:
      return "CONTENT_INACTIVE";
    case 422:
      return "VALIDATION_ERROR";
    default:
      return "NETWORK_ERROR";
  }
}

function failure(
  status: number,
  requestId = "",
  retryable = false,
  message = tApiError("errors.generic"),
) {
  return new ServiceError({
    code: errorCode(status),
    message,
    status,
    request_id: requestId,
    retryable,
  });
}

async function safeBackendMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.clone().json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload
    ) {
      if (typeof payload.detail === "string") {
        const key = safeBackendMessageKeys[payload.detail];
        if (key) return tApiError(key);
        const directFlow2 = safeFlow2BackendMessages[payload.detail];
        if (directFlow2) return directFlow2;
        const matchedCode = SAFE_BACKEND_PREFIX_CODES.find(
          (code) =>
            payload.detail === code ||
            (typeof payload.detail === "string" &&
              payload.detail.startsWith(`${code}:`)),
        );
        return matchedCode
          ? (safeFlow2BackendMessages[matchedCode] ??
              tApiError("errors.generic"))
          : tApiError("errors.generic");
      }
      if (
        typeof payload.detail === "object" &&
        payload.detail !== null &&
        "code" in payload.detail &&
        typeof payload.detail.code === "string"
      ) {
        const key = safeBackendMessageKeys[payload.detail.code];
        return key ? tApiError(key) : tApiError("errors.generic");
      }
    }
  } catch {
    // A non-JSON error body must not be reflected to the browser.
  }
  return tApiError("errors.generic");
}

/** Only public DTOs validated by the supplied schema can reach a component. */
export interface RequestApiOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly bypassCache?: boolean;
  readonly cacheTtlMs?: number;
}

/**
 * Existing GET callers keep their signature; mutations pass RequestApiOptions as
 * argument four.
 */
export async function requestApi<T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
  requestOptions: RequestApiOptions = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw failure(0);
  }

  let token: string;
  try {
    token = await getBrowserAccessToken({
      onUnauthorized: () => failure(401),
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }

  const method = requestOptions.method ?? "GET";
  const executeFetch = async (fetchSignal?: AbortSignal): Promise<T> => {
    let response: Response;
    const isFormDataBody =
      typeof FormData !== "undefined" &&
      requestOptions.body instanceof FormData;
    const explicitLocale = resolveExplicitLocale();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(explicitLocale && explicitLocale !== DEFAULT_LOCALE
        ? { "X-ViRead-Locale": explicitLocale }
        : {}),
    };
    if (requestOptions.body !== undefined && !isFormDataBody) {
      headers["Content-Type"] = "application/json";
    }
    const body =
      requestOptions.body === undefined
        ? undefined
        : isFormDataBody
          ? requestOptions.body
          : JSON.stringify(requestOptions.body);
    try {
      response = await fetch(`${getApiBaseUrl()}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: body as BodyInit } : {}),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: fetchSignal,
      });
    } catch (error) {
      if (fetchSignal?.aborted) throw error;
      throw failure(0, "", true);
    }

    const requestId = response.headers.get("x-request-id") ?? "";
    if (!response.ok) {
      if (response.status === 401) {
        invalidateBrowserTokenCache();
        clearApiReadCache();
      }
      const backendMessage = await safeBackendMessage(response);
      const messageWithCorrelation =
        response.status >= 500 && requestId
          ? tApiError("errors.requestWithId", {
              message: backendMessage,
              requestId,
            })
          : backendMessage;
      throw failure(
        response.status,
        requestId,
        response.status >= 500,
        messageWithCorrelation,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw failure(response.status, requestId);
    }
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      console.error("[API schema validation failed]", {
        issueCount: parsed.error.issues.length,
      });

      throw failure(response.status, requestId);
    }

    return parsed.data;
  };

  if (method !== "GET") {
    clearApiReadCache();
    try {
      return await executeFetch(signal);
    } finally {
      clearApiReadCache();
    }
  }

  return runCoalescedApiGet(path, token, signal, executeFetch, {
    bypassCache: requestOptions.bypassCache,
    cacheTtlMs: requestOptions.cacheTtlMs,
  });
}

export function apiQuery(
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size ? `?${query.toString()}` : "";
}

/**
 * Out-of-scope writes preserve their interface but never report fake success.
 */
export function unavailableOperation(): Promise<never> {
  return Promise.reject(
    new ServiceError({
      code: "NETWORK_ERROR",
      message: tApiError("errors.unavailable"),
      status: 501,
      request_id: "",
      retryable: false,
    }),
  );
}

const activePrivateBlobUrls = new Set<string>();

export function isPrivateApiMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return (
    url.includes("/books/my-books/") ||
    url.includes("/books/admin/quality/user-books/")
  );
}

export function clearPrivateMediaMemoryCache(): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    activePrivateBlobUrls.clear();
    return;
  }
  for (const blobUrl of activePrivateBlobUrls) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Ignore already-revoked object URLs.
    }
  }
  activePrivateBlobUrls.clear();
}

export function revokePrivateBlobUrl(blobUrl: string | null | undefined): void {
  if (!blobUrl) return;
  activePrivateBlobUrls.delete(blobUrl);
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Ignore already-revoked URLs.
    }
  }
}

export function resolvePrivateApiMediaUrl(url: string): string {
  const apiBase = getApiBaseUrl();
  if (url.startsWith("/")) {
    return `${apiBase}${url}`;
  }
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(apiBase);
    const basePrefix = baseParsed.pathname.replace(/\/+$/, "");
    const pathAndQuery = `${parsed.pathname}${parsed.search}`;
    if (basePrefix && pathAndQuery.startsWith(`${basePrefix}/`)) {
      return `${baseParsed.origin}${pathAndQuery}`;
    }
    return `${apiBase}${pathAndQuery}`;
  } catch {
    return url;
  }
}

/**
 * Fetch an authenticated private image through the FastAPI media proxy using
 * the active Bearer session token and `cache: "no-store"`. Never persists to
 * browser storage or shared caches.
 */
export async function fetchAuthenticatedBlobUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  let token: string;
  try {
    token = await getBrowserAccessToken({
      onUnauthorized: () => failure(401),
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }

  const explicitLocale = resolveExplicitLocale();
  const resolvedUrl = resolvePrivateApiMediaUrl(url);
  const response = await fetch(resolvedUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(explicitLocale && explicitLocale !== DEFAULT_LOCALE
        ? { "X-ViRead-Locale": explicitLocale }
        : {}),
    },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    throw failure(response.status);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  activePrivateBlobUrls.add(objectUrl);
  return objectUrl;
}
