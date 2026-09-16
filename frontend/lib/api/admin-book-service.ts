import type {
  AdminBookCreateDTO,
  AdminBookDTO,
  AdminBookListItemUI,
  AdminBookQueryUI,
  AdminBookUpdateDTO,
  StatusPatchDTO,
} from "@/types/admin";

export interface AdminBookService {
  list(query?: AdminBookQueryUI): Promise<readonly AdminBookListItemUI[]>;
  get(bookId: string): Promise<AdminBookDTO>;
  create(request: AdminBookCreateDTO): Promise<AdminBookDTO>;
  update(bookId: string, request: AdminBookUpdateDTO): Promise<AdminBookDTO>;
  updateStatus(bookId: string, request: StatusPatchDTO): Promise<AdminBookDTO>;
}
