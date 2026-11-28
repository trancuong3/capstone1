import type { ZodType } from "zod";

import { readingManagementMessageKeys } from "@/lib/api/reading-management-messages";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
  refreshBrowserAccessToken,
} from "@/lib/api/browser-auth";
import {
  invalidateApiReadCache,
  invalidateApiReadCacheByPrefix,
  runCoalescedApiGet,
} from "@/lib/api/read-cache";
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
  BOOK_BLOCKED_BY_CHILD_SAFETY:
    "Sách này hiện bị chặn theo chính sách an toàn trẻ em nên chưa thể mở đọc.",
  CONTENT_NOT_READY:
    "Nội dung sách chưa sẵn sàng để đọc. Vui lòng thử lại sau khi hoàn tất xử lý.",
  READING_RANGE_NOT_CONTIGUOUS:
    "Khoảng trang đọc cần liên tiếp và bắt đầu từ trang có số nhỏ hơn hoặc bằng trang kết thúc.",
  INVALID_BOOK_METADATA:
    "Thông tin mô tả sách chưa hợp lệ. Vui lòng kiểm tra lại và thử lưu lại.",
  PARENT_CONFLICT:
    "Thông tin tài khoản phụ huynh bị xung đột hoặc đã tồn tại. Vui lòng tải lại trang và kiểm tra lại.",
  AUTH_PROVIDER_UNAVAILABLE:
    "Dịch vụ xác thực đang tạm thời gián đoạn. Vui lòng thử lại sau ít phút.",
  DATABASE_OPERATION_FAILED:
    "Hệ thống dữ liệu đang gặp sự cố tạm thời. Vui lòng thử lại sau.",
  PARENT_AUTH_OPERATION_FAILED:
    "Không thể hoàn tất thao tác xác thực tài khoản phụ huynh lúc này. Vui lòng thử lại sau.",
  PROCESSING_UNAVAILABLE:
    "Dịch vụ xử lý tài liệu đang tạm thời không khả dụng. Vui lòng thử lại sau.",
  PROVIDER_NOT_CONFIGURED:
    "Tính năng này hiện chưa được kích hoạt đầy đủ. Vui lòng thử lại sau hoặc liên hệ bộ phận hỗ trợ.",
  REVISION_CONFLICT:
    "Phiên bản nội dung đã thay đổi trước đó. Hãy tải lại trang để cập nhật bản mới nhất.",
  DRIVE_QUOTA_EXCEEDED:
    "Không gian lưu trữ dữ liệu đang gần đầy. Vui lòng dọn bớt dữ liệu cũ rồi thử lại.",
  DRIVE_ACCOUNT_EMAIL_MISMATCH:
    "Tài khoản liên kết không khớp với tài khoản lưu trữ đã thiết lập trên hệ thống.",
  DRIVE_BRIDGE_ACCESS_DENIED:
    "Kết nối lưu trữ đám mây đang bị từ chối quyền truy cập. Vui lòng kiểm tra lại thiết lập kết nối.",
  DRIVE_BRIDGE_SECRET_NOT_SET:
    "Kết nối lưu trữ đám mây chưa được thiết lập đầy đủ. Vui lòng liên hệ quản trị viên.",
  DRIVE_AUTH_FAILED:
    "Xác thực kết nối lưu trữ đám mây chưa thành công. Vui lòng thử kết nối lại.",
  DRIVE_ENCRYPTION_KEY_MISSING:
    "Dịch vụ lưu trữ đám mây chưa sẵn sàng. Vui lòng liên hệ quản trị viên.",
  GOOGLE_DRIVE_DESKTOP_UNAVAILABLE_ON_CLOUD_SERVER:
    "Chế độ đồng bộ máy tính không khả dụng trên hệ thống trực tuyến. Vui lòng sử dụng kết nối trực tuyến.",
  GOOGLE_DRIVE_DESKTOP_REQUIRES_WINDOWS_HOST:
    "Hệ thống hiện tại không hỗ trợ đồng bộ thư mục máy tính. Vui lòng sử dụng kết nối trực tuyến.",
  FLOW2_INGESTION_PAUSED:
    "Tính năng đóng góp dữ liệu cải thiện nhận diện chữ đang tạm dừng.",
  UNRESOLVED_TRAINING_JOB_EXISTS:
    "Đang có một lượt cập nhật mô hình chưa hoàn tất. Vui lòng đợi hoàn tất trước khi tạo lượt mới.",
  TRAIN_AND_VALIDATION_REQUIRED:
    "Dữ liệu đóng góp chưa đủ điều kiện tối thiểu để tổng hợp. Vui lòng bổ sung thêm mẫu đã kiểm duyệt.",
  NO_ELIGIBLE_FLOW2_SAMPLES:
    "Chưa có mẫu đóng góp đạt chuẩn nào để tạo bản tổng hợp.",
  "Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive":
    "Hệ thống lưu trữ đang được cập nhật. Vui lòng thử lại sau.",
  "A queued or running training job cannot be deleted":
    "Không thể xóa tác vụ đang chờ xử lý hoặc đang chạy.",
  "Only a pre-run failure or an unbenchmarked candidate with a recoverable Colab error can be retried":
    "Chỉ có thể thử lại các tác vụ gặp sự cố tạm thời trước khi đánh giá.",
  "The pinned Locked Test is missing or no longer meets its integrity requirements":
    "Bộ dữ liệu kiểm thử chuẩn bị thiếu hoặc không còn hợp lệ.",
  "Locked Test is not ready":
    "Bộ dữ liệu kiểm thử chuẩn chưa sẵn sàng hoặc chưa đủ số lượng mẫu.",
  "The active model has changed since this training job was created":
    "Mô hình đang sử dụng trên hệ thống đã thay đổi kể từ khi tác vụ này được tạo.",
  "Another training job is already active":
    "Đang có một tác vụ cập nhật hoặc đánh giá khác đang hoạt động.",
  "Candidate evaluation is already running or queued":
    "Tác vụ đánh giá phiên bản này đã được xếp hàng hoặc đang chạy.",
  "Pilot holdout does not meet minimum samples or groups":
    "Dữ liệu kiểm thử chưa đạt số lượng tối thiểu để chạy đánh giá thử nghiệm.",
  "Remote OCR worker is offline; live page scan is temporarily unavailable.":
    "Tính năng quét trang sách trực tiếp hiện đang tạm nghỉ. Ba mẹ hãy chọn sách trong Thư viện để đọc cùng bé hoặc thử lại sau nhé.",
  "Remote OCR worker is offline; cannot run synchronous page OCR":
    "Tính năng nhận diện trang sách tạm thời chưa sẵn sàng. Vui lòng thử lại sau ít phút.",
  "Remote OCR worker is offline; cannot run synchronous replacement OCR":
    "Tính năng thay ảnh và nhận diện trang sách tạm thời chưa sẵn sàng. Vui lòng thử lại sau ít phút.",
  "Remote OCR worker is offline; cannot reprocess page synchronously":
    "Tính năng nhận diện lại trang sách tạm thời chưa sẵn sàng. Vui lòng thử lại sau ít phút.",
  "Remote OCR worker did not finish before sync timeout; poll job status asynchronously.":
    "Quá trình nhận diện trang sách đang xử lý lâu hơn dự kiến và đã được xếp hàng. Vui lòng kiểm tra lại trạng thái sau ít giây.",
  "Remote OCR worker failed":
    "Hệ thống gặp sự cố khi nhận diện trang sách. Vui lòng thử lại sau ít giây.",
  "Database temporarily unavailable":
    "Hệ thống dữ liệu tạm thời đang bận. Vui lòng thử lại sau vài giây.",
  "Database temporarily unavailable; please retry":
    "Hệ thống dữ liệu tạm thời đang bận. Vui lòng thử lại sau vài giây.",
  "Idempotency key already used for a different OCR payload.":
    "Mã gửi ảnh đã dùng cho một ảnh khác. Hãy chọn lại ảnh để quét mới.",
  "OCR inference job not found.":
    "Không tìm thấy yêu cầu quét trang sách hoặc yêu cầu đã hết hạn.",
  "Scan OCR job not found":
    "Không tìm thấy yêu cầu quét trang sách hoặc yêu cầu đã hết hạn.",
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

