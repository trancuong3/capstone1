import type { KaraokeMetadata } from "@/types/karaoke";

export const karaokeInputClass =
  "min-h-12 w-full min-w-0 rounded-control border border-border bg-white px-4 py-2 font-normal focus-visible:outline-3 focus-visible:outline-primary/40";
export function SongMetadataForm({
  value,
  onChange,
}: {
  value: KaraokeMetadata;
  onChange: (next: KaraokeMetadata) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(
        [
          ["title", "Tên bài hát", 200],
          ["author", "Tác giả / người thể hiện", 200],
          ["source_note", "Nguồn nhạc và lời", 1000],
          ["usage_note", "Quyền sử dụng nội dung", 1000],
        ] as const
      ).map(([key, label, max]) => (
        <label className="grid gap-2 font-bold" key={key}>
          {label}
          <input
            className={karaokeInputClass}
            maxLength={max}
            value={value[key]}
            onChange={(e) =>
              onChange({ ...value, [key]: e.target.value.normalize("NFC") })
            }
          />
        </label>
      ))}
      {(
        [
          ["min_grade", "Từ lớp"],
          ["max_grade", "Đến lớp"],
        ] as const
      ).map(([key, label]) => (
        <label className="grid gap-2 font-bold" key={key}>
          {label}
          <select
            className={karaokeInputClass}
            value={value[key]}
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
        </label>
      ))}
      <p className="text-sm text-muted md:col-span-2">
        Có thể lưu bản nháp chưa hoàn chỉnh. Khi xuất bản cần tên, nguồn, quyền
        sử dụng, nhạc và lời đã căn thời gian.
      </p>
    </div>
  );
}
