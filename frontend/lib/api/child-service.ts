import type {
  ChildProfileCreateDTO,
  ChildProfileDTO,
  ChildProfilePatchDTO,
} from "@/types/child";

export interface ChildService {
  list(): Promise<ChildProfileDTO[]>;
  create(request: ChildProfileCreateDTO): Promise<ChildProfileDTO>;
  get(childId: string): Promise<ChildProfileDTO>;
  update(
    childId: string,
    request: ChildProfilePatchDTO,
  ): Promise<ChildProfileDTO>;
}