function resolveSafeMessageText(rawCodeOrText: string): string {
  const key = safeBackendMessageKeys[rawCodeOrText];
  if (key) return tApiError(key);
  const directFlow2 = safeFlow2BackendMessages[rawCodeOrText];
  if (directFlow2) return directFlow2;
  const matchedCode = SAFE_BACKEND_PREFIX_CODES.find(
    (code) => rawCodeOrText === code || rawCodeOrText.startsWith(`${code}:`),
  );
  return matchedCode
    ? (safeFlow2BackendMessages[matchedCode] ?? tApiError("errors.generic"))
    : tApiError("errors.generic");
}

function isKnownBackendDetail(rawCodeOrText: string): boolean {
  if (
    Boolean(safeBackendMessageKeys[rawCodeOrText]) ||
    Boolean(safeFlow2BackendMessages[rawCodeOrText])
  ) {
    return true;
  }
  return SAFE_BACKEND_PREFIX_CODES.some(
    (code) => rawCodeOrText === code || rawCodeOrText.startsWith(`${code}:`),
  );
}

async function extractBackendDetail(
  response: Response,
): Promise<string | null> {
  try {
    const payload: unknown = await response.clone().json();
    if (typeof payload === "object" && payload !== null) {
      if ("detail" in payload) {
        if (typeof payload.detail === "string") {
          return payload.detail;
        }
        if (
          typeof payload.detail === "object" &&
          payload.detail !== null &&
          "code" in payload.detail &&
          typeof payload.detail.code === "string"
        ) {
          return payload.detail.code;
        }
      }
      if ("code" in payload && typeof payload.code === "string") {
        return payload.code;
      }
    }
  } catch {
    // A non-JSON error body must not be reflected to the browser.
  }
  return null;
}

