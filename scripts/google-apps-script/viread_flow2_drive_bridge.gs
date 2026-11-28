/**
 * ViRead Flow 2 — Google Drive Private Bridge (Google Apps Script Web App)
 *
 * - 0 VNĐ, không cần thẻ tín dụng, không cần Google Cloud Console / Billing.
 * - Không hết hạn token sau 7 ngày như OAuth Testing mode.
 * - Chạy độc quyền dưới tài khoản chủ sở hữu Drive (Execute as: Me).
 * - Khi dùng nhiều tài khoản Google Colab khác nhau, Colab KHÔNG mount Drive
 *   mà gửi dữ liệu qua ViRead Backend -> Bridge này -> luôn vào đúng MyDrive của bạn.
 *
 * HƯỚNG DẪN CÀI ĐẶT NHANH (1 phút):
 * 1. Mở https://script.google.com/ bằng ĐÚNG tài khoản Google chủ Drive (vd: cuongtran290605@gmail.com).
 * 2. Bấm "Dự án mới" (New project), đặt tên: ViRead-Flow2-Drive-Bridge.
 * 3. Xóa code mặc định trong Code.gs và dán toàn bộ file này vào, bấm Lưu (Ctrl+S).
 * 3b. BẬT XÓA VĨNH VIỄN (QUAN TRỌNG — tránh file xóa bị kẹt 30 ngày trong Thùng rác chiếm 15 GiB):
 *     Ở thanh bên trái Apps Script, bấm **Dịch vụ (+)** (Services) -> chọn **Drive API** (v2/v3, Identifier: `Drive`) -> bấm **Thêm (Add)**.
 * 4. Vào Cài đặt dự án (biểu tượng bánh răng bên trái) -> Thuộc tính tập lệnh (Script Properties):
 *    Thêm thuộc tính:
 *      Property: VIREAD_BRIDGE_SECRET
 *      Value:    <chuỗi bí mật VIREAD_GDRIVE_APPS_SCRIPT_SECRET trên server ViRead>
 * 5. Bấm "Triển khai" (Deploy) -> "Tùy chọn triển khai mới" (New deployment):
 *    - Chọn loại (biểu tượng bánh răng): Ứng dụng web (Web app)
 *    - Thực thi dưới dạng (Execute as): Tôi (Me - cuongtran290605@gmail.com)
 *    - Ai có quyền truy cập (Who has access): Bất kỳ ai (Anyone)
 *      (Yên tâm: mọi request không có chữ ký HMAC-SHA256 hợp lệ từ ViRead Backend đều bị từ chối!)
 * 6. Chấp thuận quyền Google Drive cho chính bạn -> Copy "URL ứng dụng web" (https://script.google.com/macros/s/.../exec)
 *    và dán vào trang /admin/viread-training của ViRead.
 */

var VIREAD_ROOT_SEGMENTS = ["ViRead", "OCR-Training", "Flow2-Admin-Verified"];
var VIREAD_ALLOWED_CATEGORIES = [
  "verified-samples",
  "datasets",
  "locked-tests",
  "checkpoints",
  "resume",
  "benchmarks",
  "audit",
  "_selftest"
];
var VIREAD_IMMUTABLE_CATEGORIES = {
  "verified-samples": true,
  "datasets": true,
  "locked-tests": true,
  "checkpoints": true,
  "benchmarks": true,
  "audit": true
};
var VIREAD_MAX_SKEW_SECONDS = 300;
var VIREAD_CHUNKED_MIME = "application/vnd.viread.chunked+json";
var VIREAD_SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,180}$/;

