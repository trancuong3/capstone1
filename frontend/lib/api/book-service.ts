import type {
  BookCatalogQuery,
  BookDetailDTO,
  BookListItemDTO,
  BookPagePreviewDTO,
} from "@/types/book";

export interface BookService {
  list(query?: BookCatalogQuery): Promise<BookListItemDTO[]>;
  get(bookId: string): Promise<BookDetailDTO>;
  listPages(bookId: string): Promise<BookPagePreviewDTO[]>;
}
