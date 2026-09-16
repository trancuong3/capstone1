import type {
  ParentProfileDTO,
  ParentProfileUpdateInput,
} from "@/types/profile";

export interface ProfileService {
  get(): Promise<ParentProfileDTO>;
  update(request: ParentProfileUpdateInput): Promise<ParentProfileDTO>;
}