function doGet() {
  return jsonOut_({
    ok: false,
    error_code: "METHOD_NOT_ALLOWED",
    message: "ViRead Flow 2 Drive Bridge accepts signed POST requests only."
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error_code: "BAD_REQUEST", message: "Empty request body" });
    }
    var envelope = JSON.parse(e.postData.contents);
    var authErr = verifySignedEnvelope_(envelope);
    if (authErr) {
      return jsonOut_(authErr);
    }

    var action = String(envelope.action || "");
    var payload = envelope.payload || {};

    switch (action) {
      case "health":
        return jsonOut_(handleHealth_());
      case "quota":
        return jsonOut_(handleQuota_());
      case "put_file":
        return jsonOut_(handlePutFile_(payload));
      case "get_metadata":
        return jsonOut_(handleGetMetadata_(payload));
      case "get_file":
        return jsonOut_(handleGetFile_(payload));
      case "delete_file":
        return jsonOut_(handleDeleteFile_(payload));
      case "list_resume_files":
        return jsonOut_(handleListResumeFiles_(payload));
      case "put_resume_file":
        return jsonOut_(handlePutResumeFile_(payload));
      case "get_resume_file_meta":
        return jsonOut_(handleGetResumeFileMeta_(payload));
      case "delete_resume_file":
        return jsonOut_(handleDeleteResumeFile_(payload));
      default:
        return jsonOut_({
          ok: false,
          error_code: "UNKNOWN_ACTION",
          message: "Unsupported bridge action: " + action
        });
    }
  } catch (err) {
    var msg = err && err.message ? String(err.message) : String(err);
    var code = (err && err.vireadCode) ? String(err.vireadCode) : "DRIVE_BRIDGE_ERROR";
    return jsonOut_({
      ok: false,
      error_code: code,
      message: msg.slice(0, 300)
    });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function makeError_(code, message) {
  var err = new Error(message);
  err.vireadCode = code;
  return err;
}

function getBridgeSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = String(props.getProperty("VIREAD_BRIDGE_SECRET") || "").trim();
  return secret;
}

function constantTimeEquals_(a, b) {
  var sa = String(a || "");
  var sb = String(b || "");
  if (sa.length === 0 || sa.length !== sb.length) {
    return false;
  }
  var diff = 0;
  for (var i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToHex_(bytes) {
  var hex = [];
  for (var i = 0; i < bytes.length; i++) {
    var v = (bytes[i] + 256) % 256;
    hex.push((v < 16 ? "0" : "") + v.toString(16));
  }
  return hex.join("");
}

function sha256HexBytes_(bytes) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
}

function sha256HexString_(str) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8));
}

function hmacSha256Hex_(message, secret) {
  var sigBytes = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  return bytesToHex_(sigBytes);
}

function verifySignedEnvelope_(envelope) {
  var secret = getBridgeSecret_();
  if (!secret || secret.length < 32) {
    return {
      ok: false,
      error_code: "DRIVE_BRIDGE_SECRET_NOT_SET",
      message: "Set VIREAD_BRIDGE_SECRET (>= 32 chars) in Apps Script Project Settings -> Script Properties."
    };
  }
  var action = String(envelope.action || "").trim();
  var ts = Number(envelope.ts || 0);
  var sig = String(envelope.sig || "").trim().toLowerCase();
  var payloadJson = String(envelope.payload_json || "");
  if (!action || !ts || !sig) {
    return { ok: false, error_code: "DRIVE_AUTH_FAILED", message: "Missing signature envelope fields" };
  }
  var nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > VIREAD_MAX_SKEW_SECONDS) {
    return { ok: false, error_code: "DRIVE_AUTH_FAILED", message: "Bridge request timestamp outside allowed window" };
  }
  var payloadHash = sha256HexString_(payloadJson);
  var signingInput = ts + ":" + action + ":" + payloadHash;
  var expectedSig = hmacSha256Hex_(signingInput, secret);
  if (!constantTimeEquals_(sig, expectedSig)) {
    return { ok: false, error_code: "DRIVE_AUTH_FAILED", message: "Invalid bridge HMAC signature" };
  }
  // Bind parsed payload strictly to the signed payload_json bytes.
  envelope.payload = payloadJson ? JSON.parse(payloadJson) : {};
  return null;
}

function ensurePrivateFolder_(folder) {
  try {
    if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    }
  } catch (e) {
    // Some personal Drive root operations can ignore redundant private transitions.
  }
  return folder;
}

function ensurePrivateFile_(file) {
  try {
    if (file.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    }
  } catch (e) {
    // Keep best-effort private enforcement; reads still assert privacy strictly.
  }
  return file;
}

