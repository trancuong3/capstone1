import { apiQuery, requestApi } from "@/lib/api/api-client";
import { isServiceError } from "@/lib/api/service-error";
import {
  adminKaraokeDetailSchema,
  adminKaraokeListSchema,
  karaokePreviewSchema,
  karaokeValidationSchema,
  type KaraokeMetadata,
  type KaraokeDraftWrite,
} from "@/types/karaoke";
import { z } from "zod";

const root = "/karaoke/admin/songs";
function path(id: string) {
  return `${root}/${z.guid().parse(id)}`;
}
const detail = (id: string) =>
  adminKaraokeDetailSchema.refine((value) => value.song_id === id);

export function createAdminKaraokeService() {
  return {
    list(
      query: {
        search?: string;
        status?: "DRAFT" | "PUBLISHED" | "HIDDEN";
        offset?: number;
      },
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${root}${apiQuery({ ...query, limit: 12 })}`,
        adminKaraokeListSchema,
        signal,
      );
    },
    get(id: string, signal?: AbortSignal) {
      return requestApi(path(id), detail(id), signal);
    },
    create(body: KaraokeMetadata, signal?: AbortSignal) {
      return requestApi(root, adminKaraokeDetailSchema, signal, {
        method: "POST",
        body,
      });
    },
    createDraft(id: string, revision: number, signal?: AbortSignal) {
      return requestApi(`${path(id)}/draft`, detail(id), signal, {
        method: "POST",
        body: { expected_revision: revision },
      });
    },
    save(id: string, body: KaraokeDraftWrite, signal?: AbortSignal) {
      return requestApi(`${path(id)}/draft`, detail(id), signal, {
        method: "PUT",
        body,
      });
    },
    upload(
      id: string,
      kind: "audio" | "cover",
      file: File,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      const body = new FormData();
      body.set("file", file);
      body.set("expected_revision", String(revision));
      body.set("draft_version_id", draftId);
      return requestApi(`${path(id)}/draft/${kind}`, detail(id), signal, {
        method: "POST",
        body,
      });
    },
    validate(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${path(id)}/draft/validation`,
        karaokeValidationSchema.refine(
          (v) => v.revision === revision && v.draft_version_id === draftId,
        ),
        signal,
      );
    },
    preview(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${path(id)}/draft/preview`,
        karaokePreviewSchema.refine(
          (v) =>
            v.song_id === id &&
            v.revision === revision &&
            v.version_id === draftId,
        ),
        signal,
      );
    },
    publish(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(`${path(id)}/publish`, detail(id), signal, {
        method: "POST",
        body: { expected_revision: revision, draft_version_id: draftId },
      });
    },
    visibility(
      id: string,
      revision: number,
      visible: boolean,
      signal?: AbortSignal,
    ) {
      return requestApi(`${path(id)}/visibility`, detail(id), signal, {
        method: "PATCH",
        body: { expected_revision: revision, visible },
      });
    },
  };
}
export type AdminKaraokeService = ReturnType<typeof createAdminKaraokeService>;

export function karaokeErrorMessage(error: unknown) {
  if (isServiceError(error)) {
    switch (error.status) {
      case 401:
        return "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.";
      case 403:
        return "Tài khoản không có quyền quản lý bài hát.";
      case 404:
        return "Không tìm thấy bài hát hoặc bản nháp.";
      case 409:
        return "Bài hát vừa thay đổi. Bản đang nhập được giữ lại; hãy tải lại để đối chiếu trước khi sửa tiếp.";
      case 413:
        return "File vượt quá giới hạn cho phép.";
      case 415:
        return "Định dạng file không được hỗ trợ hoặc file bị hỏng.";
      case 422:
        return "Nội dung chưa hợp lệ. Hãy kiểm tra thông tin, lời và thời gian từng dòng.";
      case 503:
        return "Dịch vụ karaoke chưa sẵn sàng. Kiểm tra migration và Storage ở backend.";
    }
  }
  return "Chưa hoàn tất yêu cầu. Nội dung đang nhập được giữ lại; vui lòng thử lại.";
}
