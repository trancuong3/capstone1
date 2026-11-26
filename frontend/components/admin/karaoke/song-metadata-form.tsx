"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "@/hooks/use-i18n";
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
  const t = useTranslations("admin");
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
      {textField("author", t("karaoke.metadata.authorLabel"), 200)}
      {textField("source_note", t("karaoke.metadata.sourceLabel"), 1000)}
      {textField("usage_note", t("karaoke.metadata.usageLabel"), 1000)}
      {(
        [
          ["min_grade", t("karaoke.metadata.minGradeLabel")],
          ["max_grade", t("karaoke.metadata.maxGradeLabel")],
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
                {t("karaoke.metadata.gradeOption", { grade })}
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
      {textField("title", t("karaoke.metadata.titleLabel"), 200)}
      {variant === "compact" ? (
        <details
          className="md:col-span-2"
          open={expanded || !!additionalError}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary className="min-h-12 cursor-pointer py-3 font-bold text-primary-hover">
            {t("karaoke.metadata.moreInfoSummary")}
          </summary>
          <div className="grid gap-4 pt-3 md:grid-cols-2">{additional}</div>
        </details>
      ) : (
        additional
      )}
      <p className="text-sm text-muted md:col-span-2">
        {t("karaoke.metadata.publishRequirementsHint")}
      </p>
    </div>
  );
}
