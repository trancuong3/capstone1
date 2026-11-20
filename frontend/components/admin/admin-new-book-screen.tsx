"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";

export function AdminNewBookScreen() {
  const { books } = useAdminServices();
  const router = useRouter();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState("1");
  const [maxGrade, setMaxGrade] = useState("5");
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;

    setError(null);
    setNameError(null);
    setTitleError(null);
    const normalizedName = name.trim();
    const normalizedTitle = title.trim();
    const min = Number(minGrade);
    const max = Number(maxGrade);

    if (!normalizedName) {
      setNameError("Vui lòng nhập tên sách.");
      return;
    }
    if (!normalizedTitle) {
      setTitleError("Vui lòng nhập tiêu đề sách.");
      return;
    }
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1 ||
      min > 5 ||
      max < 1 ||
      max > 5 ||
      min > max
    ) {
      setError(
        "Khối lớp nhỏ nhất và lớn nhất phải là số nguyên từ 1 đến 5, đồng thời khối nhỏ nhất không được lớn hơn khối lớn nhất.",
      );
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const created = await books.create({
        name: normalizedName,
        title: normalizedTitle,
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
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="figma-form-page mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <AdminPageHeader
        title="Tạo sách mới"
        description="Tạo đầu sách trước khi tải ảnh trang, chạy OCR và hoàn tất Child Safety."
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5" /> Hủy và quay lại
      </Link>
      <Card className="max-w-3xl bg-white sm:px-8 sm:py-8">
        <StatusMessage
          className="mb-5"
          tone="info"
          title="Sách chưa được đưa vào thư viện trẻ em"
        >
          Sau khi tạo, hãy tải các trang và hoàn tất OCR, Proofreading, Child
          Safety cùng xác nhận của Admin cho từng trang. Backend sẽ chỉ cho trẻ
          truy cập khi toàn bộ nội dung hiện tại đã được xác minh và không có
          finding mức HIGH hoặc suitability NOT_RECOMMENDED.
        </StatusMessage>
        {error ? (
          <StatusMessage className="mb-5" tone="error">
            {error}
          </StatusMessage>
        ) : null}
        <h2 className="text-2xl font-extrabold text-ink">Thông tin sách</h2>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          <label className="grid gap-2 font-semibold" htmlFor="book-name">
            Tên sách *
            <input
              id="book-name"
              aria-describedby={nameError ? "book-name-error" : undefined}
              aria-invalid={nameError ? true : undefined}
              className="min-h-12 rounded-control border border-border px-4 font-normal focus:border-primary focus:outline-3 focus:outline-primary/30"
              maxLength={250}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
              required
              value={name}
            />
            {nameError ? (
              <span
                className="font-normal text-danger"
                id="book-name-error"
                role="alert"
              >
                {nameError}
              </span>
            ) : null}
          </label>
          <label className="grid gap-2 font-semibold" htmlFor="book-title">
            Tiêu đề sách *
            <input
              id="book-title"
              aria-describedby={titleError ? "book-title-error" : undefined}
              aria-invalid={titleError ? true : undefined}
              className="min-h-12 rounded-control border border-border px-4 font-normal focus:border-primary focus:outline-3 focus:outline-primary/30"
              maxLength={250}
              onChange={(event) => {
                setTitle(event.target.value);
                if (titleError) setTitleError(null);
              }}
              required
              value={title}
            />
            {titleError ? (
              <span
                className="font-normal text-danger"
                id="book-title-error"
                role="alert"
              >
                {titleError}
              </span>
            ) : null}
          </label>
          <label className="grid gap-2 font-semibold" htmlFor="book-author">
            Tác giả
            <input
              id="book-author"
              className="min-h-12 rounded-control border border-border px-4 font-normal focus:border-primary focus:outline-3 focus:outline-primary/30"
              maxLength={250}
              onChange={(event) => setAuthor(event.target.value)}
              value={author}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label
              className="grid gap-2 font-semibold"
              htmlFor="book-min-grade"
            >
              Khối lớp nhỏ nhất *
              <select
                id="book-min-grade"
                className="min-h-12 rounded-control border border-border px-4 font-normal focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMinGrade(event.target.value)}
                required
                value={minGrade}
              >
                {[1, 2, 3, 4, 5].map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="grid gap-2 font-semibold"
              htmlFor="book-max-grade"
            >
              Khối lớp lớn nhất *
              <select
                id="book-max-grade"
                className="min-h-12 rounded-control border border-border px-4 font-normal focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMaxGrade(event.target.value)}
                required
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Button
              className="!max-w-none"
              isLoading={saving}
              size="compact"
              type="submit"
            >
              Tạo sách
            </Button>
            <ButtonLink href="/admin/books" size="compact" variant="quiet">
              Hủy
            </ButtonLink>
          </div>
        </form>
      </Card>
    </section>
  );
}
