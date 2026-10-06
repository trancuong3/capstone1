import type { ChildProfileDTO } from "@/types/child";
import type { ParentProfileDTO, UUID } from "@/types/profile";

export const MOCK_CURRENT_PARENT_ID = "11111111-1111-4111-8111-111111111111";
export const MOCK_OTHER_PARENT_ID = "22222222-2222-4222-8222-222222222222";
export const MOCK_CURRENT_CHILD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MOCK_SECOND_CHILD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const MOCK_FOREIGN_CHILD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export interface MockAppStore {
  readonly currentParentId: UUID;
  readonly profiles: Map<UUID, ParentProfileDTO>;
  readonly children: Map<UUID, ChildProfileDTO>;
  nextChildSequence: number;
}

export function createMockAppStore(): MockAppStore {
  const profiles: ParentProfileDTO[] = [
    {
      id: MOCK_CURRENT_PARENT_ID,
      display_name: "Nguyễn Minh Anh",
      role: "parent",
      created_at: "2026-08-15T08:30:00.000Z",
    },
    {
      id: MOCK_OTHER_PARENT_ID,
      display_name: "Phụ huynh khác",
      role: "parent",
      created_at: "2026-08-18T09:00:00.000Z",
    },
  ];

  const children: ChildProfileDTO[] = [
    {
      id: MOCK_CURRENT_CHILD_ID,
      parent_id: MOCK_CURRENT_PARENT_ID,
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: "2026-08-20T02:15:00.000Z",
    },
    {
      id: MOCK_SECOND_CHILD_ID,
      parent_id: MOCK_CURRENT_PARENT_ID,
      alias: "Bé Minh",
      grade: 4,
      settings: {},
      created_at: "2026-08-22T03:45:00.000Z",
    },
    {
      id: MOCK_FOREIGN_CHILD_ID,
      parent_id: MOCK_OTHER_PARENT_ID,
      alias: "Hồ sơ riêng tư",
      grade: 3,
      settings: {},
      created_at: "2026-08-24T04:10:00.000Z",
    },
  ];

  return {
    currentParentId: MOCK_CURRENT_PARENT_ID,
    profiles: new Map(profiles.map((profile) => [profile.id, profile])),
    children: new Map(children.map((child) => [child.id, child])),
    nextChildSequence: 1,
  };
}
