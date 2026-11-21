"""Local desktop annotator for independent OCR word-box labels on REAL photos.

The UI reads original images only and deliberately never calls OCR or reveals
OCR-predicted boxes. Edits are autosaved in a private draft JSONL; only the
human review button can mark pages as independently reviewed.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_real_photo_benchmark import load_cases
from scripts.ocr_manual_annotation_store import (
    add_word, annotation_key, confirm_page, edit_word, export_reviewed,
    load_or_create_draft, move_word, normalized_drag_box, persist_draft,
    remove_word, validate_draft_path,
)


def run_gui(cases: list[object], root_dir: Path, draft_path: Path, records: dict[str, dict[str, object]]) -> None:
    # Lazy GUI imports: CLI and unit tests stay headless and OCR-import-free.
    import tkinter as tk
    from tkinter import messagebox, simpledialog, ttk
    from PIL import Image, ImageTk

    class Editor:
        def __init__(self) -> None:
            self.window = tk.Tk()
            self.window.title("ViRead - Gán nhãn từ trên ảnh gốc (chỉ lưu cục bộ)")
            self.window.geometry("1330x820")
            self.index = 0
            self.zoom = 1.0
            self.scale = 1.0
            self.drag_start: tuple[float, float] | None = None
            self.drag_rect: int | None = None
            self.photo: object | None = None
            self.image: Image.Image | None = None
            self.keys = [annotation_key(case.image, root_dir) for case in cases]

            self.header = ttk.Frame(self.window, padding=8)
            self.header.pack(fill="x")
            ttk.Button(self.header, text="◀ Trang trước", command=lambda: self.change_page(-1)).pack(side="left")
            ttk.Button(self.header, text="Trang sau ▶", command=lambda: self.change_page(1)).pack(side="left", padx=(6, 12))
            ttk.Button(self.header, text="Thu nhỏ", command=lambda: self.change_zoom(0.8)).pack(side="left")
            ttk.Button(self.header, text="Phóng to", command=lambda: self.change_zoom(1.25)).pack(side="left", padx=(6, 12))
            self.status = ttk.Label(self.header, text="")
            self.status.pack(side="left", padx=8)

            self.main = ttk.Frame(self.window)
            self.main.pack(fill="both", expand=True)
            image_frame = ttk.Frame(self.main)
            image_frame.pack(side="left", fill="both", expand=True)
            self.canvas = tk.Canvas(image_frame, background="#eeeeee", highlightthickness=0)
            vbar = ttk.Scrollbar(image_frame, orient="vertical", command=self.canvas.yview)
            hbar = ttk.Scrollbar(image_frame, orient="horizontal", command=self.canvas.xview)
            self.canvas.configure(yscrollcommand=vbar.set, xscrollcommand=hbar.set)
            self.canvas.grid(row=0, column=0, sticky="nsew")
            vbar.grid(row=0, column=1, sticky="ns")
            hbar.grid(row=1, column=0, sticky="ew")
            image_frame.rowconfigure(0, weight=1)
            image_frame.columnconfigure(0, weight=1)

            panel = ttk.Frame(self.main, padding=10, width=300)
            panel.pack(side="right", fill="y")
            ttk.Label(panel, text="Danh sách từ theo thứ tự đọc").pack(anchor="w")
            self.word_list = tk.Listbox(panel, width=33, height=27, font=("Segoe UI", 11))
            self.word_list.pack(fill="both", expand=True, pady=(6, 8))
            self.word_list.bind("<<ListboxSelect>>", self.highlight_selection)
            self.word_list.bind("<Double-1>", lambda _event: self.edit_selected())
            controls = ttk.Frame(panel)
            controls.pack(fill="x")
            ttk.Button(controls, text="Sửa chữ", command=self.edit_selected).grid(row=0, column=0, padx=2, pady=3)
            ttk.Button(controls, text="Xóa từ", command=self.delete_selected).grid(row=0, column=1, padx=2, pady=3)
            ttk.Button(controls, text="↑", command=lambda: self.reorder(-1)).grid(row=1, column=0, padx=2, pady=3)
            ttk.Button(controls, text="↓", command=lambda: self.reorder(1)).grid(row=1, column=1, padx=2, pady=3)
            self.review_button = ttk.Button(panel, text="Xác nhận đã đối chiếu ảnh gốc", command=self.review)
            self.review_button.pack(fill="x", pady=(12, 4))
            ttk.Button(panel, text="Xuất JSONL sau khi duyệt đủ trang", command=self.export).pack(fill="x", pady=4)
            ttk.Label(
                panel, wraplength=280, justify="left",
                text=(
                    "Kéo chuột khoanh từng từ trên ảnh gốc, nhập một từ tiếng Việt "
                    "giữ nguyên dấu và dấu câu. Không dùng hộp OCR để gán nhãn. "
                    "Mỗi thay đổi tự lưu bản nháp và hủy trạng thái duyệt của trang đó."
                ),
            ).pack(anchor="w", pady=12)

            self.canvas.bind("<ButtonPress-1>", self.start_rectangle)
            self.canvas.bind("<B1-Motion>", self.drag_rectangle)
            self.canvas.bind("<ButtonRelease-1>", self.finish_rectangle)
            self.window.protocol("WM_DELETE_WINDOW", self.quit)
            self.window.update_idletasks()
            self.load_page()

        @property
        def current(self) -> dict[str, object]:
            return records[self.keys[self.index]]

        def current_selection(self) -> int | None:
            selected = self.word_list.curselection()
            return int(selected[0]) if selected else None

        def save(self) -> bool:
            try:
                persist_draft(draft_path, self.keys, records)
                return True
            except (OSError, ValueError) as exc:
                messagebox.showerror("Không thể lưu", f"Bản nháp chưa được lưu: {type(exc).__name__}")
                return False

        def change_page(self, amount: int) -> None:
            next_index = self.index + amount
            if not 0 <= next_index < len(cases):
                return
            self.index = next_index
            self.zoom = 1.0
            self.load_page()

        def change_zoom(self, factor: float) -> None:
            self.zoom = max(0.5, min(5.0, self.zoom * factor))
            self.draw()

        def load_page(self) -> None:
            try:
                if self.image is not None:
                    self.image.close()
                with Image.open(cases[self.index].image) as source:
                    # No EXIF transpose: pixel boxes must share the unrotated
                    # original raster coordinate system used by OpenCV OCR.
                    self.image = source.convert("RGB")
                    orientation = source.getexif().get(274, 1)
                if orientation not in (None, 1):
                    messagebox.showwarning(
                        "EXIF xoay ảnh",
                        "Ảnh có EXIF orientation khác 1. Công cụ hiển thị pixel gốc "
                        "để tọa độ khớp với OpenCV. Hãy kiểm tra hướng ảnh trước khi gán nhãn.",
                    )
            except (OSError, ValueError) as exc:
                messagebox.showerror("Không thể mở ảnh", f"Lỗi ảnh: {type(exc).__name__}")
                raise
            self.draw()

        def draw(self) -> None:
            if self.image is None:
                return
            width, height = self.image.size
            cw = max(200, self.canvas.winfo_width())
            ch = max(200, self.canvas.winfo_height())
            fit = min((cw - 26) / width, (ch - 26) / height, 1.0)
            self.scale = max(0.01, fit * self.zoom)
            display_width = max(1, round(width * self.scale))
            display_height = max(1, round(height * self.scale))
            thumbnail = self.image.resize(
                (display_width, display_height), Image.Resampling.LANCZOS
            )
            self.photo = ImageTk.PhotoImage(thumbnail)
            self.canvas.delete("all")
            self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
            self.canvas.configure(scrollregion=(0, 0, display_width, display_height))
            self.refresh_words()

        def refresh_words(self, select: int | None = None) -> None:
            self.word_list.delete(0, "end")
            words = self.current["words"]
            for index, word in enumerate(words):
                self.word_list.insert("end", f"{index + 1:03d} · {word['text']}")
                x, y, w, h = word["bbox"]
                self.canvas.create_rectangle(
                    round(x * self.image.width * self.scale),
                    round(y * self.image.height * self.scale),
                    round((x + w) * self.image.width * self.scale),
                    round((y + h) * self.image.height * self.scale),
                    outline="#00c853" if self.current["reviewer_confirmed"] else "#ff4050",
                    width=2, tags=("wordbox", f"word_{index}"),
                )
            if select is not None and 0 <= select < len(words):
                self.word_list.selection_set(select)
                self.word_list.see(select)
            reviewed = sum(1 for item in records.values() if item["reviewer_confirmed"])
            self.status.configure(
                text=(
                    f"Trang {self.index + 1}/{len(cases)} | "
                    f"{len(words)} hộp từ | "
                    f"Manifest {len(cases[self.index].truth.split())} token | "
                    f"Đã duyệt {reviewed}/{len(cases)} trang"
                )
            )
            self.review_button.configure(
                text="Đã duyệt trang ✓ (bấm để bỏ duyệt)"
                if self.current["reviewer_confirmed"]
                else "Xác nhận đã đối chiếu ảnh gốc"
            )

        def highlight_selection(self, _event: object = None) -> None:
            self.canvas.delete("selected_outline")
            index = self.current_selection()
            if index is None:
                return
            box = self.current["words"][index]["bbox"]
            x, y, w, h = box
            self.canvas.create_rectangle(
                round(x * self.image.width * self.scale),
                round(y * self.image.height * self.scale),
                round((x + w) * self.image.width * self.scale),
                round((y + h) * self.image.height * self.scale),
                outline="#ffb900", width=3, tags="selected_outline",
            )

        def _canvas_point(self, event: object) -> tuple[float, float]:
            return self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)

        def start_rectangle(self, event: object) -> None:
            if self.image is None:
                return
            current = self.canvas.find_withtag("current")
            if current:
                tags = self.canvas.gettags(current[-1])
                selected = next((tag for tag in tags if tag.startswith("word_")), None)
                if selected:
                    index = int(selected.split("_", 1)[1])
                    self.word_list.selection_clear(0, "end")
                    self.word_list.selection_set(index)
                    self.highlight_selection()
                    return
            self.drag_start = self._canvas_point(event)
            self.canvas.delete("temporary_outline")
            self.drag_rect = None

        def drag_rectangle(self, event: object) -> None:
            if self.drag_start is None:
                return
            x1, y1 = self.drag_start
            x2, y2 = self._canvas_point(event)
            self.canvas.delete("temporary_outline")
            self.drag_rect = self.canvas.create_rectangle(
                x1, y1, x2, y2, outline="#ffb900",
                width=2, dash=(4, 3), tags="temporary_outline",
            )

        def finish_rectangle(self, event: object) -> None:
            if self.drag_start is None or self.image is None:
                return
            x0, y0 = self.drag_start
            x1, y1 = self._canvas_point(event)
            self.drag_start = None
            self.canvas.delete("temporary_outline")
            if abs(x1 - x0) < 4 or abs(y1 - y0) < 4:
                return
            try:
                bbox = normalized_drag_box(
                    x0 / self.scale, y0 / self.scale, x1 / self.scale,
                    y1 / self.scale, self.image.width, self.image.height,
                )
            except ValueError:
                return
            token = simpledialog.askstring(
                "Gán nhãn từ", "Nhập MỘT từ nhìn thấy trên ảnh gốc (giữ nguyên dấu):",
                parent=self.window,
            )
            if token is None:
                return
            try:
                add_word(self.current, token, bbox)
                if not self.save():
                    return
                self.draw()
                self.word_list.selection_set(len(self.current["words"]) - 1)
                self.highlight_selection()
            except ValueError:
                messagebox.showwarning("Từ không hợp lệ", "Hãy nhập đúng MỘT từ cho mỗi hộp.")

        def edit_selected(self) -> None:
            index = self.current_selection()
            if index is None:
                return
            text = simpledialog.askstring(
                "Sửa từ", "Nhập một từ:", initialvalue=self.current["words"][index]["text"],
                parent=self.window,
            )
            if text is None:
                return
            try:
                edit_word(self.current, index, text)
                if self.save():
                    self.draw()
                    self.word_list.selection_set(index)
                    self.highlight_selection()
            except ValueError:
                messagebox.showwarning("Không hợp lệ", "Mỗi hộp chỉ được chứa một từ.")

        def delete_selected(self) -> None:
            index = self.current_selection()
            if index is None or not messagebox.askyesno("Xóa hộp từ", "Xóa nhãn từ đang chọn?"):
                return
            remove_word(self.current, index)
            if self.save():
                self.draw()

        def reorder(self, step: int) -> None:
            index = self.current_selection()
            if index is None:
                return
            try:
                move_word(self.current, index, step)
                if self.save():
                    self.draw()
                    self.word_list.selection_set(index + step)
                    self.highlight_selection()
            except ValueError:
                return

        def review(self) -> None:
            if self.current["reviewer_confirmed"]:
                self.current["annotation_source"] = "unverified"
                self.current["reviewer_confirmed"] = False
                if self.save():
                    self.draw()
                return
            if not self.current["words"]:
                messagebox.showwarning("Trang chưa có nhãn", "Hãy đánh dấu từng từ trước.")
                return
            expected = len(cases[self.index].truth.split())
            found = len(self.current["words"])
            if expected != found and not messagebox.askyesno(
                "Số lượng từ khác manifest",
                f"Trang có {found} nhãn từ, manifest có {expected} token. "
                "Hãy kiểm tra có bỏ sót/tách từ sai không. Vẫn xác nhận trang này?",
            ):
                return
            if not messagebox.askyesno(
                "Xác nhận gán nhãn độc lập",
                "Bạn đã xem ẢNH GỐC, tự đánh dấu TOÀN BỘ từ, đối chiếu thứ tự "
                "và dấu tiếng Việt mà KHÔNG sao chép kết quả OCR chứ? "
                "Chỉ xác nhận nếu thực sự đã kiểm tra.",
            ):
                return
            confirm_page(self.current)
            if self.save():
                self.draw()

        def export(self) -> None:
            reviewed = sum(bool(row["reviewer_confirmed"]) for row in records.values())
            if reviewed != len(cases):
                messagebox.showwarning(
                    "Chưa đủ nhãn thủ công",
                    f"Mới duyệt {reviewed}/{len(cases)} ảnh. "
                    "Bạn phải đánh dấu và duyệt độc lập từng trang.",
                )
                return
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            target = root_dir / f"bbox-annotations-manual-{stamp}.jsonl"
            try:
                export_reviewed(target, draft_path, self.keys, records, BACKEND_ROOT.parent)
            except (ValueError, OSError) as exc:
                messagebox.showerror("Không thể xuất nhãn", f"Lỗi kiểm tra: {type(exc).__name__}")
                return
            messagebox.showinfo(
                "Xuất nhãn thành công",
                f"Đã tạo nhãn cục bộ tại:\n{target}\n\n"
                "Nguồn gán nhãn là lời xác nhận của người thao tác; "
                "phần mềm không tự kiểm toán tính độc lập của nhãn.",
            )

        def quit(self) -> None:
            if self.save():
                self.window.destroy()

    Editor().window.mainloop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private pages.jsonl with original photos")
    parser.add_argument("--draft", type=Path, help="Private draft JSONL, name must contain 'draft'")
    args = parser.parse_args(argv)

    manifest = args.dataset.expanduser().resolve()
    draft = args.draft or (manifest.parent / "bbox-annotations-ui-draft.jsonl")
    try:
        root_dir, draft_path = validate_draft_path(
            manifest, draft, BACKEND_ROOT.parent,
        )
        cases = load_cases(manifest)
        keys = [annotation_key(case.image, root_dir) for case in cases]
    except (ValueError, OSError) as exc:
        print(f"Dataset or draft path invalid: {type(exc).__name__}", file=sys.stderr)
        return 2

    # Single editor per draft: concurrent GUI instances must not overwrite
    # each other's local work. A stale .lock after abnormal termination may be
    # removed only after confirming the GUI is not running.
    lock_path = Path(str(draft_path) + ".lock")
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError:
        print("Draft locked or inaccessible. Close other annotator instance.", file=sys.stderr)
        return 2
    try:
        os.close(descriptor)
        records = load_or_create_draft(draft_path, keys)
        run_gui(cases, root_dir, draft_path, records)
    except Exception as exc:
        # Tk startup may raise TclError, which is not a RuntimeError.
        # Suppress raw exception messages because they may include private paths.
        print(f"Private annotator could not run: {type(exc).__name__}", file=sys.stderr)
        return 2
    finally:
        lock_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
