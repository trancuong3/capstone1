import type {
  ApiMockHandlers,
  ApiMockRequestContext,
  ApiMockResponse,
} from "./session";
import {
  OPAQUE_ADMIN_ID,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_PAGE_ID,
  OPAQUE_PARENT_ID,
  OPAQUE_REPORT_ID,
  OPAQUE_REV_ID,
  OPAQUE_TASK_ID,
  makeAdminCatalogItem,
  makeCatalogBook,
  makeCatalogPagePreview,
  makeChildProfile,
  makeDashboardSummary,
  makeGlobalTaskList,
  makeHealthPayload,
  makeMinimalPngBuffer,
  makeOpaqueUuid,
  makeParentProfile,
  type AdminCatalogItemPayload,
  type CatalogBookPayload,
  type CatalogPagePreviewPayload,
  type ChildProfilePayload,
  type GlobalTaskItemPayload,
  type GlobalTaskListPayload,
  type ParentProfilePayload,
} from "./test-data";

export { makeAdminCatalogItem } from "./test-data";

export const OPAQUE_SUBMISSION_ID = makeOpaqueUuid(101, "87000000");
export const OPAQUE_BATCH_ID = makeOpaqueUuid(102, "87000000");
export const OPAQUE_WORKFLOW_ID = makeOpaqueUuid(103, "87000000");
export const OPAQUE_EXTRACTION_ID = makeOpaqueUuid(104, "87000000");
export const OPAQUE_ASSET_ID = makeOpaqueUuid(105, "87000000");
export const OPAQUE_COVER_ASSET_ID = makeOpaqueUuid(106, "87000000");
export const OPAQUE_SCAN_ID = makeOpaqueUuid(107, "87000000");
export const OPAQUE_TRAINING_JOB_ID = makeOpaqueUuid(108, "87000000");
export const OPAQUE_TRAINING_RUN_ID = makeOpaqueUuid(109, "87000000");
export const OPAQUE_BENCHMARK_ID = makeOpaqueUuid(110, "87000000");
export const OPAQUE_DATASET_ID = makeOpaqueUuid(111, "87000000");

export const OPAQUE_SHA256_A = "a".repeat(64);
export const OPAQUE_SHA256_B = "b".repeat(64);
export const OPAQUE_SHA256_C = "c".repeat(64);

// ---------------------------------------------------------------------------
// Cluster 1 Factories (F-01, F-02, F-03, F-04, F-23)
// ---------------------------------------------------------------------------

export interface AdminParentListItemPayload {
  id: string;
  display_name: string | null;
  created_at: string;
  children_count: number;
}

export function makeAdminParentListItem(
  overrides: Partial<AdminParentListItemPayload> = {},
): AdminParentListItemPayload {
  return {
    id: makeOpaqueUuid(1, "91000000"),
    display_name: "Nguyễn Minh Anh",
    created_at: OPAQUE_NOW_ISO,
    children_count: 1,
    ...overrides,
  };
}

export interface AdminParentDirectoryPayload {
  items: AdminParentListItemPayload[];
  total: number;
  limit: number;
  offset: number;
}

export function makeAdminParentDirectory(
  overrides: Partial<AdminParentDirectoryPayload> = {},
): AdminParentDirectoryPayload {
  const defaultItems = [
    makeAdminParentListItem({
      id: OPAQUE_PARENT_ID,
      display_name: "Phụ huynh Kiểm thử",
      children_count: 1,
    }),
    makeAdminParentListItem({
      id: makeOpaqueUuid(2, "91000000"),
      display_name: "Trần Thu Hà",
      children_count: 2,
    }),
  ];
  const items = overrides.items ?? defaultItems;
  return {
    items,
    total: overrides.total ?? items.length,
    limit: overrides.limit ?? 10,
    offset: overrides.offset ?? 0,
  };
}

export interface AdminParentDetailPayload {
  id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  children: Array<{
    id: string;
    alias: string;
    grade: number;
    created_at: string;
  }>;
  contact_info_status:
    "available" | "not_configured" | "user_not_found" | "lookup_failed";
}

export function makeAdminParentDetail(
  overrides: Partial<AdminParentDetailPayload> = {},
): AdminParentDetailPayload {
  return {
    id: OPAQUE_PARENT_ID,
    display_name: "Phụ huynh Kiểm thử",
    email: "parent@viread.local",
    phone: "+84901234567",
    created_at: OPAQUE_NOW_ISO,
    children: [
      {
        id: OPAQUE_CHILD_ID,
        alias: "Bé An",
        grade: 2,
        created_at: OPAQUE_NOW_ISO,
      },
    ],
    contact_info_status: "available",
    ...overrides,
  };
}

export function makeAdminParentSoftDeleteResponse(id = OPAQUE_PARENT_ID): {
  id: string;
  active: 0;
} {
  return { id, active: 0 };
}

