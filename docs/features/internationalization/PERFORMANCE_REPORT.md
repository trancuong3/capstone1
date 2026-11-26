# ViRead Global Internationalization Performance Report

## Runtime & Cloud Cost Model

- **Runtime API Cost**: **0 đ** — zero runtime requests to external translation or LLM services.
- **Bundle Strategy**: Static JSON translation catalogs loaded on demand per locale via `frontend/messages/loader.ts` using native webpack/Turbopack dynamic `import()`.
- **No Network Blocking on Default Load**: `viMessages` (`vi`) is statically typed and available immediately for SSR and default Vietnamese renders; switching to any non-`vi` language fetches only that single locale's async chunk.

## Next.js 16.4.6 Turbopack Build Verification

Command run in `frontend/`:

```powershell
npm run build
```

Observed build metrics:

- **Compilation**: `Compiled successfully in 11.2s`
- **TypeScript Checking**: `Finished TypeScript in 59s`
- **Static Page Generation**: `Generating static pages using 11 workers (29/29) in 1727ms`
- **Isolated Async Chunks Verified**: Scanning `.next/static/chunks/*.js` confirmed each of the 11 published locales compiled into its own separate JS chunk (`110` total static chunks generated).

## Per-Locale Bundle & Chunk Sizes

| Locale    | Direction | Raw JSON Size (`messages/<locale>/*.json`) | Gzip-9 Size (Combined JSON) | Compiled Client Chunk File | Compiled Chunk Size |
| --------- | --------- | ------------------------------------------ | --------------------------- | -------------------------- | ------------------- |
| `vi`      | `ltr`     | 379,071 B (370.2 KiB)                      | 97,004 B (94.7 KiB)         | `14y3gg1r6-ifg.js`         | 340,292 B           |
| `en`      | `ltr`     | 328,145 B (320.5 KiB)                      | 91,130 B (89.0 KiB)         | `2zcixvyng75c1.js`         | 289,505 B           |
| `zh-Hans` | `ltr`     | 317,236 B (309.8 KiB)                      | 97,120 B (94.8 KiB)         | `1v-7rce9exqgs.js`         | 277,974 B           |
| `zh-Hant` | `ltr`     | 321,110 B (313.6 KiB)                      | 98,611 B (96.3 KiB)         | `1hydvq0rd9rhe.js`         | 282,308 B           |
| `ja`      | `ltr`     | 413,865 B (404.2 KiB)                      | 105,099 B (102.6 KiB)       | `0r8fchpqhqo7f.js`         | 375,055 B           |
| `ko`      | `ltr`     | 385,748 B (376.7 KiB)                      | 102,052 B (99.7 KiB)        | `26rw8tdu0fdzc.js`         | 346,996 B           |
| `fr`      | `ltr`     | 387,592 B (378.5 KiB)                      | 103,353 B (100.9 KiB)       | `2ht5tvz_qcruu.js`         | 350,337 B           |
| `de`      | `ltr`     | 378,851 B (370.0 KiB)                      | 105,168 B (102.7 KiB)       | `3tw4yq2cjpf5e.js`         | 340,071 B           |
| `es`      | `ltr`     | 378,010 B (369.2 KiB)                      | 102,175 B (99.8 KiB)        | `1wh632g1fsy2j.js`         | 339,242 B           |
| `ar`      | `rtl`     | 464,155 B (453.3 KiB)                      | 108,927 B (106.4 KiB)       | `347y7tkmz0wh-.js`         | 425,775 B           |
| `he`      | `rtl`     | 410,751 B (401.1 KiB)                      | 104,582 B (102.1 KiB)       | `2t9vyhz_t3eo2.js`         | 372,062 B           |

Because every non-`vi` dictionary lives in an isolated chunk, a standard Vietnamese session downloads **zero** bytes for the other 10 languages, and switching to any single foreign language downloads ~90–106 KiB over gzip (at most once per browser cache lifetime).

## Measured UI Switch Latency

- **In-Browser Cached Switch (`vi` -> `en`)**: Measured in Playwright (`frontend/tests/e2e/i18n.spec.ts`) using `performance.now()` from option click until `document.documentElement.lang === "en"` and React context update complete: **`16.50 ms`** (budget `< 300 ms`).
- **State Preservation**: Switching languages updates `I18nProvider` React context, `document.documentElement.lang`, and `document.documentElement.dir` without unmounting client routes or wiping typed form inputs.