function isFilePublic_(file) {
  var access = file.getSharingAccess();
  return (
    access === DriveApp.Access.ANYONE ||
    access === DriveApp.Access.ANYONE_WITH_LINK ||
    access === DriveApp.Access.DOMAIN ||
    access === DriveApp.Access.DOMAIN_WITH_LINK
  );
}

function findChildFolder_(parentFolder, name) {
  var iter = parentFolder.getFoldersByName(name);
  while (iter.hasNext()) {
    var folder = iter.next();
    if (!folder.isTrashed()) {
      return folder;
    }
  }
  return null;
}

function getOrCreateChildFolder_(parentFolder, name) {
  var existing = findChildFolder_(parentFolder, name);
  if (existing) {
    return ensurePrivateFolder_(existing);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    existing = findChildFolder_(parentFolder, name);
    if (existing) {
      return ensurePrivateFolder_(existing);
    }
    var created = parentFolder.createFolder(name);
    return ensurePrivateFolder_(created);
  } finally {
    lock.releaseLock();
  }
}

function ensureRootTree_() {
  var current = DriveApp.getRootFolder();
  for (var i = 0; i < VIREAD_ROOT_SEGMENTS.length; i++) {
    current = getOrCreateChildFolder_(current, VIREAD_ROOT_SEGMENTS[i]);
  }
  var rootFolder = current;
  var subfolderIds = {};
  for (var j = 0; j < VIREAD_ALLOWED_CATEGORIES.length; j++) {
    var cat = VIREAD_ALLOWED_CATEGORIES[j];
    var sub = getOrCreateChildFolder_(rootFolder, cat);
    subfolderIds[cat] = sub.getId();
  }
  return {
    rootFolder: rootFolder,
    rootFolderId: rootFolder.getId(),
    subfolderIds: subfolderIds
  };
}

function isDescendantOfFolder_(item, targetRootId) {
  var visited = {};
  var queue = [];
  var parents = item.getParents();
  while (parents.hasNext()) {
    queue.push(parents.next());
  }
  var depth = 0;
  while (queue.length > 0 && depth < 32) {
    var folder = queue.shift();
    depth++;
    var fid = folder.getId();
    if (fid === targetRootId) {
      return true;
    }
    if (visited[fid]) {
      continue;
    }
    visited[fid] = true;
    var nextParents = folder.getParents();
    while (nextParents.hasNext()) {
      queue.push(nextParents.next());
    }
  }
  return false;
}

function validateLogicalPath_(logicalPath) {
  var raw = String(logicalPath || "").trim();
  if (!raw || raw.indexOf("\\") !== -1 || raw.indexOf("\0") !== -1 || raw.charAt(0) === "/" || raw.charAt(raw.length - 1) === "/") {
    throw makeError_("INVALID_PATH", "Logical storage path contains forbidden characters");
  }
  var parts = raw.split("/");
  if (parts.length < 2) {
    throw makeError_("INVALID_PATH", "Logical storage path must include category and filename");
  }
  if (VIREAD_ALLOWED_CATEGORIES.indexOf(parts[0]) === -1) {
    throw makeError_("INVALID_PATH", "Logical storage category is not allowed: " + parts[0]);
  }
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (!seg || seg === "." || seg === ".." || !VIREAD_SAFE_SEGMENT_RE.test(seg)) {
      throw makeError_("INVALID_PATH", "Invalid logical path segment");
    }
  }
  return parts;
}

function resolveParentFolder_(rootFolder, parts) {
  var current = rootFolder;
  for (var i = 0; i < parts.length - 1; i++) {
    current = getOrCreateChildFolder_(current, parts[i]);
  }
  return {
    parentFolder: current,
    filename: parts[parts.length - 1]
  };
}

