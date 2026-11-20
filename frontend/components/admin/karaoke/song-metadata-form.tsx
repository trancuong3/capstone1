"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { KaraokeMetadata } from "@/types/karaoke";

export const karaokeInputClass =
  "min-h-12 w-full min-w-0 rounded-control border border-border bg-white px-4 py-2 font-normal focus-visible:outline-3 focus-visible:outline-primary/40";
export function SongMetadataForm({
  value,
  onChange,
  variant = "full",
  errors,
}: {
  value: KaraokeMetadata;
  onChange: (next: KaraokeMetadata) => void;
  variant?: "full" | "compact";
  errors?: Partial<Record<keyof KaraokeMetadata, string>>;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const fields = useRef<
    Partial<
      Record<keyof KaraokeMetadata, HTMLInputElement | HTMLSelectElement | null>
    >
  >({});
  const firstError = (
    Object.keys(errors ?? {}) as (keyof KaraokeMetadata)[]
  ).find((key) => !!errors?.[key]);
  const additionalError = firstError && firstError !== "title";
  useEffect(() => {
    if (firstError) fields.current[firstError]?.focus();
  }, [firstError, variant]);
  function textField(
    key: "title" | "author" | "source_note" | "usage_note",
    label: string,
    max: number,
  ) {
    return (
      <label className="grid gap-2 font-bold" key={key}>
        {label}
        <input
          aria-label={label}
          ref={(node) => {
            fields.current[key] = node;
          }}
          className={karaokeInputClass}
          maxLength={max}
          value={value[key]}
          aria-invalid={!!errors?.[key]}
          aria-describedby={errors?.[key] ? `${id}-${key}-error` : undefined}
          onChange={(e) =>
            onChange({ ...value, [key]: e.target.value.normalize("NFC") })
          }
        />
        {errors?.[key] && (
          <span
            className="text-sm font-normal text-danger"
            id={`${id}-${key}-error`}
          >
            {errors[key]}
          </span>
        )}
      </label>
    );
  }
  const additional = (
    <>
      {textField("author", "Tác giả / người thể hiện", 200)}
      {textField("source_note", "Nguồn nhạc và lời", 1000)}
      {textField("usage_note", "Quyền sử dụng nội dung", 1000)}
      {(
        [
          ["min_grade", "Từ lớp"],
          ["max_grade", "Đến lớp"],
        ] as const
      ).map(([key, label]) => (
        <label className="grid gap-2 font-bold" key={key}>
          {label}
          <select
            aria-label={label}
            ref={(node) => {
              fields.current[key] = node;
            }}
            className={karaokeInputClass}
            value={value[key]}
            aria-invalid={!!errors?.[key]}
            aria-describedby={errors?.[key] ? `${id}-${key}-error` : undefined}
            onChange={(e) =>
              onChange({ ...value, [key]: Number(e.target.value) })
            }
          >
            {[1, 2, 3, 4, 5].map((grade) => (
              <option value={grade} key={grade}>
                Lớp {grade}
              </option>
            ))}
          </select>
          {errors?.[key] && (
            <span
              className="text-sm font-normal text-danger"
              id={`${id}-${key}-error`}
            >
              {errors[key]}
            </span>
          )}
        </label>
      ))}
    </>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {textField("title", "Tên bài hát", 200)}
      {variant === "compact" ? (
        <details
          className="md:col-span-2"
          open={expanded || !!additionalError}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary className="min-h-12 cursor-pointer py-3 font-bold text-primary-hover">
            Thông tin thêm: tác giả, lớp, nguồn và quyền sử dụng
          </summary>
          <div className="grid gap-4 pt-3 md:grid-cols-2">{additional}</div>
        </details>
      ) : (
        additional
      )}
      <p className="text-sm text-muted md:col-span-2">
        Có thể lưu bản nháp chưa hoàn chỉnh. Khi xuất bản cần tên, nguồn, quyền
        sử dụng, nhạc và lời đã căn thời gian.
      </p>
    </div>
  );
}
