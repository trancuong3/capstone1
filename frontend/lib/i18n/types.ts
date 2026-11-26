export const I18N_NAMESPACES = [
  "common",
  "auth",
  "navigation",
  "parent",
  "child",
  "admin",
  "books",
  "ocr",
  "reading",
  "speech",
  "difficultWords",
  "reports",
  "entertainment",
  "games",
  "settings",
  "errors",
  "validation",
  "notifications",
  "accessibility",
] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export interface MessageTree {
  readonly [key: string]: string | MessageTree;
}

export type MessagesDictionary = Readonly<Record<string, MessageTree | string>>;

export type TranslationParamValue =
  string | number | boolean | null | undefined;

export type TranslationParams = Readonly<Record<string, TranslationParamValue>>;

export type TranslateFn = (
  key: string,
  params?: TranslationParams,
  defaultValue?: string,
) => string;