function parseFileDescriptionMeta_(file) {
  var raw = String(file.getDescription() || "").trim();
  if (!raw || raw.charAt(0) !== "{") {
    return {};
  }
  try {
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (e) {
    return {};
  }
}

function quotaInfo_() {
  var limitBytes = Number(DriveApp.getStorageLimit() || 0);
  var usageBytes = Number(DriveApp.getStorageUsed() || 0);
  return {
    limit_bytes: limitBytes > 0 ? limitBytes : null,
    usage_bytes: usageBytes >= 0 ? usageBytes : null,
    usage_in_drive_bytes: usageBytes >= 0 ? usageBytes : null,
    usage_in_trash_bytes: null
  };
}

function isAdvancedDriveServiceEnabled_() {
  try {
    return (
      typeof Drive !== "undefined" &&
      Boolean(
        Drive &&
          Drive.Files &&
          (typeof Drive.Files.remove === "function" ||
            typeof Drive.Files["delete"] === "function")
      )
    );
  } catch (e) {
    return false;
  }
}

function handleHealth_() {
  var tree = ensureRootTree_();
  var email = String(Session.getEffectiveUser().getEmail() || "").trim().toLowerCase();
  var advancedDriveEnabled = isAdvancedDriveServiceEnabled_();
  return {
    ok: true,
    account_email: email || null,
    account_display_name: email ? email.split("@")[0] : null,
    root_folder_id: tree.rootFolderId,
    subfolder_ids: tree.subfolderIds,
    quota: quotaInfo_(),
    advanced_drive_enabled: advancedDriveEnabled,
    delete_mode: advancedDriveEnabled ? "permanent_delete" : "trash_fallback"
  };
}

function handleQuota_() {
  return {
    ok: true,
    quota: quotaInfo_()
  };
}

function serializeFileInfo_(file, logicalPathOverride) {
  var meta = parseFileDescriptionMeta_(file);
  var isPublic = isFilePublic_(file);
  var mimeType = meta.viread_content_type || file.getMimeType() || "application/octet-stream";
  var sizeBytes = file.getSize();
  var sha256 = meta.viread_sha256 ? String(meta.viread_sha256).toLowerCase() : null;
  var isChunked = meta.viread_chunked_v1 === true || file.getMimeType() === VIREAD_CHUNKED_MIME;
  if (isChunked && typeof meta.viread_logical_size === "number") {
    sizeBytes = meta.viread_logical_size;
  }
  return {
    file_id: file.getId(),
    name: file.getName(),
    size_bytes: sizeBytes,
    sha256: sha256,
    content_type: mimeType,
    trashed: file.isTrashed(),
    is_public: isPublic,
    is_chunked: isChunked,
    logical_path: logicalPathOverride || meta.viread_logical_path || null,
    extra: meta
  };
}

function findMatchingFilesInFolder_(folder, filename) {
  var matches = [];
  var iter = folder.getFilesByName(filename);
  while (iter.hasNext()) {
    var f = iter.next();
    if (!f.isTrashed()) {
      matches.push(f);
    }
  }
  matches.sort(function (a, b) {
    return b.getLastUpdated().getTime() - a.getLastUpdated().getTime();
  });
  return matches;
}

function handlePutFile_(payload) {
  var parts = validateLogicalPath_(payload.logical_path);
  var logicalPath = parts.join("/");
  var contentB64 = String(payload.content_b64 || "");
  var contentType = String(payload.content_type || "application/octet-stream");
  var expectedSha = payload.expected_sha256 ? String(payload.expected_sha256).trim().toLowerCase() : null;
  var extraMeta = (payload.metadata && typeof payload.metadata === "object") ? payload.metadata : {};

  var rawBytes = contentB64 ? Utilities.base64Decode(contentB64) : [];
  var actualSha = sha256HexBytes_(rawBytes);
  if (expectedSha && actualSha !== expectedSha) {
    throw makeError_("ARTIFACT_INTEGRITY_MISMATCH", "Uploaded SHA-256 mismatch on Google Drive bridge");
  }

  var tree = ensureRootTree_();
  var resolved = resolveParentFolder_(tree.rootFolder, parts);

  // Content-addressed deduplication for immutable categories
  if (VIREAD_IMMUTABLE_CATEGORIES[parts[0]] && !payload.skip_dedup) {
    var existingList = findMatchingFilesInFolder_(resolved.parentFolder, resolved.filename);
    for (var i = 0; i < existingList.length; i++) {
      var existing = existingList[i];
      var existingInfo = serializeFileInfo_(existing, logicalPath);
      if (existingInfo.is_public) {
        continue;
      }
      if (existingInfo.sha256 && existingInfo.sha256 === actualSha && existingInfo.size_bytes === rawBytes.length) {
        return {
          ok: true,
          deduplicated: true,
          file: existingInfo
        };
      }
    }
  }

  var blob = Utilities.newBlob(rawBytes, contentType, resolved.filename);
  var created = resolved.parentFolder.createFile(blob);
  ensurePrivateFile_(created);

  var descObj = {
    viread_managed: true,
    viread_flow: "flow2_admin_verified",
    viread_sha256: actualSha,
    viread_logical_path: logicalPath,
    viread_content_type: contentType
  };
  if (extraMeta.viread_chunked_v1 === true) {
    descObj.viread_chunked_v1 = true;
    descObj.viread_logical_size = Number(extraMeta.viread_logical_size || rawBytes.length);
    if (extraMeta.viread_logical_sha256) {
      descObj.viread_sha256 = String(extraMeta.viread_logical_sha256).toLowerCase();
    }
    if (extraMeta.viread_logical_content_type) {
      descObj.viread_content_type = String(extraMeta.viread_logical_content_type);
    }
  }
  created.setDescription(JSON.stringify(descObj));

  return {
    ok: true,
    deduplicated: false,
    file: serializeFileInfo_(created, logicalPath)
  };
}

function getManagedFileById_(fileId, rootFolderId) {
  var cleanId = String(fileId || "").trim();
  if (!cleanId) {
    throw makeError_("DRIVE_OBJECT_NOT_FOUND", "Missing Drive file ID");
  }
  var file;
  try {
    file = DriveApp.getFileById(cleanId);
  } catch (e) {
    throw makeError_("DRIVE_OBJECT_NOT_FOUND", "Drive file not found");
  }
  if (!isDescendantOfFolder_(file, rootFolderId)) {
    throw makeError_("DRIVE_PERMISSION_DENIED", "Refusing access to file outside ViRead Flow 2 folder");
  }
  if (file.isTrashed()) {
    throw makeError_("DRIVE_OBJECT_NOT_FOUND", "Drive file is trashed");
  }
  if (isFilePublic_(file)) {
    throw makeError_("DRIVE_PUBLIC_PERMISSION_DETECTED", "Drive artifact has public sharing enabled; refusing access");
  }
  return file;
}

function handleGetMetadata_(payload) {
  var tree = ensureRootTree_();
  var file = getManagedFileById_(payload.file_id, tree.rootFolderId);
  return {
    ok: true,
    file: serializeFileInfo_(file, null)
  };
}

function handleGetFile_(payload) {
  var tree = ensureRootTree_();
  var file = getManagedFileById_(payload.file_id, tree.rootFolderId);
  var info = serializeFileInfo_(file, null);
  var bytes = file.getBlob().getBytes();
  return {
    ok: true,
    file: info,
    content_b64: Utilities.base64Encode(bytes)
  };
}

function deleteFilePermanentlyOrTrash_(file) {
  if (!file) {
    return { method: "noop", permanent: false, trashed_fallback: false };
  }
  var fileId = "";
  try {
    fileId = String(file.getId() || "");
  } catch (ignoreIdErr) {}
  if (fileId && typeof Drive !== "undefined" && Drive && Drive.Files) {
    try {
      if (typeof Drive.Files.remove === "function") {
        Drive.Files.remove(fileId);
        return { method: "permanent_delete", permanent: true, trashed_fallback: false };
      }
      if (typeof Drive.Files["delete"] === "function") {
        Drive.Files["delete"](fileId);
        return { method: "permanent_delete", permanent: true, trashed_fallback: false };
      }
    } catch (ignoreApiErr) {}
  }
  try {
    if (!file.isTrashed()) {
      file.setTrashed(true);
    }
    return { method: "trash_fallback", permanent: false, trashed_fallback: true };
  } catch (ignoreTrashErr) {}
  return { method: "noop", permanent: false, trashed_fallback: false };
}

function handleDeleteFile_(payload) {
  var tree = ensureRootTree_();
  var cleanId = String(payload.file_id || "").trim();
  var file;
  try {
    file = DriveApp.getFileById(cleanId);
  } catch (e) {
    return { ok: true, deleted: false, delete_mode: "noop", permanent_delete: false, trashed_fallback: false };
  }
  if (!isDescendantOfFolder_(file, tree.rootFolderId)) {
    throw makeError_("DRIVE_PERMISSION_DENIED", "Refusing to delete file outside ViRead Flow 2 folder");
  }
  if (file.isTrashed()) {
    return { ok: true, deleted: false, delete_mode: "noop", permanent_delete: false, trashed_fallback: false };
  }
  // If this is a chunked manifest, delete (or trash fallback) all referenced parts inside the root tree first.
  var info = serializeFileInfo_(file, null);
  var anyTrashFallback = false;
  if (info.is_chunked) {
    try {
      var manifest = JSON.parse(file.getBlob().getDataAsString("UTF-8"));
      if (manifest && manifest.viread_chunked_v1 && Array.isArray(manifest.parts)) {
        for (var i = 0; i < manifest.parts.length; i++) {
          var partId = manifest.parts[i] && manifest.parts[i].file_id;
          if (partId) {
            try {
              var partFile = DriveApp.getFileById(String(partId));
              if (!partFile.isTrashed() && isDescendantOfFolder_(partFile, tree.rootFolderId)) {
                var partRes = deleteFilePermanentlyOrTrash_(partFile);
                if (partRes && partRes.trashed_fallback) {
                  anyTrashFallback = true;
                }
              }
            } catch (ignorePartErr) {}
          }
        }
      }
    } catch (ignoreManifestErr) {}
  }
  var mainRes = deleteFilePermanentlyOrTrash_(file);
  var usedTrashFallback = anyTrashFallback || Boolean(mainRes && mainRes.trashed_fallback);
  var permanentDelete = Boolean(mainRes && mainRes.permanent) && !usedTrashFallback;
  return {
    ok: true,
    deleted: true,
    delete_mode: usedTrashFallback ? "trash_fallback" : (mainRes ? mainRes.method : "noop"),
    permanent_delete: permanentDelete,
    trashed_fallback: usedTrashFallback
  };
}

function handleListResumeFiles_(payload) {
  var jobId = String(payload.job_id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(jobId)) {
    throw makeError_("INVALID_PATH", "Resume job_id must be a canonical UUID");
  }
  var tree = ensureRootTree_();
  var resumeFolder = DriveApp.getFolderById(tree.subfolderIds["resume"]);
  var jobsFolder = findChildFolder_(resumeFolder, "jobs");
  if (!jobsFolder) {
    return { ok: true, files: [] };
  }
  var jobFolder = findChildFolder_(jobsFolder, jobId);
  if (!jobFolder) {
    return { ok: true, files: [] };
  }

  var results = [];
  var seen = {};
  var targets = [
    { prefix: "", folder: jobFolder },
    { prefix: "blobs/", folder: findChildFolder_(jobFolder, "blobs") }
  ];
  for (var t = 0; t < targets.length; t++) {
    var folder = targets[t].folder;
    var prefix = targets[t].prefix;
    if (!folder) {
      continue;
    }
    var list = [];
    var iter = folder.getFiles();
    while (iter.hasNext()) {
      var f = iter.next();
      if (!f.isTrashed()) {
        list.push(f);
      }
    }
    list.sort(function (a, b) {
      return b.getLastUpdated().getTime() - a.getLastUpdated().getTime();
    });
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var relName = prefix + item.getName();
      if (seen[relName]) {
        continue;
      }
      seen[relName] = true;
      if (isFilePublic_(item)) {
        throw makeError_("DRIVE_PUBLIC_PERMISSION_DETECTED", "Resume Drive object has public permissions");
      }
      var info = serializeFileInfo_(item, "resume/jobs/" + jobId + "/" + relName);
      results.push({
        name: relName,
        drive_file_id: info.file_id,
        size_bytes: info.size_bytes,
        sha256: info.sha256
      });
    }
  }
  return { ok: true, files: results };
}