export function makeProfileUpdateResponse(
  overrides: Partial<{
    id: string;
    role: "parent" | "admin";
    display_name: string | null;
    created_at: string;
  }> = {},
) {
  return {
    id: OPAQUE_PARENT_ID,
    role: "parent" as const,
    display_name: "Phụ huynh Đã Cập Nhật",
    created_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export interface Cluster1ApiState {
  profile: ParentProfilePayload;
  children: ChildProfilePayload[];
  adminParents: AdminParentDetailPayload[];
  deactivatedParentIds: string[];
  dashboardSummaryStatus?: number;
  faults: Record<string, ApiMockResponse>;
  nextChildIndex: number;
  nextParentIndex: number;
}

export function createCluster1ApiState(
  overrides: Partial<Cluster1ApiState> = {},
): Cluster1ApiState {
  const defaultChild = makeChildProfile();
  const defaultProfile = makeParentProfile();
  const defaultAdminParents: AdminParentDetailPayload[] = [
    makeAdminParentDetail({
      id: OPAQUE_PARENT_ID,
      display_name: "Phụ huynh Kiểm thử",
      email: "parent@viread.local",
      phone: "+84901234567",
    }),
    makeAdminParentDetail({
      id: makeOpaqueUuid(2, "91000000"),
      display_name: "Trần Thu Hà",
      email: "thuha@viread.local",
      phone: "+84902223344",
      children: [
        {
          id: makeOpaqueUuid(20, "92000000"),
          alias: "Bé Minh",
          grade: 3,
          created_at: OPAQUE_NOW_ISO,
        },
      ],
    }),
  ];

  return {
    profile: defaultProfile,
    children: [defaultChild],
    adminParents: defaultAdminParents,
    deactivatedParentIds: [],
    faults: {},
    nextChildIndex: 50,
    nextParentIndex: 50,
    ...overrides,
  };
}

function syncProfileChildren(state: Cluster1ApiState): void {
  state.profile = {
    ...state.profile,
    children: state.children.map((c) => ({
      id: c.id,
      alias: c.alias,
      grade: c.grade,
      created_at: c.created_at,
      avatar_url: c.avatar_url,
    })),
  };
}

export function createCluster1ApiHandler(
  state: Cluster1ApiState,
): ApiMockHandlers {
  return (ctx: ApiMockRequestContext): ApiMockResponse | undefined => {
    const faultKey = `${ctx.method} ${ctx.pathname}`;
    if (state.faults[faultKey]) {
      return state.faults[faultKey];
    }
    if (state.faults[ctx.pathname]) {
      return state.faults[ctx.pathname];
    }

    if (ctx.method === "GET" && ctx.pathname === "/health") {
      return { status: 200, body: makeHealthPayload() };
    }

    if (ctx.method === "GET" && ctx.pathname === "/profiles/me") {
      return { status: 200, body: state.profile };
    }

    if (
      ctx.method === "PUT" &&
      ctx.pathname === `/profiles/${state.profile.id}`
    ) {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const nextName =
        typeof body.displayname === "string"
          ? body.displayname
          : typeof body.display_name === "string"
            ? body.display_name
            : state.profile.display_name;
      state.profile = { ...state.profile, display_name: nextName };
      return {
        status: 200,
        body: makeProfileUpdateResponse({
          id: state.profile.id,
          role: state.profile.role,
          display_name: state.profile.display_name,
        }),
      };
    }

    if (
      ctx.method === "PATCH" &&
      ctx.pathname === "/profiles/me/contact-phone"
    ) {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      state.profile = {
        ...state.profile,
        contact_phone:
          typeof body.contact_phone === "string" ? body.contact_phone : null,
      };
      return { status: 200, body: state.profile };
    }

    if (ctx.method === "POST" && ctx.pathname === "/profiles/me/avatar") {
      state.profile = {
        ...state.profile,
        avatar_url:
          "https://example.supabase.co/storage/v1/object/public/viread-avatars/parent.png",
      };
      return { status: 200, body: state.profile };
    }

    if (ctx.method === "DELETE" && ctx.pathname === "/profiles/me/avatar") {
      state.profile = { ...state.profile, avatar_url: null };
      return { status: 200, body: state.profile };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/profiles/dashboard-summary"
    ) {
      if (state.dashboardSummaryStatus && state.dashboardSummaryStatus >= 400) {
        return {
          status: state.dashboardSummaryStatus,
          body: { detail: "DASHBOARD_SUMMARY_UNAVAILABLE" },
        };
      }
      return {
        status: 200,
        body: makeDashboardSummary({
          profile: state.profile,
          children: state.children,
          latest_sessions_by_child: Object.fromEntries(
            state.children.map((c) => [c.id, null]),
          ),
        }),
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/profiles/children") {
      return { status: 200, body: state.children };
    }

    if (ctx.method === "POST" && ctx.pathname === "/profiles/children") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const newId = makeOpaqueUuid((state.nextChildIndex += 1), "92000000");
      const created = makeChildProfile({
        id: newId,
        parent_id: state.profile.id,
        alias: typeof body.alias === "string" ? body.alias : "Bé Mới",
        grade: typeof body.grade === "number" ? body.grade : 1,
      });
      state.children.push(created);
      syncProfileChildren(state);
      return { status: 201, body: created };
    }

    const childAvatarMatch = /^\/profiles\/children\/([^/]+)\/avatar$/u.exec(
      ctx.pathname,
    );
    if (childAvatarMatch) {
      const childId = decodeURIComponent(childAvatarMatch[1] ?? "");
      const idx = state.children.findIndex((c) => c.id === childId);
      if (idx === -1) {
        return { status: 404, body: { detail: "CHILD_NOT_FOUND" } };
      }
      const nextUrl =
        ctx.method === "POST"
          ? `https://example.supabase.co/storage/v1/object/public/viread-avatars/${childId}.png`
          : null;
      state.children[idx] = { ...state.children[idx]!, avatar_url: nextUrl };
      syncProfileChildren(state);
      return { status: 200, body: state.children[idx] };
    }

    const childMatch = /^\/profiles\/children\/([^/]+)$/u.exec(ctx.pathname);
    if (childMatch) {
      const childId = decodeURIComponent(childMatch[1] ?? "");
      const idx = state.children.findIndex((c) => c.id === childId);
      if (idx === -1) {
        return { status: 404, body: { detail: "CHILD_NOT_FOUND" } };
      }
      if (ctx.method === "GET") {
        return { status: 200, body: state.children[idx] };
      }
      if (ctx.method === "PUT") {
        const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
        state.children[idx] = {
          ...state.children[idx]!,
          alias:
            typeof body.alias === "string"
              ? body.alias
              : state.children[idx]!.alias,
          grade:
            typeof body.grade === "number"
              ? body.grade
              : state.children[idx]!.grade,
        };
        syncProfileChildren(state);
        return { status: 200, body: state.children[idx] };
      }
      if (ctx.method === "DELETE") {
        state.children.splice(idx, 1);
        syncProfileChildren(state);
        return { status: 204, body: "" };
      }
    }

    if (ctx.method === "GET" && ctx.pathname === "/profiles/admin/parents") {
      const search = (ctx.url.searchParams.get("search") ?? "")
        .trim()
        .toLowerCase();
      const limit = Number(ctx.url.searchParams.get("limit") ?? "10") || 10;
      const offset = Number(ctx.url.searchParams.get("offset") ?? "0") || 0;
      const activeList = state.adminParents.filter(
        (p) => !state.deactivatedParentIds.includes(p.id),
      );
      const filtered = search
        ? activeList.filter((p) =>
            (p.display_name ?? "").toLowerCase().includes(search),
          )
        : activeList;
      const sliced = filtered.slice(offset, offset + limit).map((p) =>
        makeAdminParentListItem({
          id: p.id,
          display_name: p.display_name,
          created_at: p.created_at,
          children_count: p.children.length,
        }),
      );
      return {
        status: 200,
        body: makeAdminParentDirectory({
          items: sliced,
          total: filtered.length,
          limit,
          offset,
        }),
      };
    }

    if (ctx.method === "POST" && ctx.pathname === "/profiles/admin/parents") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (
        email &&
        state.adminParents.some((p) => (p.email ?? "").toLowerCase() === email)
      ) {
        return { status: 409, body: { detail: "PARENT_CONFLICT" } };
      }
      const newId = makeOpaqueUuid((state.nextParentIndex += 1), "91000000");
      const created = makeAdminParentDetail({
        id: newId,
        display_name:
          typeof body.display_name === "string"
            ? body.display_name
            : "Phụ huynh Mới",
        email: email || "new-parent@viread.local",
        phone: typeof body.phone === "string" ? body.phone : null,
        children: [],
      });
      state.adminParents.unshift(created);
      return { status: 201, body: created };
    }

    const adminParentMatch = /^\/profiles\/admin\/parents\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (adminParentMatch) {
      const parentId = decodeURIComponent(adminParentMatch[1] ?? "");
      const idx = state.adminParents.findIndex((p) => p.id === parentId);
      if (idx === -1) {
        return { status: 404, body: { detail: "PARENT_NOT_FOUND" } };
      }
      if (ctx.method === "GET") {
        return { status: 200, body: state.adminParents[idx] };
      }
      if (ctx.method === "PATCH") {
        const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
        state.adminParents[idx] = {
          ...state.adminParents[idx]!,
          display_name:
            typeof body.display_name === "string"
              ? body.display_name
              : state.adminParents[idx]!.display_name,
          email:
            typeof body.email === "string"
              ? body.email
              : state.adminParents[idx]!.email,
          phone:
            typeof body.phone === "string"
              ? body.phone
              : state.adminParents[idx]!.phone,
        };
        return { status: 200, body: state.adminParents[idx] };
      }
      if (ctx.method === "DELETE") {
        if (!state.deactivatedParentIds.includes(parentId)) {
          state.deactivatedParentIds.push(parentId);
        }
        return {
          status: 200,
          body: makeAdminParentSoftDeleteResponse(parentId),
        };
      }
    }

    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Cluster 2 Factories (F-05, F-06, F-18, F-19, F-20)
// ---------------------------------------------------------------------------

export function makePrivateBookOcrContribution(
  overrides: Record<string, unknown> = {},
) {
  return {
    book_id: OPAQUE_BOOK_ID,
    enabled: false,
    status: "OPTED_OUT" as const,
    purpose: "FLOW2_ADMIN_VERIFIED_OCR" as const,
    consent_version: 0,
    notice_version: "v1-2026-11-22",
    rights_confirmed: false,
    consented_at: null as string | null,
    revoked_at: null as string | null,
    revoke_reason: null as string | null,
    rights_basis: "SELF_AUTHORED" as const,
    rights_eligible_for_training: true,
    rights_ineligible_reason: null as string | null,
    pending_verification_count: 0,
    sync_queued_count: 0,
    synced_count: 0,
    rejected_count: 0,
    revoked_count: 0,
    status_notice:
      "Mặc định tắt — các trang sách của gia đình không được dùng cho huấn luyện.",
    ...overrides,
  };
}

export function makePrivateBookListItem(
  overrides: Record<string, unknown> = {},
) {
  const id = (overrides.id as string | undefined) ?? OPAQUE_BOOK_ID;
  return {
    id,
    title: "Sách gia đình bé An",
    author: "Gia đình bé An",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE" as const,
    visibility_scope: "PARENT_PRIVATE" as const,
    moderation_status: "ACTIVE" as "ACTIVE" | "SUSPENDED",
    suspended_reason: null as string | null,
    source_declaration: "[SELF_AUTHORED] Gia đình tự biên soạn",
    committed_page_count: 0,
    pending_submission_count: 0,
    flagged_submission_count: 0,
    failed_submission_count: 0,
    ready_to_add_count: 0,
    readable_for_children: false,
    has_held_multipage_batch: false,
    privacy_notice: "Sách riêng chỉ hiển thị trong tài khoản gia đình.",
    ocr_contribution: makePrivateBookOcrContribution({ book_id: id }),
    created_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makePrivateBookPagedResponse(
  items = [makePrivateBookListItem()],
  overrides: Partial<{ total: number; limit: number; offset: number }> = {},
) {
  return {
    items,
    total: overrides.total ?? items.length,
    limit: overrides.limit ?? 9,
    offset: overrides.offset ?? 0,
  };
}

export function makePrivateBookSubmission(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: OPAQUE_SUBMISSION_ID,
    book_id: OPAQUE_BOOK_ID,
    batch_id: OPAQUE_BATCH_ID,
    batch_total_pages: 1,
    source_page_number: 1,
    target_page_number: 1,
    source_file_name: "trang-1.png",
    source_format: "PNG",
    image_width: 800,
    image_height: 1100,
    image_url:
      "https://example.supabase.co/storage/v1/object/public/viread-private-books/page-1.png",
    source_type: "SELF_AUTHORED" as const,
    source_type_label: "Tự biên soạn / gia đình tự viết",
    source_note: "Gia đình tự viết",
    submission_version: 1,
    optimistic_lock_version: 1,
    workflow_status: "PASSED_READY_TO_ADD" as
      | "CHECKING"
      | "PASSED_READY_TO_ADD"
      | "NEEDS_ADMIN_REVIEW"
      | "CHECK_FAILED"
      | "PENDING_ADMIN"
      | "APPROVED_READY_TO_ADD"
      | "REJECTED"
      | "NEEDS_RECHECK"
      | "ADDED_TO_BOOK"
      | "CANCELLED",
    workflow_status_label: "Sẵn sàng thêm",
    ocr_status: "COMPLETED",
    ocr_text: "Chú mèo nhỏ bước ra sân.",
    ocr_error_code: null as string | null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: "Chú mèo nhỏ bước ra sân.",
    proofread_suggestions: [] as Array<{
      word_index: number;
      original: string;
      suggested: string;
      uncertain: boolean;
    }>,
    uncertain_word_indices: [] as number[],
    proofread_error_code: null as string | null,
    spelling_accepted: true,
    candidate_text: "Chú mèo nhỏ bước ra sân.",
    candidate_hash: OPAQUE_SHA256_A,
    tool_check_status: "PASSED",
    tool_check_suitability: "SUITABLE",
    tool_check_scope: {
      modality: "text_and_image",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: true,
      requires_admin_visual_review: false,
      copyright_scanner_status: "CLEAR",
      local_ai_enforced: true,
    },
    tool_check_findings_count: 0,
    tool_check_parent_notice: null as string | null,
    tool_check_policy_blocked: false,
    tool_check_workflow_id: OPAQUE_WORKFLOW_ID,
    tool_check_error_code: null as string | null,
    provider_events: [],
    can_add_to_book: true,
    can_request_admin_review: false,
    can_retry: false,
    admin_decision: null as string | null,
    admin_decision_reason: null as string | null,
    approved_snapshot_hash: null as string | null,
    approved_submission_version: null as number | null,
    committed_page_id: null as string | null,
    committed_revision_id: null as string | null,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makePrivateBookCommittedPage(
  overrides: Record<string, unknown> = {},
) {
  return {
    page_id: OPAQUE_PAGE_ID,
    page_number: 1,
    current_verified_revision_id: OPAQUE_REV_ID,
    verified_text: "Chú mèo nhỏ bước ra sân.",
    verified_text_preview: "Chú mèo nhỏ bước ra sân.",
    image_url:
      "https://example.supabase.co/storage/v1/object/public/viread-private-books/committed-1.png",
    created_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makePrivateBookDetail(overrides: Record<string, unknown> = {}) {
  const book =
    (overrides.book as
      ReturnType<typeof makePrivateBookListItem> | undefined) ??
    makePrivateBookListItem();
  return {
    book,
    pages: [] as Array<ReturnType<typeof makePrivateBookCommittedPage>>,
    submissions: [] as Array<ReturnType<typeof makePrivateBookSubmission>>,
    ...overrides,
  };
}

export function makeAdminBookDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: OPAQUE_BOOK_ID,
    name: "chu-meo-di-hia",
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE" as const,
    cover_url: null as string | null,
    cover_source_type: null as
      "USER_UPLOAD" | "AI_GENERATED" | "METADATA_RENDER" | null,
    next_page_number: 2,
    ...overrides,
  };
}

export function makeAdminPageProcessing(
  overrides: Record<string, unknown> = {},
) {
  return {
    page_id: OPAQUE_PAGE_ID,
    page_revision_id: OPAQUE_REV_ID,
    revision_no: 1,
    verification_status: "NEEDS_REVIEW" as "NEEDS_REVIEW" | "VERIFIED",
    lifecycle_status: "ACTIVE" as const,
    ocr_preview_metadata: {},
    verified_at: null as string | null,
    current_verified_revision_id: null as string | null,
    ...overrides,
  };
}

export function makeAdminPageListItem(overrides: Record<string, unknown> = {}) {
  return {
    book_id: OPAQUE_BOOK_ID,
    page_number: 1,
    processing: makeAdminPageProcessing(
      (overrides.processing as Record<string, unknown> | undefined) ?? {},
    ),
    text_preview: "Chú mèo đi hia.",
    ...overrides,
  };
}

export function makeAdminOcrJob(overrides: Record<string, unknown> = {}) {
  return {
    id: OPAQUE_TASK_ID,
    job_kind: "ADMIN_PAGE_UPLOAD",
    status: "SUCCEEDED" as const,
    priority: 10,
    book_id: OPAQUE_BOOK_ID,
    page_id: OPAQUE_PAGE_ID,
    revision_id: OPAQUE_REV_ID,
    submission_id: null,
    file_name: "page-1.png",
    queue_position: 0,
    worker_id: "worker-1",
    worker_online: true,
    attempt_count: 1,
    max_attempts: 3,
    error_code: null,
    error_message: null,
    cancelled_reason: null,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    completed_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeAdminRevisionWord(
  index = 0,
  text = "Chú",
  overrides: Record<string, unknown> = {},
) {
  const x = Math.min(0.8, 0.05 + index * 0.15);
  return {
    word_index: index,
    line_index: 0,
    text,
    normalized_text: text.toLowerCase(),
    bbox: [x, 0.1, 0.12, 0.06] as [number, number, number, number],
    ocr_confidence: 0.96,
    review_color_group: "green" as const,
    geometry_quality: "good" as const,
    punctuation_status: "correct" as const,
    ocr_review_status: "matched" as const,
    ocr_score_source: "dual_engine_consensus_v1" as const,
    ocr_evidence: null,
    ...overrides,
  };
}

export function makeAdminRevisionDetail(
  overrides: Record<string, unknown> = {},
) {
  return {
    page_id: OPAQUE_PAGE_ID,
    page_revision_id: OPAQUE_REV_ID,
    revision_no: 1,
    verification_status: "NEEDS_REVIEW" as "NEEDS_REVIEW" | "VERIFIED",
    lifecycle_status: "ACTIVE" as const,
    original_ocr_text: "Chú mèo đi hia",
    draft_text: "Chú mèo đi hia",
    words: [
      makeAdminRevisionWord(0, "Chú"),
      makeAdminRevisionWord(1, "mèo"),
      makeAdminRevisionWord(2, "đi"),
      makeAdminRevisionWord(3, "hia"),
    ],
    ocr_metadata: {},
    created_at: OPAQUE_NOW_ISO,
    verified_at: null as string | null,
    verified_by: null as string | null,
    ...overrides,
  };
}

export function makeAdminRevisionSummary(
  overrides: Record<string, unknown> = {},
) {
  return {
    page_revision_id: OPAQUE_REV_ID,
    revision_no: 1,
    verification_status: "NEEDS_REVIEW" as "NEEDS_REVIEW" | "VERIFIED",
    created_at: OPAQUE_NOW_ISO,
    is_current_verified: false,
    ...overrides,
  };
}

export function makeAdminAiWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_id: OPAQUE_WORKFLOW_ID,
    page_id: OPAQUE_PAGE_ID,
    book_id: OPAQUE_BOOK_ID,
    page_revision_id: OPAQUE_REV_ID,
    status: "READY_FOR_ADMIN_REVIEW" as const,
    stage: "READY_FOR_ADMIN_REVIEW" as const,
    progress: { completed_chunks: 1, total_chunks: 1 },
    attempts: 1,
    error_code: null as string | null,
    original_ocr_hash: OPAQUE_SHA256_A,
    admin_input_hash: OPAQUE_SHA256_A,
    proofread_text: "Chú mèo đi hia",
    proofread_output_hash: OPAQUE_SHA256_B,
    corrections: [],
    uncertain_word_indices: [],
    proofread_metadata: {},
    safety_metadata: {},
    candidate_history: [],
    safety_history: [],
    review_history: [],
    candidate_text: "Chú mèo đi hia",
    candidate_hash: OPAQUE_SHA256_B,
    candidate_version: 1,
    safety_input_hash: OPAQUE_SHA256_B,
    hash_match: true,
    suitability: "SUITABLE" as const,
    safety_status: "AUTO_CONFIRMED" as const,
    text_safety_status: "AUTO_CONFIRMED" as const,
    image_safety_status: "ADMIN_CONFIRMED_SAFE" as const,
    image_safety_reviewed_at: OPAQUE_NOW_ISO,
    image_safety_reviewed_by: OPAQUE_ADMIN_ID,
    image_safety_image_sha256: OPAQUE_SHA256_C,
    image_safety_reason: "An toàn cho trẻ",
    source_image_sha256: OPAQUE_SHA256_C,
    all_chunks_completed: true,
    findings: [],
    provider_events: [],
    ocr_approved_at: null as string | null,
    final_approved_text_hash: null as string | null,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeMetadataQualityResponse(
  overrides: Record<string, unknown> = {},
) {
  return {
    summary: {
      total_books: 5,
      books_with_issues: 1,
      missing_title: 0,
      missing_author: 1,
      invalid_grade_range: 0,
      possible_duplicate_groups: 0,
      books_in_duplicate_groups: 0,
      checked_at: OPAQUE_NOW_ISO,
    },
    items: [
      {
        id: OPAQUE_BOOK_ID,
        title: "Chú Mèo Đi Hia",
        author: null,
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        issues: ["MISSING_AUTHOR" as const],
      },
    ],
    total: 1,
    limit: 10,
    offset: 0,
    ...overrides,
  };
}

export function makeBookQualityScan(overrides: Record<string, unknown> = {}) {
  return {
    id: OPAQUE_SCAN_ID,
    book_id: OPAQUE_BOOK_ID,
    book_title: "Chú Mèo Đi Hia",
    trigger_type: "MANUAL",
    scope: "BOOK" as const,
    target_page_id: null as string | null,
    status: "COMPLETED" as const,
    total_pages: 1,
    completed_pages: 1,
    skipped_pages: 0,
    failed_pages: 0,
    ai_completed_pages: 1,
    ai_unavailable_pages: 0,
    error_summary: null as string | null,
    started_at: OPAQUE_NOW_ISO,
    completed_at: OPAQUE_NOW_ISO,
    created_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeBookApprovalAssessment(
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "PENDING_ADMIN_REVIEW" as
      | "PROCESSING"
      | "SCAN_FAILED"
      | "PENDING_ADMIN_REVIEW"
      | "READY_FOR_CHILDREN"
      | "PUBLISHED"
      | "APPROVED_BY_ADMIN"
      | "REJECTED_FOR_CHILDREN"
      | "STALE",
    page_count: 1,
    ocr_completed_pages: 1,
    ocr_approval_valid_pages: 1,
    proofreading_status: "COMPLETED",
    proofreading_completed_pages: 1,
    proofreading_suggestion_count: 0,
    child_safety_status: "COMPLETED",
    child_safety_completed_pages: 1,
    processing_pages: 0,
    failed_pages: 0,
    stale_pages: 0,
    copyright_status: "UNASSESSED",
    copyright_finding_count: 0,
    finding_count: 0,
    high_finding_count: 0,
    medium_finding_count: 0,
    warning_page_count: 0,
    failed_or_unscanned_page_count: 0,
    finding_groups: [],
    assessment_hash: OPAQUE_SHA256_A,
    assessed_at: OPAQUE_NOW_ISO,
    admin_approved_at: null as string | null,
    admin_approved_by: null as string | null,
    admin_approved_by_name: null as string | null,
    admin_reason: null as string | null,
    publication_source: null as "AUTO_APPROVAL" | "ADMIN_APPROVAL" | null,
    rights_confirmed: false,
    blockers: [],
    ...overrides,
  };
}

export function makeBookRightsEvidence(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: makeOpaqueUuid(120, "85000000"),
    book_id: OPAQUE_BOOK_ID,
    page_id: null as string | null,
    scope: "BOOK" as const,
    status: "UNASSESSED" as const,
    effective_status: "UNASSESSED",
    is_stale: false,
    source_description: null as string | null,
    author_or_rights_holder: null as string | null,
    usage_basis: null as string | null,
    evidence_url_or_ref: null as string | null,
    notes: null as string | null,
    version: 1,
    content_fingerprint: OPAQUE_SHA256_A,
    current_content_fingerprint: OPAQUE_SHA256_A,
    reviewed_by: null as string | null,
    reviewed_by_name: null as string | null,
    reviewed_at: null as string | null,
    updated_at: OPAQUE_NOW_ISO,
    history: [],
    ...overrides,
  };
}

export function makeAdminQualityReportItem(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: OPAQUE_REPORT_ID,
    book_id: OPAQUE_BOOK_ID,
    book_title: "Chú Mèo Đi Hia",
    reporter_name: "Phụ huynh Kiểm thử",
    page_id: OPAQUE_PAGE_ID,
    page_number: 1,
    page_revision_id: OPAQUE_REV_ID,
    issue_type: "SPELLING_ERROR" as const,
    description: "Thiếu dấu hỏi ở chữ nhỏ.",
    reported_text: "Chú mèo nho",
    suggested_correction: "Chú mèo nhỏ",
    status: "OPEN" as "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "REJECTED",
    scan_run_id: null as string | null,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeAdminQualityReportDetail(
  overrides: Record<string, unknown> = {},
) {
  return {
    ...makeAdminQualityReportItem(),
    reporter_id: OPAQUE_PARENT_ID,
    reporter_name: "Phụ huynh Kiểm thử",
    verified_text_snapshot: "Chú mèo nhỏ bước ra sân.",
    content_hash_snapshot: OPAQUE_SHA256_A,
    admin_resolution_note: null as string | null,
    reviewed_by: null as string | null,
    reviewed_by_name: null as string | null,
    resolved_at: null as string | null,
    history: [
      {
        actor_name: "Phụ huynh Kiểm thử",
        from_status: null,
        to_status: "OPEN" as const,
        note: "Báo cáo mới",
        created_at: OPAQUE_NOW_ISO,
      },
    ],
    related_findings: [],
    ...overrides,
  };
}

export function makeParentBookReport(overrides: Record<string, unknown> = {}) {
  return makeAdminQualityReportDetail(overrides);
}

export function makeParentBookReportList(
  items = [makeAdminQualityReportItem()],
  overrides: Partial<{ total: number; limit: number; offset: number }> = {},
) {
  return {
    items,
    total: overrides.total ?? items.length,
    limit: overrides.limit ?? 10,
    offset: overrides.offset ?? 0,
  };
}

export function makeAdminQualityBookItem(
  overrides: Record<string, unknown> = {},
) {
  return {
    book_id: OPAQUE_BOOK_ID,
    book_title: "Chú Mèo Đi Hia",
    report_count: 0,
    open_report_count: 0,
    finding_count: 0,
    needs_review_finding_count: 0,
    latest_scan: makeBookQualityScan(),
    assessment: makeBookApprovalAssessment(),
    ...overrides,
  };
}

export function makeAdminQualityBookDetail(
  overrides: Record<string, unknown> = {},
) {
  return {
    book_id: OPAQUE_BOOK_ID,
    book_title: "Chú Mèo Đi Hia",
    reports: [],
    scans: [makeBookQualityScan()],
    latest_scan_detail: null,
    ai_workflows: [makeAdminAiWorkflow()],
    ai_workflow_summary: { READY_FOR_ADMIN_REVIEW: 1 },
    assessment: makeBookApprovalAssessment(),
    rights_evidence: makeBookRightsEvidence(),
    page_diagnostics: [
      {
        page_id: OPAQUE_PAGE_ID,
        page_number: 1,
        lifecycle_status: "ACTIVE",
        verification_status: "VERIFIED",
        codes: ["OK" as const],
        image_safety_status: "ADMIN_CONFIRMED_SAFE",
        text_safety_status: "AUTO_CONFIRMED",
        summary: "Trang đạt chuẩn.",
      },
    ],
    decision_history: [],
    ...overrides,
  };
}

export function makeAdminUserBookQueueItem(
  overrides: Record<string, unknown> = {},
) {
  return {
    book_id: OPAQUE_BOOK_ID,
    book_title: "Sách gia đình bé An",
    book_author: "Gia đình bé An",
    owner_label: "Phụ huynh Kiểm thử",
    moderation_status: "ACTIVE" as "ACTIVE" | "SUSPENDED",
    queue_status: "PENDING_ADMIN" as const,
    pending_count: 1,
    flagged_count: 0,
    failed_count: 0,
    committed_page_count: 0,
    latest_submission_id: OPAQUE_SUBMISSION_ID,
    latest_request_id: makeOpaqueUuid(121, "87000000"),
    latest_submission_version: 1,
    latest_submitted_at: OPAQUE_NOW_ISO,
    policy_blocked: false,
    ...overrides,
  };
}

export function makeAdminUserBookSubmissionDetail(
  overrides: Record<string, unknown> = {},
) {
  return {
    submission_id: OPAQUE_SUBMISSION_ID,
    request_id: makeOpaqueUuid(121, "87000000"),
    book_id: OPAQUE_BOOK_ID,
    book_title: "Sách gia đình bé An",
    book_author: "Gia đình bé An",
    book_moderation_status: "ACTIVE" as const,
    book_suspended_reason: null as string | null,
    owner_label: "Phụ huynh Kiểm thử",
    source_file_name: "trang-1.png",
    source_format: "PNG",
    source_page_number: 1,
    batch_total_pages: 1,
    submission_version: 1,
    optimistic_lock_version: 1,
    snapshot_hash: OPAQUE_SHA256_A,
    source_sha256: OPAQUE_SHA256_B,
    image_width: 800,
    image_height: 1100,
    image_url: `/studio/assets/${OPAQUE_ASSET_ID}/media`,
    workflow_status: "PENDING_ADMIN" as const,
    workflow_status_label: "Chờ Admin duyệt",
    request_status: "PENDING",
    ocr_status: "COMPLETED",
    ocr_text: "Chú mèo nhỏ bước ra sân.",
    ocr_error_code: null as string | null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: "Chú mèo nhỏ bước ra sân.",
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null as string | null,
    candidate_text: "Chú mèo nhỏ bước ra sân.",
    tool_check_status: "FLAGGED",
    tool_check_suitability: "REVIEW_REQUIRED",
    tool_check_scope: {
      modality: "text_and_image",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: true,
      requires_admin_visual_review: true,
      copyright_scanner_status: "CLEAR",
      local_ai_enforced: true,
    },
    tool_check_findings: [],
    tool_check_policy_blocked: false,
    tool_check_error_code: null as string | null,
    tool_check_workflow_id: OPAQUE_WORKFLOW_ID,
    provider_events: [],
    source_type: "SELF_AUTHORED" as const,
    source_type_label: "Tự biên soạn / gia đình tự viết",
    source_note: "Gia đình tự viết",
    parent_request_note: "Nhờ Admin kiểm tra trang 1",
    can_approve: true,
    approve_blocked_reason: null as string | null,
    approved_snapshot_hash: null as string | null,
    approved_submission_version: null as number | null,
    admin_decision: null as string | null,
    admin_decision_reason: null as string | null,
    history: [],
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeMetadataCoverFallback(
  overrides: Record<string, unknown> = {},
) {
  return {
    palette_id: "sky",
    primary_color: "#0ea5e9",
    secondary_color: "#e0f2fe",
    accent_color: "#f59e0b",
    motif: "storybook",
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    grade_label: "Lớp 1–3",
    source_type: "METADATA_RENDER" as const,
    ...overrides,
  };
}

export function makeBookPresentationAsset(
  overrides: Record<string, unknown> = {},
) {
  const id = (overrides.id as string | undefined) ?? OPAQUE_ASSET_ID;
  return {
    id,
    book_id: OPAQUE_BOOK_ID,
    book_page_id: OPAQUE_PAGE_ID as string | null,
    source_revision_id: OPAQUE_REV_ID as string | null,
    asset_role: "PAGE_ILLUSTRATION" as const,
    source_type: "ORIGINAL_CROP" as const,
    media_url: `/studio/assets/${id}/media`,
    mime_type: "image/png",
    width: 600,
    height: 450,
    size_bytes: 2048,
    asset_hash: OPAQUE_SHA256_A,
    asset_version: 1,
    is_active: true,
    text_free_verified: true,
    moderation_status: "PENDING" as const,
    provider_name: null as string | null,
    model_id: null as string | null,
    job_id: null as string | null,
    metadata: { ocr_gate_mode: "text_free_verified" },
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeBookAssetsSummary(overrides: Record<string, unknown> = {}) {
  return {
    book_id: OPAQUE_BOOK_ID,
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    visibility_scope: "CATALOG",
    active_cover: null as ReturnType<typeof makeBookPresentationAsset> | null,
    effective_cover_source: "METADATA_RENDER" as
      "USER_UPLOAD" | "AI_GENERATED" | "METADATA_RENDER" | null,
    metadata_fallback: makeMetadataCoverFallback(),
    style_bible: null,
    page_illustrations: [] as Array<
      ReturnType<typeof makeBookPresentationAsset>
    >,
    ai_image_provider_available: true,
    ai_image_provider_name: "ViRead Zero-Cost Studio",
    ai_image_provider_message_vi: "Sẵn sàng tạo minh họa miễn phí.",
    v2_storage_degraded: false,
    ...overrides,
  };
}

export function makePageOcrExtraction(overrides: Record<string, unknown> = {}) {
  const blockKeepId = "blk-keep-1";
  const blockExclId = "blk-excl-1";
  const blockRevId = "blk-rev-1";
  return {
    extraction_id: OPAQUE_EXTRACTION_ID,
    book_id: OPAQUE_BOOK_ID,
    book_page_id: OPAQUE_PAGE_ID,
    page_revision_id: OPAQUE_REV_ID,
    source_hash: OPAQUE_SHA256_A,
    algorithm_version: "v2.1.0",
    filter_mode: "active" as const,
    page_kind: "TEXT_AND_IMAGE" as const,
    geometry_transform: null,
    blocks: [
      {
        block_id: blockKeepId,
        raw_text: "Chú mèo nhỏ bước ra sân.",
        display_text: "Chú mèo nhỏ bước ra sân.",
        bbox: [0.1, 0.15, 0.75, 0.12],
        reading_order: 0,
        column_index: 0,
        line_indices: [0],
        word_ids: ["w1", "w2"],
        source_word_indices: [0, 1],
        block_type: "STORY_BODY" as const,
        decision: "KEEP" as "KEEP" | "EXCLUDE" | "REVIEW",
        auto_decision: "KEEP" as const,
        reason_vi: "Nội dung truyện chính",
        reason_code: "STORY_BODY",
        decision_source: "GEOMETRIC" as const,
        confidence: 0.96,
        user_override: false,
        edited_text: null as string | null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
      {
        block_id: blockExclId,
        raw_text: "Trang 1",
        display_text: "Trang 1",
        bbox: [0.45, 0.92, 0.1, 0.04],
        reading_order: 1,
        column_index: 0,
        line_indices: [1],
        word_ids: ["w3"],
        source_word_indices: [2],
        block_type: "PAGE_NUMBER" as const,
        decision: "EXCLUDE" as "KEEP" | "EXCLUDE" | "REVIEW",
        auto_decision: "EXCLUDE" as const,
        reason_vi: "Số trang ở mép dưới",
        reason_code: "PAGE_NUMBER",
        decision_source: "GEOMETRIC" as const,
        confidence: 0.99,
        user_override: false,
        edited_text: null as string | null,
        cross_page_matches: [],
        in_canonical: false,
        audit_trail: [],
      },
      {
        block_id: blockRevId,
        raw_text: "Chú thích tranh mèo con",
        display_text: "Chú thích tranh mèo con",
        bbox: [0.15, 0.65, 0.5, 0.08],
        reading_order: 2,
        column_index: 0,
        line_indices: [2],
        word_ids: ["w4"],
        source_word_indices: [3],
        block_type: "READING_CAPTION" as const,
        decision: "REVIEW" as "KEEP" | "EXCLUDE" | "REVIEW",
        auto_decision: "REVIEW" as const,
        reason_vi: "Cần xác minh xem có đọc thành tiếng hay không",
        reason_code: "CAPTION_REVIEW",
        decision_source: "SEMANTIC_AI" as const,
        confidence: 0.72,
        user_override: false,
        edited_text: null as string | null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
    ],
    canonical_text: "Chú mèo nhỏ bước ra sân.\nChú thích tranh mèo con",
    canonical_words: [
      {
        word_id: "w1",
        source_word_index: 0,
        block_id: blockKeepId,
        reading_order: 0,
        line_index: 0,
        text: "Chú",
        normalized_text: "chú",
        bbox: [0.1, 0.15, 0.1, 0.05],
        confidence: 0.96,
      },
    ],
    stats: {
      total_blocks: 3,
      keep_blocks: 1,
      exclude_blocks: 1,
      review_blocks: 1,
      total_chars: 54,
      kept_chars: 24,
      excluded_chars: 7,
      review_chars: 23,
      retention_ratio: 0.87,
      circuit_breaker_triggered: false,
      fast_path_ms: 12,
      cross_page_ms: 5,
      semantic_ai_ms: 20,
      total_ms: 37,
      semantic_ai_invoked: true,
      semantic_ai_fallback_used: false,
      semantic_ai_error_code: null,
    },
    requires_review: true,
    undo_available: false,
    undo_depth: 0,
    persisted: true,
    storage_degraded: false,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function makeGlobalTaskItem(
  overrides: Partial<GlobalTaskItemPayload> = {},
): GlobalTaskItemPayload {
  return {
    id: OPAQUE_TASK_ID,
    source: "smart_studio_job",
    job_type: "COVER_GENERATION",
    title_vi: "Tạo ảnh bìa AI cho sách Chú Mèo Đi Hia",
    book_id: OPAQUE_BOOK_ID,
    book_page_id: OPAQUE_PAGE_ID,
    book_title: "Chú Mèo Đi Hia",
    page_number: 1,
    source_revision_id: OPAQUE_REV_ID,
    actor_role: "admin",
    status: "FAILED",
    status_label_vi: "Thất bại",
    stage: "RENDER_COVER",
    stage_label_vi: "Tạo ảnh bìa",
    priority: 10,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: null,
    progress_total: null,
    progress_unit: null,
    progress_pct: null,
    is_indeterminate: true,
    can_retry: true,
    can_cancel: false,
    result_href: null,
    result_ref: {},
    checkpoints: {},
    error_code: "PROVIDER_TIMEOUT",
    error_message_vi: "Tạm thời quá thời gian xử lý.",
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    started_at: OPAQUE_NOW_ISO,
    completed_at: null,
    ...overrides,
  };
}

export function makeAdminGlobalTaskList(
  overrides: Partial<GlobalTaskListPayload> = {},
): GlobalTaskListPayload {
  return makeGlobalTaskList({
    actor_id: OPAQUE_ADMIN_ID,
    actor_role: "admin",
    failed_count: 1,
    tasks: [makeGlobalTaskItem({ actor_role: "admin" })],
    ...overrides,
  });
}

export function makeVireadDriveStatus(overrides: Record<string, unknown> = {}) {
  return {
    provider: "google_drive",
    migration_applied: true,
    status: "CONNECTED",
    connected: true,
    connection_mode: "apps_script_bridge",
    oauth_configured: true,
    oauth_readiness: {
      oauth_configured: true,
      client_id_configured: true,
      client_secret_configured: true,
      redirect_uri_configured: true,
      encryption_key_configured: true,
      required_scope: "https://www.googleapis.com/auth/drive.file",
      required_account_email: "admin-ocr@viread.local",
    },
    apps_script_readiness: {
      bridge_ready: true,
      encryption_key_configured: true,
      server_secret_configured: true,
      web_app_url_configured: true,
      required_account_email: "admin-ocr@viread.local",
    },
    drive_desktop_readiness: {
      desktop_ready: false,
      encryption_key_configured: true,
      detected_mounts: [],
      default_mount_path: null,
      required_account_email: "admin-ocr@viread.local",
    },
    required_account_email: "admin-ocr@viread.local",
    account_email: "admin-ocr@viread.local",
    account_display_name: "ViRead Training Storage",
    oauth_scope: "apps_script_bridge",
    scope_valid: true,
    root_folder_id: "drive-folder-001",
    root_folder_path: "/ViRead-Flow2-Training",
    subfolder_ids: { datasets: "sub-1", checkpoints: "sub-2" },
    quota: {
      limit_bytes: 15 * 1024 * 1024 * 1024,
      usage_bytes: 2 * 1024 * 1024 * 1024,
      usage_in_drive_bytes: 2 * 1024 * 1024 * 1024,
      usage_in_trash_bytes: 0,
      available_bytes: 13 * 1024 * 1024 * 1024,
      min_free_buffer_bytes: 512 * 1024 * 1024,
      max_training_budget_bytes: 10 * 1024 * 1024 * 1024,
      warning_level: "OK",
      can_accept_upload: true,
      checked_at: OPAQUE_NOW_ISO,
      detail: "OK",
    },
    last_health_check_at: OPAQUE_NOW_ISO,
    last_health_status: "OK",
    last_error_code: null as string | null,
    connected_at: OPAQUE_NOW_ISO,
    disconnected_at: null as string | null,
    health_detail: "Kết nối ổn định (13.0 GiB trống).",
    google_token_revoked: false,
    ...overrides,
  };
}

export function makeVireadTrainingOverview(
  overrides: Record<string, unknown> = {},
) {
  const driveStatus = makeVireadDriveStatus();
  return {
    outbox: [
      { status: "PENDING", count: 2 },
      { status: "DONE", count: 40 },
    ],
    samples: [
      { source_flow: "FLOW1_VERIFIED", split: "train", count: 180 },
      { source_flow: "FLOW1_VERIFIED", split: "validation", count: 30 },
      { source_flow: "FLOW1_VERIFIED", split: "holdout", count: 25 },
    ],
    jobs: [
      {
        job_id: OPAQUE_TRAINING_JOB_ID,
        profile: "FLOW2_ADMIN_VERIFIED",
        target: "COLAB",
        status: "CANDIDATE",
        dataset_version_id: OPAQUE_DATASET_ID,
        manifest_sha256: OPAQUE_SHA256_A,
        config_sha256: OPAQUE_SHA256_B,
        parent_checkpoint_sha256: OPAQUE_SHA256_C,
        run_id: OPAQUE_TRAINING_RUN_ID,
        run_status: "CANDIDATE",
        run_config_sha256: OPAQUE_SHA256_B,
        generation: 2,
        candidate_has_benchmark: true,
        attempts: 1,
        evaluation_attempts: 1,
        progress: {
          stage: "COMPLETED",
          completed_steps: 200,
          total_steps: 200,
        },
        last_error_code: null as string | null,
        metadata: {},
        colab_execution_id: null,
        colab_execution_resource_name: null,
        colab_operation_name: null,
        worker_id: null,
        lease_expires_at: null,
        locked_test_version_id: makeOpaqueUuid(130, "86000000"),
        locked_test_manifest_sha256: OPAQUE_SHA256_C,
        created_at: OPAQUE_NOW_ISO,
        updated_at: OPAQUE_NOW_ISO,
      },
    ],
    runs: [
      {
        run_id: OPAQUE_TRAINING_RUN_ID,
        profile: "FLOW2_ADMIN_VERIFIED",
        status: "BENCHMARKED",
        parent_checkpoint_sha256: OPAQUE_SHA256_C,
        manifest_sha256: OPAQUE_SHA256_A,
        checkpoint_sha256: OPAQUE_SHA256_B,
        checkpoint_storage_path: "checkpoints/v2.pth",
        step: 200,
        created_at: OPAQUE_NOW_ISO,
      },
    ],
    benchmarks: [
      {
        benchmark_id: OPAQUE_BENCHMARK_ID,
        run_id: OPAQUE_TRAINING_RUN_ID,
        gate_status: "V2_WIN",
        sample_count: 220,
        group_count: 35,
        candidate_checkpoint_sha256: OPAQUE_SHA256_B,
        locked_test_manifest_sha256: OPAQUE_SHA256_C,
        created_at: OPAQUE_NOW_ISO,
        evaluation_type: "PRODUCTION",
      },
    ],
    active_model: {
      model_family: "vietocr",
      checkpoint_sha256: OPAQUE_SHA256_C,
      storage_path: "models/viread-v1.pth",
      storage_provider: "google_drive",
      drive_file_id: "drive-model-1",
      profile: "FLOW1_EXTERNAL_TRDG",
      decision_id: makeOpaqueUuid(131, "86000000"),
      updated_at: OPAQUE_NOW_ISO,
      version_label: "viread-vietocr-v1.0",
      weights_filename: "viread-v1.pth",
      config_source: "default",
      config_filename: null,
      source: "flow1_manual",
      comparison_summary: null,
    },
    locked_test: {
      status: "READY",
      version_id: makeOpaqueUuid(130, "86000000"),
      manifest_sha256: OPAQUE_SHA256_C,
      sample_count: 220,
      group_count: 35,
      eligible_sample_count: 220,
      eligible_group_count: 35,
      missing_sample_count: 0,
      missing_group_count: 0,
      minimum_samples: 200,
      minimum_groups: 30,
    },
    google_drive: driveStatus,
    runtime_model: {
      initialized: true,
      initialization_status: "READY",
      initialization_error: null,
      loaded_profile: "FLOW1_EXTERNAL_TRDG",
      loaded_checkpoint_sha256: OPAQUE_SHA256_C,
      loaded_config_sha256: OPAQUE_SHA256_A,
      verified_runtime_proof: true,
      desired_profile: "FLOW1_EXTERNAL_TRDG",
      desired_checkpoint_sha256: OPAQUE_SHA256_C,
      matches_desired: true,
      status_label: "Khớp mô hình mục tiêu",
    },
    storage_summary: {
      flow2_write_provider: "google_drive",
      flow2_drive_synced_samples: 210,
      flow2_legacy_samples: 25,
      flow2_verified_total_samples: 235,
      flow2_pending_verification_samples: 4,
      flow2_excluded_samples: 1,
      flow2_train_samples: 180,
      flow2_validation_samples: 30,
      flow2_holdout_samples: 25,
      dataset_ready_for_training: true,
      evaluation_ready_for_model_replacement: true,
      outbox_pending: 2,
      outbox_retry: 0,
      outbox_dead: 0,
      outbox_blocked: 0,
      outbox_skipped: 0,
      outbox_done: 40,
      flow2_blockers: [],
    },
    worker_status: {
      local_training_enabled: false,
      local_gpu_ready: false,
      web_heavy_workers_disabled: true,
      execution_mode: "remote_colab",
    },
    flow2_blockers: [],
    ...overrides,
  };
}

export function makeFlow2TriggerResponse(
  overrides: Record<string, unknown> = {},
) {
  return {
    scheduled: 1,
    reason: "SCHEDULED",
    job_id: makeOpaqueUuid(140, "86000000"),
    status: "WAITING_FOR_COLAB_WORKER",
    target: "COLAB",
    dataset_version_id: OPAQUE_DATASET_ID,
    manifest_sha256: OPAQUE_SHA256_A,
    config_sha256: OPAQUE_SHA256_B,
    parent_checkpoint_sha256: OPAQUE_SHA256_C,
    generation: 3,
    train_count: 180,
    validation_count: 30,
    locked_test_ready: true,
    ...overrides,
  };
}

export function makeFlow1ComparisonPayload(better = true) {
  return {
    models: {
      baseline: "vietocr-baseline",
      finetuned_model_only: "viread-v2-model",
      finetuned_full_pipeline: "viread-v2-pipeline",
    },
    sgk_real_test: {
      cer_pct: {
        baseline: 6.5,
        finetuned_model_only: better ? 3.2 : 8.1,
        finetuned_full_pipeline: better ? 2.4 : 7.9,
      },
      wer_pct: {
        baseline: 14.0,
        finetuned_model_only: better ? 7.5 : 16.2,
        finetuned_full_pipeline: better ? 5.8 : 15.8,
      },
    },
  };
}

export interface Cluster2ApiState {
  role: "parent" | "admin";
  catalogBooks: CatalogBookPayload[];
  previewsByBook: Record<string, CatalogPagePreviewPayload[]>;
  privateBooks: Array<ReturnType<typeof makePrivateBookDetail>>;
  adminCatalog: AdminCatalogItemPayload[];
  adminPagesByBook: Record<
    string,
    Array<ReturnType<typeof makeAdminPageListItem>>
  >;
  adminRevisionsByPage: Record<
    string,
    ReturnType<typeof makeAdminRevisionDetail>
  >;
  adminWorkflowsByPage: Record<
    string,
    ReturnType<typeof makeAdminAiWorkflow> | null
  >;
  metadataQuality: ReturnType<typeof makeMetadataQualityResponse>;
  qualityReports: Array<ReturnType<typeof makeAdminQualityReportDetail>>;
  qualityBooks: Array<ReturnType<typeof makeAdminQualityBookDetail>>;
  userBookQueue: Array<ReturnType<typeof makeAdminUserBookQueueItem>>;
  userBookSubmissions: Record<
    string,
    ReturnType<typeof makeAdminUserBookSubmissionDetail>
  >;
  parentReports: Array<ReturnType<typeof makeParentBookReport>>;
  assetsByBook: Record<string, ReturnType<typeof makeBookAssetsSummary>>;
  extractionsByPage: Record<string, ReturnType<typeof makePageOcrExtraction>>;
  globalTasks: GlobalTaskListPayload;
  trainingOverview: ReturnType<typeof makeVireadTrainingOverview>;
  faults: Record<string, ApiMockResponse>;
  nextId: number;
}

export function createCluster2ApiState(
  overrides: Partial<Cluster2ApiState> = {},
): Cluster2ApiState {
  const role = overrides.role ?? "parent";
  const defaultBook = makeCatalogBook({
    id: OPAQUE_BOOK_ID,
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    cover_url:
      "https://example.supabase.co/storage/v1/object/public/book-pages/cover-1.png",
    cover_source_type: "USER_UPLOAD",
  });
  const defaultPrivateBook = makePrivateBookDetail({
    book: makePrivateBookListItem({ id: OPAQUE_BOOK_ID }),
  });

  return {
    role,
    catalogBooks: [defaultBook],
    previewsByBook: {
      [OPAQUE_BOOK_ID]: [
        makeCatalogPagePreview({
          page_id: OPAQUE_PAGE_ID,
          page_number: 1,
        }),
        makeCatalogPagePreview({
          page_id: makeOpaqueUuid(12, "83000000"),
          page_number: 2,
          current_verified_revision_id: makeOpaqueUuid(12, "84000000"),
        }),
      ],
    },
    privateBooks: [defaultPrivateBook],
    adminCatalog: [makeAdminCatalogItem()],
    adminPagesByBook: {
      [OPAQUE_BOOK_ID]: [makeAdminPageListItem()],
    },
    adminRevisionsByPage: {
      [OPAQUE_PAGE_ID]: makeAdminRevisionDetail(),
    },
    adminWorkflowsByPage: {
      [OPAQUE_PAGE_ID]: makeAdminAiWorkflow(),
    },
    metadataQuality: makeMetadataQualityResponse(),
    qualityReports: [makeAdminQualityReportDetail()],
    qualityBooks: [makeAdminQualityBookDetail()],
    userBookQueue: [makeAdminUserBookQueueItem()],
    userBookSubmissions: {
      [OPAQUE_SUBMISSION_ID]: makeAdminUserBookSubmissionDetail(),
    },
    parentReports: [makeParentBookReport()],
    assetsByBook: {
      [OPAQUE_BOOK_ID]: makeBookAssetsSummary(),
    },
    extractionsByPage: {
      [OPAQUE_PAGE_ID]: makePageOcrExtraction(),
    },
    globalTasks:
      role === "admin"
        ? makeAdminGlobalTaskList()
        : makeGlobalTaskList({
            actor_id: OPAQUE_PARENT_ID,
            actor_role: "parent",
            failed_count: 1,
            tasks: [
              makeGlobalTaskItem({
                actor_role: "parent",
                title_vi: "Kiểm tra trang sách gia đình",
              }),
            ],
          }),
    trainingOverview: makeVireadTrainingOverview(),
    faults: {},
    nextId: 200,
    ...overrides,
  };
}

export function createCluster2ApiHandler(
  state: Cluster2ApiState,
): ApiMockHandlers {
  return (ctx: ApiMockRequestContext): ApiMockResponse | undefined => {
    const faultKey = `${ctx.method} ${ctx.pathname}`;
    if (state.faults[faultKey]) return state.faults[faultKey];
    if (state.faults[ctx.pathname]) return state.faults[ctx.pathname];

    if (ctx.method === "GET" && ctx.pathname === "/health") {
      return { status: 200, body: makeHealthPayload() };
    }

    if (ctx.method === "GET" && ctx.pathname === "/profiles/me") {
      return {
        status: 200,
        body:
          state.role === "admin"
            ? makeParentProfile({
                id: OPAQUE_ADMIN_ID,
                role: "admin",
                display_name: "Quản trị viên ViRead",
                email: "admin@viread.local",
                children: [],
              })
            : makeParentProfile(),
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/profiles/children") {
      return { status: 200, body: [makeChildProfile()] };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/reading-management/collections"
    ) {
      return { status: 200, body: [] };
    }

    // F-05 Catalog
    if (
      ctx.method === "GET" &&
      (ctx.pathname === "/books/catalog" || ctx.pathname === "/books/")
    ) {
      const gradeParam = ctx.url.searchParams.get("grade");
      const searchParam = (ctx.url.searchParams.get("search") ?? "")
        .trim()
        .toLowerCase();
      let items = [...state.catalogBooks];
      if (gradeParam) {
        const g = Number(gradeParam);
        if (Number.isFinite(g)) {
          items = items.filter((b) => b.min_grade <= g && b.max_grade >= g);
        }
      }
      if (searchParam) {
        items = items.filter(
          (b) =>
            b.title.toLowerCase().includes(searchParam) ||
            (b.author ?? "").toLowerCase().includes(searchParam),
        );
      }
      return { status: 200, body: items };
    }

    const catalogPreviewMatch = /^\/books\/catalog\/([^/]+)\/preview$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && catalogPreviewMatch) {
      const bookId = decodeURIComponent(catalogPreviewMatch[1] ?? "");
      return { status: 200, body: state.previewsByBook[bookId] ?? [] };
    }

    const catalogReportCreateMatch =
      /^\/books\/catalog\/([^/]+)\/reports$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && catalogReportCreateMatch) {
      const bookId = decodeURIComponent(catalogReportCreateMatch[1] ?? "");
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const newReport = makeParentBookReport({
        id: makeOpaqueUuid((state.nextId += 1), "85000000"),
        book_id: bookId,
        description:
          typeof body.description === "string"
            ? body.description
            : "Báo cáo mới",
        issue_type:
          typeof body.issue_type === "string"
            ? body.issue_type
            : "SPELLING_ERROR",
      });
      state.parentReports.unshift(newReport);
      state.qualityReports.unshift(newReport);
      return { status: 201, body: newReport };
    }

    const catalogDetailMatch = /^\/books\/catalog\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && catalogDetailMatch) {
      const bookId = decodeURIComponent(catalogDetailMatch[1] ?? "");
      const found = state.catalogBooks.find((b) => b.id === bookId);
      if (!found) {
        return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      }
      return { status: 200, body: found };
    }

    // F-18 Parent Reports
    if (ctx.method === "GET" && ctx.pathname === "/books/reports/mine") {
      return {
        status: 200,
        body: makeParentBookReportList(state.parentReports),
      };
    }

    const myReportDetailMatch = /^\/books\/reports\/mine\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && myReportDetailMatch) {
      const rid = decodeURIComponent(myReportDetailMatch[1] ?? "");
      const found = state.parentReports.find((r) => r.id === rid);
      return found
        ? { status: 200, body: found }
        : { status: 404, body: { detail: "REPORT_NOT_FOUND" } };
    }

    // F-06 Parent Private Books
    if (ctx.method === "GET" && ctx.pathname === "/books/my-books/paged") {
      return {
        status: 200,
        body: makePrivateBookPagedResponse(
          state.privateBooks.map((d) => d.book),
        ),
      };
    }
    if (ctx.method === "GET" && ctx.pathname === "/books/my-books") {
      return { status: 200, body: state.privateBooks.map((d) => d.book) };
    }
    if (ctx.method === "POST" && ctx.pathname === "/books/my-books") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const id = makeOpaqueUuid((state.nextId += 1), "82000000");
      const createdBook = makePrivateBookListItem({
        id,
        title: typeof body.title === "string" ? body.title : "Sách mới",
        author: typeof body.author === "string" ? body.author : null,
        min_grade: typeof body.min_grade === "number" ? body.min_grade : 1,
        max_grade: typeof body.max_grade === "number" ? body.max_grade : 3,
      });
      state.privateBooks.unshift(makePrivateBookDetail({ book: createdBook }));
      return { status: 201, body: createdBook };
    }

    const privateContribMatch =
      /^\/books\/my-books\/([^/]+)\/ocr-contribution$/u.exec(ctx.pathname);
    if (privateContribMatch) {
      const bid = decodeURIComponent(privateContribMatch[1] ?? "");
      const detail = state.privateBooks.find((d) => d.book.id === bid);
      if (!detail) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      if (ctx.method === "PUT") {
        const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
        const enabled = Boolean(body.enabled);
        const nextContrib = makePrivateBookOcrContribution({
          book_id: bid,
          enabled,
          status: enabled ? "OPTED_IN" : "REVOKED",
          consent_version: enabled ? 1 : 0,
          rights_confirmed: enabled,
          consented_at: enabled ? OPAQUE_NOW_ISO : null,
          revoked_at: enabled ? null : OPAQUE_NOW_ISO,
          status_notice: enabled
            ? "Đã bật đóng góp mẫu nhận diện."
            : "Đã ngừng đóng góp mẫu nhận diện.",
        });
        detail.book = { ...detail.book, ocr_contribution: nextContrib };
        return { status: 200, body: nextContrib };
      }
      return { status: 200, body: detail.book.ocr_contribution };
    }

    const privateAcceptSpellingMatch =
      /^\/books\/my-books\/([^/]+)\/submissions\/([^/]+)\/accept-spelling$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && privateAcceptSpellingMatch) {
      const bid = decodeURIComponent(privateAcceptSpellingMatch[1] ?? "");
      const sid = decodeURIComponent(privateAcceptSpellingMatch[2] ?? "");
      const detail = state.privateBooks.find((d) => d.book.id === bid);
      const subIdx = detail?.submissions.findIndex((s) => s.id === sid) ?? -1;
      if (!detail || subIdx === -1) {
        return { status: 404, body: { detail: "SUBMISSION_NOT_FOUND" } };
      }
      detail.submissions[subIdx] = {
        ...detail.submissions[subIdx]!,
        spelling_accepted: true,
        can_add_to_book: true,
        workflow_status: "PASSED_READY_TO_ADD",
      };
      return { status: 200, body: detail.submissions[subIdx] };
    }

    const privateAddPageMatch =
      /^\/books\/my-books\/([^/]+)\/submissions\/([^/]+)\/add-page$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && privateAddPageMatch) {
      const bid = decodeURIComponent(privateAddPageMatch[1] ?? "");
      const sid = decodeURIComponent(privateAddPageMatch[2] ?? "");
      const detail = state.privateBooks.find((d) => d.book.id === bid);
      const subIdx = detail?.submissions.findIndex((s) => s.id === sid) ?? -1;
      if (!detail || subIdx === -1) {
        return { status: 404, body: { detail: "SUBMISSION_NOT_FOUND" } };
      }
      const newPageId = makeOpaqueUuid((state.nextId += 1), "83000000");
      const newRevId = makeOpaqueUuid((state.nextId += 1), "84000000");
      const pageNum = detail.pages.length + 1;
      detail.submissions[subIdx] = {
        ...detail.submissions[subIdx]!,
        workflow_status: "ADDED_TO_BOOK",
        can_add_to_book: false,
        committed_page_id: newPageId,
        committed_revision_id: newRevId,
      };
      detail.pages.push(
        makePrivateBookCommittedPage({
          page_id: newPageId,
          page_number: pageNum,
          current_verified_revision_id: newRevId,
          verified_text:
            detail.submissions[subIdx]!.candidate_text ?? "Trang sách mới",
          verified_text_preview:
            detail.submissions[subIdx]!.candidate_text ?? "Trang sách mới",
        }),
      );
      detail.book = {
        ...detail.book,
        committed_page_count: detail.pages.length,
        readable_for_children: true,
      };
      return {
        status: 200,
        body: {
          book_id: bid,
          page_id: newPageId,
          page_number: pageNum,
          revision_id: newRevId,
          submission: detail.submissions[subIdx],
          book_readable_for_children: true,
        },
      };
    }

    const privateSubmissionsMatch =
      /^\/books\/my-books\/([^/]+)\/submissions$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && privateSubmissionsMatch) {
      const bid = decodeURIComponent(privateSubmissionsMatch[1] ?? "");
      const detail = state.privateBooks.find((d) => d.book.id === bid);
      if (!detail) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      const isPdf = (ctx.postDataText ?? "").includes(".pdf");
      const subId = makeOpaqueUuid((state.nextId += 1), "87000000");
      const createdSub = makePrivateBookSubmission({
        id: subId,
        book_id: bid,
        source_file_name: isPdf ? "sach-mau.pdf" : "trang-1.png",
        source_format: isPdf ? "PDF" : "PNG",
        source_page_number: detail.submissions.length + 1,
        target_page_number: detail.submissions.length + 1,
      });
      detail.submissions.unshift(createdSub);
      return {
        status: 201,
        body: {
          book_id: bid,
          batch_id: OPAQUE_BATCH_ID,
          source_format: isPdf ? "PDF" : "PNG",
          total_pages: 1,
          replayed_idempotency: false,
          submissions: [createdSub],
        },
      };
    }

    const privateBookDetailMatch = /^\/books\/my-books\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (privateBookDetailMatch) {
      const bid = decodeURIComponent(privateBookDetailMatch[1] ?? "");
      const detail = state.privateBooks.find((d) => d.book.id === bid);
      if (!detail) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      if (ctx.method === "GET") return { status: 200, body: detail };
      if (ctx.method === "DELETE") {
        return {
          status: 200,
          body: {
            status: "deleted" as const,
            book_id: bid,
            retired_pages_count: detail.pages.length,
            cancelled_submissions_count: detail.submissions.length,
          },
        };
      }
    }

    // F-18 Admin Catalog & Pages & OCR Review
    if (ctx.method === "GET" && ctx.pathname === "/books/admin/catalog") {
      return { status: 200, body: state.adminCatalog };
    }
    if (ctx.method === "POST" && ctx.pathname === "/books/admin/catalog") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const bid = makeOpaqueUuid((state.nextId += 1), "82000000");
      const created = makeAdminBookDetail({
        id: bid,
        name: typeof body.name === "string" ? body.name : "sach-moi",
        title: typeof body.title === "string" ? body.title : "Sách mới",
        author: typeof body.author === "string" ? body.author : null,
        min_grade: typeof body.min_grade === "number" ? body.min_grade : 1,
        max_grade: typeof body.max_grade === "number" ? body.max_grade : 3,
      });
      state.adminCatalog.unshift(
        makeAdminCatalogItem({
          book: created,
          page_count: 0,
          verified_count: 0,
        }),
      );
      state.adminPagesByBook[bid] = [];
      return { status: 201, body: created };
    }

    const adminPagesMatch = /^\/books\/admin\/catalog\/([^/]+)\/pages$/u.exec(
      ctx.pathname,
    );
    if (adminPagesMatch) {
      const bid = decodeURIComponent(adminPagesMatch[1] ?? "");
      if (ctx.method === "GET") {
        return { status: 200, body: state.adminPagesByBook[bid] ?? [] };
      }
      if (ctx.method === "POST") {
        const rev = makeAdminRevisionDetail();
        return { status: 201, body: rev };
      }
    }

    const adminPagesJobsMatch =
      /^\/books\/admin\/catalog\/([^/]+)\/pages\/jobs$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && adminPagesJobsMatch) {
      const bid = decodeURIComponent(adminPagesJobsMatch[1] ?? "");
      return {
        status: 200,
        body: makeAdminOcrJob({ book_id: bid, status: "SUCCEEDED" }),
      };
    }

    const adminDocsJobsMatch =
      /^\/books\/admin\/catalog\/([^/]+)\/documents\/jobs$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && adminDocsJobsMatch) {
      const bid = decodeURIComponent(adminDocsJobsMatch[1] ?? "");
      return {
        status: 200,
        body: {
          book_id: bid,
          source_format: "PDF",
          total_source_pages: 1,
          job_ids: [OPAQUE_TASK_ID],
          queued_count: 1,
          worker_online: true,
          jobs: [makeAdminOcrJob({ book_id: bid, status: "SUCCEEDED" })],
        },
      };
    }

    const adminBookOcrJobsMatch =
      /^\/books\/admin\/catalog\/([^/]+)\/ocr-jobs$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && adminBookOcrJobsMatch) {
      return { status: 200, body: [] };
    }

    const adminBookDetailMatch = /^\/books\/admin\/catalog\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (adminBookDetailMatch) {
      const bid = decodeURIComponent(adminBookDetailMatch[1] ?? "");
      const found = state.adminCatalog.find((item) => item.book.id === bid);
      if (ctx.method === "GET") {
        return {
          status: 200,
          body: makeAdminBookDetail(
            found ? { ...found.book, id: bid } : { id: bid },
          ),
        };
      }
      if (ctx.method === "PUT") {
        const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
        return {
          status: 200,
          body: makeAdminBookDetail({
            id: bid,
            title:
              typeof body.title === "string"
                ? body.title
                : (found?.book.title ?? "Chú Mèo Đi Hia"),
          }),
        };
      }
    }

    // Admin Page OCR Review routes
    const adminPageImageMatch = /^\/books\/admin\/pages\/([^/]+)\/image$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && adminPageImageMatch) {
      const pid = decodeURIComponent(adminPageImageMatch[1] ?? "");
      const rev =
        state.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid });
      return {
        status: 200,
        body: {
          page_id: pid,
          page_revision_id: rev.page_revision_id,
          page_number: 1,
          preview_url:
            "https://example.supabase.co/storage/v1/object/public/book-pages/page-1.png",
          width: 800,
          height: 1100,
        },
      };
    }

    const adminPageBookMatch = /^\/books\/admin\/pages\/([^/]+)\/book$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && adminPageBookMatch) {
      return { status: 200, body: makeAdminBookDetail() };
    }

    const adminPageProcessingMatch =
      /^\/books\/admin\/pages\/([^/]+)\/processing$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && adminPageProcessingMatch) {
      const pid = decodeURIComponent(adminPageProcessingMatch[1] ?? "");
      const rev =
        state.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid });
      return {
        status: 200,
        body: makeAdminPageProcessing({
          page_id: pid,
          page_revision_id: rev.page_revision_id,
          verification_status: rev.verification_status,
        }),
      };
    }

    const adminRevisionsListMatch =
      /^\/books\/admin\/pages\/([^/]+)\/revisions$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && adminRevisionsListMatch) {
      const pid = decodeURIComponent(adminRevisionsListMatch[1] ?? "");
      const rev =
        state.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid });
      return {
        status: 200,
        body: [
          makeAdminRevisionSummary({
            page_revision_id: rev.page_revision_id,
            revision_no: rev.revision_no,
            verification_status: rev.verification_status,
            is_current_verified: rev.verification_status === "VERIFIED",
          }),
        ],
      };
    }

    const adminDraftCreateMatch =
      /^\/books\/admin\/pages\/([^/]+)\/revisions\/draft$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && adminDraftCreateMatch) {
      const pid = decodeURIComponent(adminDraftCreateMatch[1] ?? "");
      const rev = makeAdminRevisionDetail({
        page_id: pid,
        page_revision_id: makeOpaqueUuid((state.nextId += 1), "84000000"),
        revision_no: 2,
        verification_status: "NEEDS_REVIEW",
      });
      state.adminRevisionsByPage[pid] = rev;
      return { status: 201, body: rev };
    }

    const adminSaveDraftMatch =
      /^\/books\/admin\/pages\/([^/]+)\/revisions\/([^/]+)\/draft$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "PUT" && adminSaveDraftMatch) {
      const pid = decodeURIComponent(adminSaveDraftMatch[1] ?? "");
      const rid = decodeURIComponent(adminSaveDraftMatch[2] ?? "");
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const current =
        state.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid, page_revision_id: rid });
      const next = {
        ...current,
        page_id: pid,
        page_revision_id: rid,
        draft_text:
          typeof body.draft_text === "string"
            ? body.draft_text
            : current.draft_text,
      };
      state.adminRevisionsByPage[pid] = next;
      return { status: 200, body: next };
    }

    const adminLatestWorkflowMatch =
      /^\/books\/admin\/pages\/([^/]+)\/revisions\/([^/]+)\/ai-workflows\/latest$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "GET" && adminLatestWorkflowMatch) {
      const pid = decodeURIComponent(adminLatestWorkflowMatch[1] ?? "");
      return { status: 200, body: state.adminWorkflowsByPage[pid] ?? null };
    }

    const adminRevisionGetMatch =
      /^\/books\/admin\/pages\/([^/]+)\/revisions\/([^/]+)$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "GET" && adminRevisionGetMatch) {
      const pid = decodeURIComponent(adminRevisionGetMatch[1] ?? "");
      const rid = decodeURIComponent(adminRevisionGetMatch[2] ?? "");
      const current = state.adminRevisionsByPage[pid];
      if (rid === "latest" || !current) {
        return {
          status: 200,
          body:
            current ??
            makeAdminRevisionDetail({
              page_id: pid,
              page_revision_id: OPAQUE_REV_ID,
            }),
        };
      }
      return {
        status: 200,
        body: { ...current, page_id: pid, page_revision_id: rid },
      };
    }

    const adminVerifyMatch = /^\/books\/admin\/pages\/([^/]+)\/verify$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && adminVerifyMatch) {
      const pid = decodeURIComponent(adminVerifyMatch[1] ?? "");
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const current =
        state.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid });
      const verified = {
        ...current,
        page_id: pid,
        page_revision_id:
          typeof body.page_revision_id === "string"
            ? body.page_revision_id
            : current.page_revision_id,
        draft_text:
          typeof body.corrected_text === "string"
            ? body.corrected_text
            : current.draft_text,
        verification_status: "VERIFIED" as const,
        verified_at: OPAQUE_NOW_ISO,
        verified_by: OPAQUE_ADMIN_ID,
      };
      state.adminRevisionsByPage[pid] = verified;
      return { status: 200, body: verified };
    }

    const adminAiWorkflowPostMatch =
      /^\/books\/admin\/pages\/([^/]+)\/ai-workflows$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && adminAiWorkflowPostMatch) {
      const pid = decodeURIComponent(adminAiWorkflowPostMatch[1] ?? "");
      const wf = makeAdminAiWorkflow({ page_id: pid });
      state.adminWorkflowsByPage[pid] = wf;
      return { status: 200, body: wf };
    }

    // F-18 Quality Hub
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/metadata-quality"
    ) {
      return { status: 200, body: state.metadataQuality };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/quality/reports"
    ) {
      return {
        status: 200,
        body: {
          items: state.qualityReports,
          total: state.qualityReports.length,
          summary: {
            OPEN: state.qualityReports.filter((r) => r.status === "OPEN")
              .length,
            UNDER_REVIEW: state.qualityReports.filter(
              (r) => r.status === "UNDER_REVIEW",
            ).length,
            RESOLVED: state.qualityReports.filter(
              (r) => r.status === "RESOLVED",
            ).length,
            REJECTED: state.qualityReports.filter(
              (r) => r.status === "REJECTED",
            ).length,
            REPORTED_BOOKS: 1,
            REPORTED_PAGES: 1,
          },
          limit: 10,
          offset: 0,
        },
      };
    }

    const qualityReportStatusMatch =
      /^\/books\/admin\/quality\/reports\/([^/]+)\/status$/u.exec(ctx.pathname);
    if (ctx.method === "PATCH" && qualityReportStatusMatch) {
      const rid = decodeURIComponent(qualityReportStatusMatch[1] ?? "");
      const idx = state.qualityReports.findIndex((r) => r.id === rid);
      if (idx === -1) {
        return { status: 404, body: { detail: "REPORT_NOT_FOUND" } };
      }
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      state.qualityReports[idx] = {
        ...state.qualityReports[idx]!,
        status:
          typeof body.status === "string"
            ? (body.status as "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "REJECTED")
            : state.qualityReports[idx]!.status,
        admin_resolution_note:
          typeof body.resolution_note === "string"
            ? body.resolution_note
            : state.qualityReports[idx]!.admin_resolution_note,
      };
      return { status: 200, body: state.qualityReports[idx] };
    }

    const qualityReportMatch =
      /^\/books\/admin\/quality\/reports\/([^/]+)$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && qualityReportMatch) {
      const rid = decodeURIComponent(qualityReportMatch[1] ?? "");
      const found = state.qualityReports.find((r) => r.id === rid);
      return found
        ? { status: 200, body: found }
        : { status: 404, body: { detail: "REPORT_NOT_FOUND" } };
    }

    if (ctx.method === "GET" && ctx.pathname === "/books/admin/quality/books") {
      return {
        status: 200,
        body: {
          items: state.qualityBooks.map((b) =>
            makeAdminQualityBookItem({
              book_id: b.book_id,
              book_title: b.book_title,
              assessment: b.assessment,
            }),
          ),
          total: state.qualityBooks.length,
          limit: 10,
          offset: 0,
          summary: { PENDING_ADMIN_REVIEW: state.qualityBooks.length },
          alert_summary: {},
        },
      };
    }

    const qualityBookRightsMatch =
      /^\/books\/admin\/quality\/books\/([^/]+)\/rights$/u.exec(ctx.pathname);
    if (qualityBookRightsMatch) {
      const bid = decodeURIComponent(qualityBookRightsMatch[1] ?? "");
      const book = state.qualityBooks.find((b) => b.book_id === bid);
      if (!book) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      if (ctx.method === "PUT") {
        const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
        const nextStatus =
          typeof body.status === "string" ? body.status : "RIGHTS_REVIEWED";
        const updatedRights = makeBookRightsEvidence({
          book_id: bid,
          status: nextStatus,
          effective_status: nextStatus,
          source_description:
            typeof body.source_description === "string"
              ? body.source_description
              : null,
          author_or_rights_holder:
            typeof body.author_or_rights_holder === "string"
              ? body.author_or_rights_holder
              : null,
          usage_basis:
            typeof body.usage_basis === "string" ? body.usage_basis : null,
          evidence_url_or_ref:
            typeof body.evidence_url_or_ref === "string"
              ? body.evidence_url_or_ref
              : null,
          notes: typeof body.notes === "string" ? body.notes : null,
          reviewed_at: OPAQUE_NOW_ISO,
          reviewed_by: OPAQUE_ADMIN_ID,
          reviewed_by_name: "Quản trị viên ViRead",
        });
        book.rights_evidence = updatedRights;
        book.assessment = {
          ...book.assessment,
          copyright_status: nextStatus,
          rights_confirmed: nextStatus === "RIGHTS_REVIEWED",
        };
        return { status: 200, body: updatedRights };
      }
      return {
        status: 200,
        body: book.rights_evidence ?? makeBookRightsEvidence({ book_id: bid }),
      };
    }

    const qualityBookDecisionMatch =
      /^\/books\/admin\/quality\/books\/([^/]+)\/decision$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && qualityBookDecisionMatch) {
      const bid = decodeURIComponent(qualityBookDecisionMatch[1] ?? "");
      const book = state.qualityBooks.find((b) => b.book_id === bid);
      if (!book) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const decision =
        typeof body.decision === "string" ? body.decision : "APPROVE";
      book.assessment = {
        ...book.assessment,
        status:
          decision === "APPROVE"
            ? "APPROVED_BY_ADMIN"
            : decision === "REJECT"
              ? "REJECTED_FOR_CHILDREN"
              : "PENDING_ADMIN_REVIEW",
        admin_approved_at: decision === "APPROVE" ? OPAQUE_NOW_ISO : null,
        admin_approved_by: decision === "APPROVE" ? OPAQUE_ADMIN_ID : null,
        admin_approved_by_name:
          decision === "APPROVE" ? "Quản trị viên ViRead" : null,
        admin_reason:
          typeof body.reason === "string" ? body.reason : "Đã phê duyệt",
        rights_confirmed: Boolean(body.rights_confirmed),
      };
      return {
        status: 200,
        body: {
          book_id: bid,
          assessment: book.assessment,
          decision_history: book.decision_history,
        },
      };
    }

    const qualityBookScanMatch =
      /^\/books\/admin\/quality\/books\/([^/]+)\/scan$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && qualityBookScanMatch) {
      const bid = decodeURIComponent(qualityBookScanMatch[1] ?? "");
      return { status: 200, body: makeBookQualityScan({ book_id: bid }) };
    }

    const qualityBookDetailMatch =
      /^\/books\/admin\/quality\/books\/([^/]+)$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && qualityBookDetailMatch) {
      const bid = decodeURIComponent(qualityBookDetailMatch[1] ?? "");
      const found = state.qualityBooks.find((b) => b.book_id === bid);
      return found
        ? { status: 200, body: found }
        : { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/quality/user-books"
    ) {
      return {
        status: 200,
        body: {
          items: state.userBookQueue,
          total: state.userBookQueue.length,
          limit: 10,
          offset: 0,
          summary: { PENDING_ADMIN: state.userBookQueue.length },
        },
      };
    }

    const userBookSubDetailMatch =
      /^\/books\/admin\/quality\/user-books\/submissions\/([^/]+)$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "GET" && userBookSubDetailMatch) {
      const sid = decodeURIComponent(userBookSubDetailMatch[1] ?? "");
      const found = state.userBookSubmissions[sid];
      return found
        ? { status: 200, body: found }
        : { status: 404, body: { detail: "SUBMISSION_NOT_FOUND" } };
    }

    const userBookDecisionMatch =
      /^\/books\/admin\/quality\/user-books\/submissions\/([^/]+)\/decision$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && userBookDecisionMatch) {
      const sid = decodeURIComponent(userBookDecisionMatch[1] ?? "");
      const sub = state.userBookSubmissions[sid];
      if (!sub)
        return { status: 404, body: { detail: "SUBMISSION_NOT_FOUND" } };
      return {
        status: 200,
        body: {
          submission_id: sid,
          book_id: sub.book_id,
          decision: "APPROVE",
          previous_status: sub.workflow_status,
          new_workflow_status: "APPROVED_READY_TO_ADD",
          book_moderation_status: "ACTIVE",
          approved_snapshot_hash: OPAQUE_SHA256_A,
          approved_submission_version: sub.submission_version,
          optimistic_lock_version: sub.optimistic_lock_version + 1,
          decided_at: OPAQUE_NOW_ISO,
          reason: "Đã duyệt",
          audit_log_id: makeOpaqueUuid((state.nextId += 1), "87000000"),
        },
      };
    }

    // F-19 Studio Assets, OCR Blocks, Global Tasks
    const studioAssetsMatch = /^\/studio\/books\/([^/]+)\/assets$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && studioAssetsMatch) {
      const bid = decodeURIComponent(studioAssetsMatch[1] ?? "");
      return {
        status: 200,
        body:
          state.assetsByBook[bid] ?? makeBookAssetsSummary({ book_id: bid }),
      };
    }

    const studioCoverUploadMatch =
      /^\/studio\/books\/([^/]+)\/cover\/upload$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && studioCoverUploadMatch) {
      const bid = decodeURIComponent(studioCoverUploadMatch[1] ?? "");
      const cover = makeBookPresentationAsset({
        id: OPAQUE_COVER_ASSET_ID,
        book_id: bid,
        book_page_id: null,
        source_revision_id: null,
        asset_role: "COVER",
        source_type: "USER_UPLOAD",
        media_url: `/studio/assets/${OPAQUE_COVER_ASSET_ID}/media`,
        moderation_status: "APPROVED",
      });
      const existing =
        state.assetsByBook[bid] ?? makeBookAssetsSummary({ book_id: bid });
      state.assetsByBook[bid] = {
        ...existing,
        active_cover: cover,
        effective_cover_source: "USER_UPLOAD",
      };
      return { status: 200, body: cover };
    }

    const studioCoverGenerateMatch =
      /^\/studio\/books\/([^/]+)\/cover\/generate$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && studioCoverGenerateMatch) {
      const bid = decodeURIComponent(studioCoverGenerateMatch[1] ?? "");
      const cover = makeBookPresentationAsset({
        id: OPAQUE_COVER_ASSET_ID,
        book_id: bid,
        book_page_id: null,
        source_revision_id: null,
        asset_role: "COVER",
        source_type: "AI_GENERATED",
        media_url: `/studio/assets/${OPAQUE_COVER_ASSET_ID}/media`,
        moderation_status: "APPROVED",
      });
      return {
        status: 200,
        body: {
          status: "SUCCEEDED",
          job_id: OPAQUE_TASK_ID,
          provider_name: "ViRead Zero-Cost Studio",
          model_id: "flux-schnell-free",
          message_vi: "Đã tạo ảnh bìa minh họa sạch chữ.",
          cover,
          metadata_fallback: makeMetadataCoverFallback(),
          style_bible: null,
          honest_ai_generated: true,
        },
      };
    }

    const studioCoverDeleteMatch = /^\/studio\/books\/([^/]+)\/cover$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "DELETE" && studioCoverDeleteMatch) {
      const bid = decodeURIComponent(studioCoverDeleteMatch[1] ?? "");
      return {
        status: 200,
        body: {
          book_id: bid,
          removed_count: 1,
          metadata_fallback: makeMetadataCoverFallback(),
          message_vi: "Đã gỡ ảnh bìa và quay về bìa chữ tiếng Việt tự động.",
        },
      };
    }

    const studioIllExtractMatch =
      /^\/studio\/books\/([^/]+)\/pages\/([^/]+)\/illustration\/extract$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && studioIllExtractMatch) {
      const bid = decodeURIComponent(studioIllExtractMatch[1] ?? "");
      const pid = decodeURIComponent(studioIllExtractMatch[2] ?? "");
      const asset = makeBookPresentationAsset({
        id: OPAQUE_ASSET_ID,
        book_id: bid,
        book_page_id: pid,
        moderation_status: "PENDING",
      });
      const existing =
        state.assetsByBook[bid] ?? makeBookAssetsSummary({ book_id: bid });
      state.assetsByBook[bid] = {
        ...existing,
        page_illustrations: [asset],
      };
      return {
        status: 200,
        body: {
          status: "EXTRACTED_VERIFIED",
          asset,
          text_free_verified: true,
          text_density_score: 0.01,
          ocr_overlap_score: 0,
          artwork_area_ratio: 0.42,
          recommended_reading_mode: "ILLUSTRATED",
          message_vi: "Đã tách tranh minh họa sạch chữ thành công.",
        },
      };
    }

    const studioIllModMatch =
      /^\/studio\/books\/([^/]+)\/pages\/([^/]+)\/illustration\/([^/]+)$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "PATCH" && studioIllModMatch) {
      const bid = decodeURIComponent(studioIllModMatch[1] ?? "");
      const pid = decodeURIComponent(studioIllModMatch[2] ?? "");
      const aid = decodeURIComponent(studioIllModMatch[3] ?? "");
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const action = typeof body.action === "string" ? body.action : "APPROVE";
      const modStatus =
        action === "APPROVE"
          ? "APPROVED"
          : action === "REJECT"
            ? "REJECTED"
            : "PENDING";
      return {
        status: 200,
        body: makeBookPresentationAsset({
          id: aid,
          book_id: bid,
          book_page_id: pid,
          moderation_status: modStatus,
        }),
      };
    }

    const studioAssetMediaMatch = /^\/studio\/assets\/([^/]+)\/media$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && studioAssetMediaMatch) {
      return {
        status: 200,
        contentType: "image/png",
        headers: { "cache-control": "no-store" },
        body: makeMinimalPngBuffer(),
      };
    }

    const studioOcrGetMatch =
      /^\/studio\/ocr\/pages\/([^/]+)\/extraction$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && studioOcrGetMatch) {
      const pid = decodeURIComponent(studioOcrGetMatch[1] ?? "");
      return {
        status: 200,
        body:
          state.extractionsByPage[pid] ??
          makePageOcrExtraction({ book_page_id: pid }),
      };
    }

    const studioOcrExtractMatch =
      /^\/studio\/ocr\/pages\/([^/]+)\/extract$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && studioOcrExtractMatch) {
      const pid = decodeURIComponent(studioOcrExtractMatch[1] ?? "");
      const extraction = makePageOcrExtraction({ book_page_id: pid });
      state.extractionsByPage[pid] = extraction;
      return { status: 200, body: extraction };
    }

    const studioOcrPatchMatch = /^\/studio\/ocr\/pages\/([^/]+)\/blocks$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "PATCH" && studioOcrPatchMatch) {
      const pid = decodeURIComponent(studioOcrPatchMatch[1] ?? "");
      const current =
        state.extractionsByPage[pid] ??
        makePageOcrExtraction({ book_page_id: pid });
      const body = (ctx.postDataJson ?? {}) as {
        actions?: Array<{
          block_id: string;
          action: string;
          edited_text?: string | null;
        }>;
      };
      const updatedBlocks = current.blocks.map((block) => {
        const act = body.actions?.find((a) => a.block_id === block.block_id);
        if (!act) return block;
        const nextDecision =
          act.action === "KEEP" || act.action === "RESTORE"
            ? "KEEP"
            : act.action === "EXCLUDE"
              ? "EXCLUDE"
              : block.decision;
        const editedText =
          act.action === "EDIT" && typeof act.edited_text === "string"
            ? act.edited_text
            : block.edited_text;
        return {
          ...block,
          decision: nextDecision,
          display_text: editedText ?? block.display_text,
          edited_text: editedText,
          user_override: true,
          in_canonical: nextDecision !== "EXCLUDE",
        };
      });
      const next = {
        ...current,
        blocks: updatedBlocks,
        canonical_text: updatedBlocks
          .filter((b) => b.decision !== "EXCLUDE")
          .map((b) => b.display_text)
          .join("\n"),
        undo_available: true,
        undo_depth: current.undo_depth + 1,
      };
      state.extractionsByPage[pid] = next;
      return { status: 200, body: next };
    }

    const studioApplyDraftMatch =
      /^\/studio\/pages\/([^/]+)\/ocr-extraction\/apply-to-draft$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && studioApplyDraftMatch) {
      const pid = decodeURIComponent(studioApplyDraftMatch[1] ?? "");
      const current =
        state.extractionsByPage[pid] ??
        makePageOcrExtraction({ book_page_id: pid });
      return {
        status: 200,
        body: {
          page_id: pid,
          revision_id: current.page_revision_id ?? OPAQUE_REV_ID,
          applied_word_count: current.canonical_words.length,
          canonical_text: current.canonical_text,
          status: "APPLIED",
        },
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/studio/tasks") {
      return { status: 200, body: state.globalTasks };
    }

    const taskRetryMatch = /^\/studio\/tasks\/([^/]+)\/retry$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && taskRetryMatch) {
      const tid = decodeURIComponent(taskRetryMatch[1] ?? "");
      const idx = state.globalTasks.tasks.findIndex((t) => t.id === tid);
      const task =
        idx >= 0
          ? state.globalTasks.tasks[idx]!
          : makeGlobalTaskItem({ id: tid });
      const updated: GlobalTaskItemPayload = {
        ...task,
        status: "QUEUED",
        status_label_vi: "Đang xếp hàng",
        can_retry: false,
        can_cancel: true,
      };
      if (idx >= 0) {
        state.globalTasks.tasks[idx] = updated;
        state.globalTasks = {
          ...state.globalTasks,
          active_count: 1,
          failed_count: 0,
        };
      }
      return {
        status: 200,
        body: {
          task: updated,
          action: "retry",
          deduplicated: false,
          message_vi: "Đã xếp lịch thử lại tác vụ.",
        },
      };
    }

    const taskCancelMatch = /^\/studio\/tasks\/([^/]+)\/cancel$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && taskCancelMatch) {
      const tid = decodeURIComponent(taskCancelMatch[1] ?? "");
      const idx = state.globalTasks.tasks.findIndex((t) => t.id === tid);
      const task =
        idx >= 0
          ? state.globalTasks.tasks[idx]!
          : makeGlobalTaskItem({ id: tid });
      const updated: GlobalTaskItemPayload = {
        ...task,
        status: "CANCELLED",
        status_label_vi: "Đã hủy",
        can_retry: false,
        can_cancel: false,
      };
      if (idx >= 0) {
        state.globalTasks.tasks[idx] = updated;
        state.globalTasks = {
          ...state.globalTasks,
          active_count: 0,
        };
      }
      return {
        status: 200,
        body: {
          task: updated,
          action: "cancel",
          deduplicated: false,
          message_vi: "Đã hủy tác vụ an toàn.",
        },
      };
    }

    // F-20 ViRead Training
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/viread-training/overview"
    ) {
      return { status: 200, body: state.trainingOverview };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/flow2/trigger"
    ) {
      return { status: 200, body: makeFlow2TriggerResponse() };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/decisions"
    ) {
      return { status: 200, body: { ok: true } };
    }
    const trainingEvalMatch =
      /^\/books\/admin\/viread-training\/jobs\/([^/]+)\/evaluate$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && trainingEvalMatch) {
      const jid = decodeURIComponent(trainingEvalMatch[1] ?? "");
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        body: {
          job_id: jid,
          run_id: OPAQUE_TRAINING_RUN_ID,
          status: "QUEUED",
          operation: "BENCHMARK_ONLY",
          evaluation_type:
            typeof body.evaluation_type === "string"
              ? body.evaluation_type
              : "PILOT",
          cohort_id: makeOpaqueUuid(150, "86000000"),
          sample_count: 220,
          group_count: 35,
          trainer_will_run: true,
        },
      };
    }
    const trainingRetryMatch =
      /^\/books\/admin\/viread-training\/jobs\/([^/]+)\/retry$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && trainingRetryMatch) {
      const jid = decodeURIComponent(trainingRetryMatch[1] ?? "");
      return { status: 200, body: { job_id: jid, status: "QUEUED" } };
    }
    const trainingDeleteMatch =
      /^\/books\/admin\/viread-training\/jobs\/([^/]+)$/u.exec(ctx.pathname);
    if (ctx.method === "DELETE" && trainingDeleteMatch) {
      const jid = decodeURIComponent(trainingDeleteMatch[1] ?? "");
      state.trainingOverview = {
        ...state.trainingOverview,
        jobs: state.trainingOverview.jobs.filter((j) => j.job_id !== jid),
      };
      return { status: 200, body: { deleted: true, job_id: jid } };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/viread-training/drive/status"
    ) {
      return { status: 200, body: state.trainingOverview.google_drive };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/drive/health-check"
    ) {
      return { status: 200, body: state.trainingOverview.google_drive };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/drive/self-test"
    ) {
      return {
        status: 200,
        body: {
          ok: true,
          logical_path: "/ViRead-Flow2-Training/selftest.txt",
          drive_file_id: "drive-selftest-1",
          sha256: OPAQUE_SHA256_A,
          size_bytes: 128,
          deleted_after_test: true,
          is_private: true,
          quota:
            state.trainingOverview.google_drive?.quota ??
            makeVireadDriveStatus().quota,
          detail: "OK",
        },
      };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/drive/connect/apps-script"
    ) {
      const connected = makeVireadDriveStatus({
        connection_mode: "apps_script_bridge",
        connected: true,
        status: "CONNECTED",
      });
      state.trainingOverview = {
        ...state.trainingOverview,
        google_drive: connected,
      };
      return { status: 200, body: connected };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/flow1-model/chunks"
    ) {
      return {
        status: 200,
        body: {
          upload_id: "upload-flow1-1",
          chunk_index: 0,
          storage_path: "flow1/chunks/0.part",
          sha256: OPAQUE_SHA256_A,
          bytes: 128,
        },
      };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/flow1-model/activate"
    ) {
      return {
        status: 200,
        body: {
          decision_id: makeOpaqueUuid(160, "86000000"),
          active_model: {
            checkpoint_sha256: OPAQUE_SHA256_B,
            storage_path: "flow1/viread-v2.pth",
            profile: "FLOW1_EXTERNAL_TRDG",
            version_label: "viread-v2-pipeline",
            updated_at: OPAQUE_NOW_ISO,
          },
          cleanup: {
            previous_model_existed: true,
            previous_storage_deleted: true,
            deleted_object_count: 1,
            local_cache_deleted: true,
            warning: null,
          },
        },
      };
    }

    return undefined;
  };
}
