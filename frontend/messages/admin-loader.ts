import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import type { MessageTree } from "@/lib/i18n/types";
import { registerRuntimeNamespace } from "@/messages/loader";

export type AdminNamespaceLoader = () => Promise<MessageTree>;

const BUILTIN_ADMIN_LOCALE_LOADERS: Readonly<
  Partial<Record<SupportedLocale, AdminNamespaceLoader>>
> = {
  vi: () => import("@/messages/vi/admin.json").then((m) => m.default),
  en: () => import("@/messages/en/admin.json").then((m) => m.default),
  "zh-Hans": () =>
    import("@/messages/zh-Hans/admin.json").then((m) => m.default),
  "zh-Hant": () =>
    import("@/messages/zh-Hant/admin.json").then((m) => m.default),
  ja: () => import("@/messages/ja/admin.json").then((m) => m.default),
  ko: () => import("@/messages/ko/admin.json").then((m) => m.default),
  fr: () => import("@/messages/fr/admin.json").then((m) => m.default),
  de: () => import("@/messages/de/admin.json").then((m) => m.default),
  es: () => import("@/messages/es/admin.json").then((m) => m.default),
  ar: () => import("@/messages/ar/admin.json").then((m) => m.default),
  he: () => import("@/messages/he/admin.json").then((m) => m.default),
};

const adminMessageCache = new Map<SupportedLocale, MessageTree>();
const inflightAdminLoads = new Map<SupportedLocale, Promise<MessageTree>>();

export function getCachedAdminLocaleMessages(
  locale: SupportedLocale,
): MessageTree | null {
  return adminMessageCache.get(locale) ?? null;
}

export function seedAdminLocaleCache(
  locale: SupportedLocale,
  tree: MessageTree,
): void {
  adminMessageCache.set(locale, tree);
  registerRuntimeNamespace(locale, "admin", tree);
}

export function resetAdminLoaderStateForTests(): void {
  adminMessageCache.clear();
  inflightAdminLoads.clear();
}

/**
 * Dynamically loads ONLY the requested locale's `admin.json` namespace and
 * registers it into the runtime namespace cache for `/admin/**` routes.
 */
export async function loadAdminLocaleMessages(
  rawLocale: unknown,
): Promise<MessageTree> {
  const locale = normalizeLocale(rawLocale) ?? DEFAULT_LOCALE;
  const cached = adminMessageCache.get(locale);
  if (cached) {
    registerRuntimeNamespace(locale, "admin", cached);
    return cached;
  }

  const inflight = inflightAdminLoads.get(locale);
  if (inflight) {
    return inflight;
  }

  const loader =
    BUILTIN_ADMIN_LOCALE_LOADERS[locale] ??
    BUILTIN_ADMIN_LOCALE_LOADERS[DEFAULT_LOCALE];
  if (!loader) {
    return {};
  }

  const loadPromise = loader()
    .then(async (tree) => {
      if (tree && typeof tree === "object") {
        seedAdminLocaleCache(locale, tree);
        return tree;
      }
      if (locale !== DEFAULT_LOCALE) {
        return loadAdminLocaleMessages(DEFAULT_LOCALE);
      }
      return {};
    })
    .catch(async () => {
      if (locale !== DEFAULT_LOCALE) {
        return loadAdminLocaleMessages(DEFAULT_LOCALE);
      }
      return {};
    })
    .finally(() => {
      inflightAdminLoads.delete(locale);
    });

  inflightAdminLoads.set(locale, loadPromise);
  return loadPromise;
}
