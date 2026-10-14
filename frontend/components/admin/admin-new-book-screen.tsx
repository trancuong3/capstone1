"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";

export function AdminNewBookScreen() {
  const { books } = useAdminServices();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState("1");
  const [maxGrade, setMaxGrade] = useState("5");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const min = Number(minGrade);
    const max = Number(maxGrade);
    if (!title.trim()) {
      setError("Vui lòng nhập tên sách.");
      return;
    }
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1 ||
      max > 5 ||
      min > max
    ) {
      setError(
        "Khối lớp phải từ 1 đến 5 và khối nhỏ nhất không được lớn hơn khối lớn nhất.",
      );
      return;
    }
    setSaving(true);
    try {
      const created = await books.create({
        title: title.trim(),
        author: author.trim() || null,
        min_grade: min,
        max_grade: max,
      });
      router.push(`/admin/books/${created.id}`);
    } catch {
      setError(
        "Không thể tạo sách. Hãy kiểm tra quyền Admin, kết nối Backend và thử lại.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <AdminPageHeader
        eyebrow="Kho sách"
        title="Tạo sách mới"
        description="Tạo đầu sách trong PostgreSQL trước khi tải ảnh các trang và chạy OCR."
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5" /> Hủy và quay lại
      </Link>
      <Card className="max-w-3xl bg-white">
        {error ? (
          <StatusMessage className="mb-5" tone="error">
            {error}
          </StatusMessage>
        ) : null}
        <form className="grid gap-5" onSubmit={submit}>
          <label className="grid gap-2 font-bold" htmlFor="book-title">
            Tên sách
            <input
              id="book-title"
              className="min-h-12 rounded-control border border-border px-4 font-normal focus:border-primary focus:outline-3 focus:outline-primary/30"
              maxLength={250}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <label className="grid gap-2 font-bold" htmlFor="book-author">
            Tác giả{" "}
            <span className="font-normal text-muted">(không bắt buộc)</span>
            <input
              id="book-author"
              className="min-h-12 rounded-control border border-border px-4 font-normal focus:border-primary focus:outline-3 focus:outline-primary/30"
              maxLength={250}
              onChange={(event) => setAuthor(event.target.value)}
              value={author}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 font-bold" htmlFor="book-min-grade">
              Khối lớp nhỏ nhất
              <select
                id="book-min-grade"
                className="min-h-12 rounded-control border border-border px-4 font-normal"
                onChange={(event) => setMinGrade(event.target.value)}
                value={minGrade}
              >
                {[1, 2, 3, 4, 5].map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 font-bold" htmlFor="book-max-grade">
              Khối lớp lớn nhất
              <select
                id="book-max-grade"
                className="min-h-12 rounded-control border border-border px-4 font-normal"
                onChange={(event) => setMaxGrade(event.target.value)}
                value={maxGrade}
              >
                {[1, 2, 3, 4, 5].map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button
            className="sm:w-auto sm:justify-self-start"
            isLoading={saving}
            type="submit"
          >
            Tạo sách
          </Button>
        </form>
      </Card>
    </>
  );
}
