declare module "@/scripts/check-i18n.mjs" {
  export interface LocaleAuditSummary {
    readonly locale: string;
    readonly totalKeys: number;
    readonly translatedCount: number;
    readonly missingCount: number;
    readonly extraCount: number;
    readonly placeholderErrors: number;
    readonly untranslatedCount: number;
    readonly coveragePct: number;
  }

  export interface I18nAuditResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
    readonly localeSummaries: readonly LocaleAuditSummary[];
  }

  export function findDuplicateJsonKeys(
    rawJson: string,
    filePath?: string,
  ): string[];

  export function runI18nAudit(options: {
    readonly messagesDir: string;
    readonly referenceLocale?: string;
    readonly strict?: boolean;
  }): I18nAuditResult;
}
