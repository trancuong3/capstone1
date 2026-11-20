# ViRead Project Hub

Static project dashboard for tracking development of [ViRead](https://github.com/trancuong3/capstone1).

## What it shows

- Live public GitHub data: recent commits, open pull requests, open issues, Actions runs and Releases.
- Project roadmap for Frontend, Backend, AI/OCR, Android and Release.
- Android APK readiness gates from source integration through real-device verification.
- Personal notes and editable task statuses saved in the current browser.

## Run locally

No build step or package installation is required.

1. Open `index.html` in a modern browser, or serve this directory with any static HTTP server.
2. Press **Đồng bộ GitHub** to refresh repository data.
3. Update roadmap statuses and add tasks as needed.

## Deploy with GitHub Pages

The workflow `.github/workflows/project-dashboard-pages.yml` deploys this directory when changes are merged to `main`.

After the pull request is merged:

1. Open repository **Settings → Pages**.
2. Set **Build and deployment → Source** to **GitHub Actions** if it is not already configured.
3. Open **Actions → Deploy ViRead Project Hub** and confirm the deployment succeeds.

Expected project-site URL after successful deployment:

https://trancuong3.github.io/capstone1/

The URL is not live until GitHub Pages is enabled and a deployment run succeeds.

## Data and privacy

- The dashboard reads only public endpoints from the GitHub REST API. It does not use a personal access token.
- GitHub API rate limits apply to anonymous requests. If an endpoint is unavailable, the dashboard shows an unavailable/empty state rather than inventing data.
- Roadmap tasks and notes are stored only in this browser's `localStorage`. They are not synchronized across devices, uploaded to GitHub, or backed up.
- Do not enter passwords, access tokens, Supabase keys, signing credentials, private URLs or personal data in notes.
- The repository is public, so the deployed dashboard is public too. Do not add private project information.
- Task statuses are personal tracking labels. They are not automated proof that a feature works in production.

## Reset local dashboard data

In the browser developer console, run:

```js
localStorage.removeItem("viread-project-hub-v1");
location.reload();
```

This restores the initial roadmap for that browser.