async function safeBackendMessage(response: Response): Promise<string> {
  const detail = await extractBackendDetail(response);
  return detail !== null
    ? resolveSafeMessageText(detail)
    : tApiError("errors.generic");
}

async function shouldRetryColdStartResponse(
  response: Response,
): Promise<boolean> {
  if (!COLD_START_RETRY_STATUSES.has(response.status)) {
    return false;
  }
  const detail = await extractBackendDetail(response);
  // Only treat unstructured/gateway 502/504 responses as cold starts; never
  // retry structured application domain errors such as async OCR 504 responses.
  return detail === null || !isKnownBackendDetail(detail);
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 90_000;
const DEFAULT_COLD_START_DEADLINE_MS = 65_000;
const DEFAULT_GET_RETRY_DELAY_MS = 800;

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timerId);
      reject(createAbortError());
    };
    const timerId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isColdStartRetryableGetError(error: ServiceError): boolean {
  return (
    error.retryable &&
    (error.status === 0 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504)
  );
}

function invalidateReadCacheForMutationPath(path: string): void {
  const pathname = path.split("?")[0] ?? path;
  if (
    pathname === "/reading" ||
    pathname.startsWith("/reading/") ||
    pathname === "/reading-presence" ||
    pathname.startsWith("/reading-presence/")
  ) {
    invalidateApiReadCacheByPrefix([
      "/reading",
      "/sessions",
      "/profiles/dashboard-summary",
      "/reports",
      "/system/progress",
      "/system/difficult-words",
      "/tutor",
      "/learning",
    ]);
    return;
  }
  if (
    pathname === "/reading-management" ||
    pathname.startsWith("/reading-management/")
  ) {
    invalidateApiReadCacheByPrefix([
      "/reading-management",
      "/profiles/dashboard-summary",
      "/learning",
    ]);
    return;
  }
  if (pathname.startsWith("/books") || pathname.startsWith("/studio")) {
    invalidateApiReadCacheByPrefix([
      "/books",
      "/studio",
      "/profiles/dashboard-summary",
      "/reading-management",
    ]);
    return;
  }
  if (pathname.startsWith("/profiles")) {
    invalidateApiReadCacheByPrefix(["/profiles"]);
    return;
  }
  if (pathname.startsWith("/karaoke")) {
    invalidateApiReadCacheByPrefix(["/karaoke", "/learning"]);
    return;
  }
  if (pathname.startsWith("/games")) {
    invalidateApiReadCacheByPrefix([
      "/games",
      "/learning",
      "/system/difficult-words",
    ]);
    return;
  }
  if (pathname.startsWith("/tutor")) {
    invalidateApiReadCacheByPrefix([
      "/tutor",
      "/reading",
      "/system/progress",
      "/learning",
    ]);
    return;
  }
  if (pathname.startsWith("/system/difficult-words")) {
    invalidateApiReadCacheByPrefix([
      "/system/difficult-words",
      "/system/progress",
      "/learning",
      "/tutor",
    ]);
    return;
  }
  if (pathname.startsWith("/support")) {
    invalidateApiReadCacheByPrefix(["/support"]);
    return;
  }
  if (pathname.startsWith("/parent-notifications")) {
    invalidateApiReadCacheByPrefix(["/parent-notifications"]);
    return;
  }
  invalidateApiReadCache();
}

const COLD_START_RETRY_STATUSES = new Set([502, 504]);