function handlePutResumeFile_(payload) {
  var parts = validateLogicalPath_(payload.logical_path);
  if (parts[0] !== "resume" || parts[1] !== "jobs") {
    throw makeError_("INVALID_PATH", "Resume writes must stay under resume/jobs/<job_id>/");
  }
  var tree = ensureRootTree_();
  var resolved = resolveParentFolder_(tree.rootFolder, parts);
  var prior = findMatchingFilesInFolder_(resolved.parentFolder, resolved.filename);
  var putResult = handlePutFile_({
    logical_path: parts.join("/"),
    content_b64: payload.content_b64,
    content_type: payload.content_type || "application/octet-stream",
    expected_sha256: payload.expected_sha256 || null,
    metadata: payload.metadata || {},
    skip_dedup: true
  });
  var newFileId = putResult.file.file_id;
  // Manifest-last cleanup: permanently delete (or trash) superseded copies ONLY after new file succeeded.
  for (var i = 0; i < prior.length; i++) {
    if (prior[i].getId() !== newFileId) {
      deleteFilePermanentlyOrTrash_(prior[i]);
    }
  }
  return putResult;
}

function handleGetResumeFileMeta_(payload) {
  var parts = validateLogicalPath_(payload.logical_path);
  if (parts[0] !== "resume" || parts[1] !== "jobs") {
    throw makeError_("INVALID_PATH", "Resume reads must stay under resume/jobs/<job_id>/");
  }
  var tree = ensureRootTree_();
  var current = tree.rootFolder;
  for (var i = 0; i < parts.length - 1; i++) {
    current = findChildFolder_(current, parts[i]);
    if (!current) {
      throw makeError_("DRIVE_OBJECT_NOT_FOUND", "Resume folder not found on Drive");
    }
  }
  var matches = findMatchingFilesInFolder_(current, parts[parts.length - 1]);
  if (matches.length === 0) {
    throw makeError_("DRIVE_OBJECT_NOT_FOUND", "Resume file not found on Drive");
  }
  var target = matches[0];
  if (isFilePublic_(target)) {
    throw makeError_("DRIVE_PUBLIC_PERMISSION_DETECTED", "Resume Drive object has public permissions");
  }
  return {
    ok: true,
    file: serializeFileInfo_(target, parts.join("/"))
  };
}

