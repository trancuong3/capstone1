import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import type { MessageTree, MessagesDictionary } from "@/lib/i18n/types";
import { viMessages } from "@/messages/vi";

export type LocaleBundleLoader = () => Promise<MessagesDictionary>;

const BUILTIN_LOCALE_LOADERS: Readonly<
  Partial<Record<SupportedLocale, LocaleBundleLoader>>
> = {
  vi: async () => (await import("@/messages/vi")).viMessages,
  en: () => import("@/messages/en").then((m) => m.default),
  "zh-Hans": () => import("@/messages/zh-Hans").then((m) => m.default),
  "zh-Hant": () => import("@/messages/zh-Hant").then((m) => m.default),
  ja: () => import("@/messages/ja").then((m) => m.default),
  ko: () => import("@/messages/ko").then((m) => m.default),
  fr: () => import("@/messages/fr").then((m) => m.default),
  de: () => import("@/messages/de").then((m) => m.default),
  es: () => import("@/messages/es").then((m) => m.default),
  ar: () => import("@/messages/ar").then((m) => m.default),
  he: () => import("@/messages/he").then((m) => m.default),
};

const customLoaders = new Map<SupportedLocale, LocaleBundleLoader>();
const messageCache = new Map<SupportedLocale, MessagesDictionary>([
  [DEFAULT_LOCALE, viMessages],
]);
const inflightLoads = new Map<SupportedLocale, Promise<MessagesDictionary>>();

// Runtime-registered lazy namespaces (e.g. "admin") so root bundles never
// statically include route-scoped dictionaries while `translateRuntime` and
// default context fallback still resolve them once loaded.
const runtimeNamespaces = new Map<SupportedLocale, Map<string, MessageTree>>();
const persistentTestNamespaces = new Map<
  SupportedLocale,
  Map<string, MessageTree>
>();
let namespaceVersion = 0;
const mergedNamespaceCache = new Map<
  SupportedLocale,
  {
    readonly base: MessagesDictionary;
    readonly version: number;
    readonly merged: MessagesDictionary;
  }
>();

export function registerRuntimeNamespace(
  locale: SupportedLocale,
  namespace: string,
  tree: MessageTree,
): void {
  let byNs = runtimeNamespaces.get(locale);
  if (!byNs) {
    byNs = new Map<string, MessageTree>();
    runtimeNamespaces.set(locale, byNs);
  }
  byNs.set(namespace, tree);
  namespaceVersion += 1;
}

/**
 * Registers a persistent test-only fallback namespace (e.g. `vi/admin.json`
 * in `test/setup.ts`) that survives `resetLocaleLoaderStateForTests()`.
 */
export function registerPersistentTestNamespace(
  locale: SupportedLocale,
  namespace: string,
  tree: MessageTree,
): void {
  let byNs = persistentTestNamespaces.get(locale);
  if (!byNs) {
    byNs = new Map<string, MessageTree>();
    persistentTestNamespaces.set(locale, byNs);
  }
  byNs.set(namespace, tree);
  namespaceVersion += 1;
}

export function getCachedRuntimeNamespace(
  locale: SupportedLocale,
  namespace: string,
): MessageTree | null {
  return (
    runtimeNamespaces.get(locale)?.get(namespace) ??
    persistentTestNamespaces.get(locale)?.get(namespace) ??
    null
  );
}

export function withCachedRuntimeNamespaces(
  locale: SupportedLocale,
  base: MessagesDictionary,
): MessagesDictionary {
  const persistent = persistentTestNamespaces.get(locale);
  const runtime = runtimeNamespaces.get(locale);
  if (
    (!persistent || persistent.size === 0) &&
    (!runtime || runtime.size === 0)
  ) {
    return base;
  }
  const cached = mergedNamespaceCache.get(locale);
  if (cached && cached.base === base && cached.version === namespaceVersion) {
    return cached.merged;
  }
  const merged: Record<string, MessageTree | string> = { ...base };
  if (persistent) {
    for (const [ns, tree] of persistent.entries()) {
      if (!Object.hasOwn(merged, ns)) {
        merged[ns] = tree;
      }
    }
  }
  if (runtime) {
    for (const [ns, tree] of runtime.entries()) {
      merged[ns] = tree;
    }
  }
  mergedNamespaceCache.set(locale, {
    base,
    version: namespaceVersion,
    merged,
  });
  return merged;
}

export function getCachedLocaleMessages(
  locale: SupportedLocale,
): MessagesDictionary | null {
  return messageCache.get(locale) ?? null;
}

/**
 * Registers a custom dynamic bundle loader (used by tests or future lazy locales).
 */
export function registerLocaleLoader(
  locale: SupportedLocale,
  loader: LocaleBundleLoader,
): void {
  customLoaders.set(locale, loader);
  messageCache.delete(locale);
  inflightLoads.delete(locale);
}

export function resetLocaleLoaderStateForTests(): void {
  customLoaders.clear();
  inflightLoads.clear();
  messageCache.clear();
  messageCache.set(DEFAULT_LOCALE, viMessages);
  runtimeNamespaces.clear();
  namespaceVersion += 1;
  mergedNamespaceCache.clear();
}

export function clearAllRuntimeNamespacesForTests(): void {
  runtimeNamespaces.clear();
  persistentTestNamespaces.clear();
  namespaceVersion += 1;
  mergedNamespaceCache.clear();
}

/**
 * Dynamically loads ONLY the requested locale's core message bundle and caches
 * it in memory. Falls back to `viMessages` without throwing if the bundle is
 * missing or fails to load.
 */
export async function loadLocaleMessages(
  rawLocale: unknown,
): Promise<MessagesDictionary> {
  const locale = normalizeLocale(rawLocale) ?? DEFAULT_LOCALE;
  const cached = messageCache.get(locale);
  if (cached) {
    return cached;
  }

  const inflight = inflightLoads.get(locale);
  if (inflight) {
    return inflight;
  }

  const loader = customLoaders.get(locale) ?? BUILTIN_LOCALE_LOADERS[locale];
  if (!loader) {
    return viMessages;
  }

  const loadPromise = loader()
    .then((bundle) => {
      if (bundle && typeof bundle === "object") {
        messageCache.set(locale, bundle);
        return bundle;
      }
      return viMessages;
    })
    .catch(() => viMessages)
    .finally(() => {
      inflightLoads.delete(locale);
    });

  inflightLoads.set(locale, loadPromise);
  return loadPromise;
}