/** Only public DTOs validated by the supplied schema can reach a component. */
export interface RequestApiOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly bypassCache?: boolean;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
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
  const isTestEnv =
    typeof process !== "undefined" && process.env.NODE_ENV === "test";
  const maxRetries =
    method !== "GET"
      ? 0
      : typeof requestOptions.maxRetries === "number" &&
          Number.isFinite(requestOptions.maxRetries) &&
          requestOptions.maxRetries >= 0
        ? Math.floor(requestOptions.maxRetries)
        : isTestEnv
          ? 0
          : 2;
  const baseRetryDelayMs =
    typeof requestOptions.retryDelayMs === "number" &&
    Number.isFinite(requestOptions.retryDelayMs) &&
    requestOptions.retryDelayMs >= 0
      ? requestOptions.retryDelayMs
      : DEFAULT_GET_RETRY_DELAY_MS;
  const isFormDataBody =
    typeof FormData !== "undefined" && requestOptions.body instanceof FormData;
  const hasExplicitTimeout =
    typeof requestOptions.timeoutMs === "number" &&
    Number.isFinite(requestOptions.timeoutMs) &&
    requestOptions.timeoutMs > 0;
  const singleAttemptTimeoutMs = hasExplicitTimeout
    ? requestOptions.timeoutMs!
    : isFormDataBody
      ? DEFAULT_UPLOAD_TIMEOUT_MS
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const totalDeadlineMs = hasExplicitTimeout
    ? requestOptions.timeoutMs!
    : maxRetries > 0
      ? Math.max(singleAttemptTimeoutMs, DEFAULT_COLD_START_DEADLINE_MS)
      : singleAttemptTimeoutMs;

  const executeFetch = async (fetchSignal?: AbortSignal): Promise<T> => {
    const explicitLocale = resolveExplicitLocale();
    const body =
      requestOptions.body === undefined
        ? undefined
        : isFormDataBody
          ? requestOptions.body
          : JSON.stringify(requestOptions.body);
    const deadlineAt = Date.now() + totalDeadlineMs;
    let activeToken = token;
    let hasRetriedAuth = false;
    let lastError: ServiceError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (fetchSignal?.aborted) {
        throw createAbortError();
      }
      const remainingMs = deadlineAt - Date.now();
      if (attempt > 0 && remainingMs <= 0) {
        break;
      }
      const attemptTimeoutMs =
        hasExplicitTimeout || maxRetries > 0
          ? Math.max(1, Math.min(singleAttemptTimeoutMs, remainingMs))
          : singleAttemptTimeoutMs;

      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${activeToken}`,
        ...(explicitLocale && explicitLocale !== DEFAULT_LOCALE
          ? { "X-ViRead-Locale": explicitLocale }
          : {}),
      };
      if (requestOptions.body !== undefined && !isFormDataBody) {
        headers["Content-Type"] = "application/json";
      }

      const attemptController = new AbortController();
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const onParentAbort = () => attemptController.abort();
      fetchSignal?.addEventListener("abort", onParentAbort, { once: true });

      let response: Response | null = null;
      let attemptError: ServiceError | null = null;

      try {
        timeoutId = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, attemptTimeoutMs);
        response = await fetch(`${getApiBaseUrl()}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: body as BodyInit } : {}),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: attemptController.signal,
        });
      } catch (error) {
        if (fetchSignal?.aborted && !timedOut) throw error;
        attemptError = failure(0, "", true);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        fetchSignal?.removeEventListener("abort", onParentAbort);
      }

      if (response !== null) {
        const requestId = response.headers.get("x-request-id") ?? "";
        if (!response.ok) {
          if (response.status === 401) {
            invalidateBrowserTokenCache();
            invalidateApiReadCache();
            if (!hasRetriedAuth && !fetchSignal?.aborted) {
              hasRetriedAuth = true;
              const refreshedToken =
                await refreshBrowserAccessToken(activeToken);
              if (refreshedToken && refreshedToken !== activeToken) {
                activeToken = refreshedToken;
                attempt -= 1;
                continue;
              }
            }
          }
          const backendMessage = await safeBackendMessage(response);
          const coldStartGateway =
            !COLD_START_RETRY_STATUSES.has(response.status) ||
            (await shouldRetryColdStartResponse(response));
          attemptError = failure(
            response.status,
            requestId,
            response.status >= 500 && coldStartGateway,
            backendMessage,
          );
        } else if (response.status === 204 || response.status === 205) {
          const parsed = schema.safeParse(undefined);
          if (!parsed.success) {
            throw failure(response.status, requestId);
          }
          return parsed.data;
        } else {
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
        }
      }

      lastError = attemptError ?? failure(0, "", true);
      if (
        method === "GET" &&
        attempt < maxRetries &&
        !fetchSignal?.aborted &&
        isColdStartRetryableGetError(lastError)
      ) {
        const remainingAfterAttempt = deadlineAt - Date.now();
        if (remainingAfterAttempt <= 0) {
          throw lastError;
        }
        const boundedDelayMs = Math.min(
          baseRetryDelayMs * 2 ** attempt,
          Math.max(0, remainingAfterAttempt - 1),
        );
        await sleepWithAbort(boundedDelayMs, fetchSignal);
        continue;
      }

      throw lastError;
    }

    throw lastError ?? failure(0, "", true);
  };

  if (method !== "GET") {
    invalidateReadCacheForMutationPath(path);
    try {
      return await executeFetch(signal);
    } finally {
      invalidateReadCacheForMutationPath(path);
    }
  }

  return runCoalescedApiGet(path, token, signal, executeFetch, {
    bypassCache: requestOptions.bypassCache,
    cacheTtlMs: requestOptions.cacheTtlMs,
    locale: getActiveLocale(),
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