function handleDeleteResumeFile_(payload) {
  var parts = validateLogicalPath_(payload.logical_path);
  if (parts[0] !== "resume" || parts[1] !== "jobs") {
    throw makeError_("INVALID_PATH", "Resume deletes must stay under resume/jobs/<job_id>/");
  }
  var tree = ensureRootTree_();
  var current = tree.rootFolder;
  for (var i = 0; i < parts.length - 1; i++) {
    current = findChildFolder_(current, parts[i]);
    if (!current) {
      return { ok: true, deleted: false };
    }
  }
  var matches = findMatchingFilesInFolder_(current, parts[parts.length - 1]);
  var deletedAny = false;
  var anyTrashFallback = false;
  var anyPermanent = false;
  for (var j = 0; j < matches.length; j++) {
    try {
      var res = deleteFilePermanentlyOrTrash_(matches[j]);
      deletedAny = true;
      if (res && res.trashed_fallback) {
        anyTrashFallback = true;
      } else if (res && res.permanent) {
        anyPermanent = true;
      }
    } catch (ignoreErr) {}
  }
  var deleteMode = !deletedAny
    ? "noop"
    : (anyTrashFallback ? "trash_fallback" : (anyPermanent ? "permanent_delete" : "noop"));
  return {
    ok: true,
    deleted: deletedAny,
    delete_mode: deleteMode,
    permanent_delete: deletedAny && anyPermanent && !anyTrashFallback,
    trashed_fallback: anyTrashFallback
  };
}
