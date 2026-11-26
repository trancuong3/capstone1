"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/common/button";
import { ProfileAvatarUpload } from "@/components/common/profile-avatar-upload";
import { SelectField } from "@/components/common/select-field";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import { useI18n } from "@/hooks/use-i18n";
import type { ChildProfileCreateDTO } from "@/types/child";

interface ChildProfileFormProps {
  defaultValues?: Pick<ChildProfileCreateDTO, "alias" | "grade">;
  mode: "create" | "edit";
  onSubmit: (values: ChildProfileCreateDTO) => Promise<void>;
  submitLabel?: string;
  showOptionalAvatarNote?: boolean;
  avatarUrl?: string | null;
  selectedAvatarFile?: File | null;
  isAvatarRemoved?: boolean;
  onAvatarFileChange?: (file: File | null) => void;
  onAvatarRemove?: () => void;
}

export function ChildProfileForm({
  defaultValues,
  mode,
  onSubmit,
  submitLabel,
  showOptionalAvatarNote = false,
  avatarUrl = null,
  selectedAvatarFile = null,
  isAvatarRemoved = false,
  onAvatarFileChange,
  onAvatarRemove,
}: ChildProfileFormProps) {
  const { t } = useI18n();
  const isHydrated = useHydrated();

  const childProfileSchema = useMemo(
    () =>
      z.object({
        alias: z.string().trim().min(1, t("validation.childAliasRequired")),
        grade: z.coerce
          .number<number>()
          .int(t("validation.childGradeInt"))
          .min(1, t("validation.childGradeRange"))
          .max(5, t("validation.childGradeRange")),
      }),
    [t],
  );

  type ChildProfileFormValues = z.input<typeof childProfileSchema>;

  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ChildProfileFormValues>({
    defaultValues: {
      alias: defaultValues?.alias ?? "",
      grade: defaultValues?.grade ?? 2,
    },
    resolver: zodResolver(childProfileSchema),
  });
  const aliasPreview = useWatch({ control, name: "alias" });

  const submitForm = handleSubmit(async (values) => {
    if (isSubmitting) {
      return;
    }

    const parsed = childProfileSchema.parse(values);
    await onSubmit({ alias: parsed.alias, grade: parsed.grade });
  });

  return (
    <form
      className="flex w-full flex-col gap-4"
      noValidate
      onSubmit={submitForm}
    >
      <TextField
        autoComplete="off"
        error={errors.alias?.message}
        label={t("parent.children.aliasLabel")}
        placeholder={t("parent.children.aliasPlaceholder")}
        {...register("alias")}
      />
      <SelectField
        error={errors.grade?.message}
        label={t("parent.children.gradeFieldLabel")}
        {...register("grade")}
      >
        {[1, 2, 3, 4, 5].map((grade) => (
          <option key={grade} value={grade}>
            {t("parent.children.gradeLabel", { grade })}
          </option>
        ))}
      </SelectField>
      <ProfileAvatarUpload
        displayName={aliasPreview}
        imageUrl={avatarUrl}
        isRemoved={isAvatarRemoved}
        onRemove={() => onAvatarRemove?.()}
        onSelectFile={(file) => onAvatarFileChange?.(file)}
        showOptionalNote={showOptionalAvatarNote}
        selectedFile={selectedAvatarFile}
      />
      <Button disabled={!isHydrated} isLoading={isSubmitting} type="submit">
        {isSubmitting
          ? t("common.actions.saving")
          : (submitLabel ??
            (mode === "create"
              ? t("parent.children.saveProfile")
              : t("parent.profile.saveChanges")))}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        ) : null}
      </Button>
    </form>
  );
}
