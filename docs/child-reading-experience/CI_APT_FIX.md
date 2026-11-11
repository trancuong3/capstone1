# PR #85 dependency-installation correction

## Evidence and cause

Both attempts of the original PR checks failed before the relevant tests ran:

- Backend: `Install OCR system dependencies`, exit 100.
- Frontend Checks: `Install Playwright Chromium`, exit 1.
- Admin Book CRUD: `Install Chromium for Playwright`, exit 1. Its format, lint, typecheck, unit tests and production build had already passed.

The user supplied the backend attempt-2 log. Ubuntu index/package downloads repeatedly failed with `Temporary failure resolving 'azure.archive.ubuntu.com'` through `mirror+file:/etc/apt/apt-mirrors.txt`. An incomplete index update returned warnings, and the later Tesseract package installation failed. This is an installation failure, not evidence of an application test regression. Detailed frontend installation logs were not available; the common APT preparation below also applies to Playwright's system dependency installation.

The runner's [APT setup](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh) places Azure first in its mirror list. [Playwright installation](https://playwright.dev/docs/browsers#install-system-dependencies) with `--with-deps` also installs system packages. Merely rerunning the old commit retained the same failing setup.

## Correction

The three affected workflows now configure APT before dependency installation. The standard-library helper replaces recognized Ubuntu mirror-list/direct HTTP sources with direct official HTTPS archives. It retains suites, components, signing keys and unrelated repositories. It supports both legacy `.list` and deb822 `.sources` files and fails if no supported Ubuntu archive source exists.

APT configuration bounds retries and HTTP/HTTPS timeouts and makes incomplete index updates fatal. Existing package installation, signature verification, test, lint, typecheck, build and browser steps are retained. No error is converted into a pass. Admin Book CRUD is pinned to Ubuntu 24.04, matching the other two workflows, to avoid unrelated `ubuntu-latest` distribution changes.

No application code, dependency versions, database configuration, provider setup or upstream source integration changes are included.

## Verification and limits

Local regression command from repository root:

```text
python -B -m unittest discover -s .github/scripts -p 'test_*.py' -v
```

Six tests pass using temporary directories only. They cover the observed mirror-list format, direct Azure legacy sources, security sources, preservation of third-party repositories and trust/suites, idempotence, timeout/error configuration and failure on unsupported sources. Workflow YAML parsing and comparison against the preceding commit verify that all original steps and gates are retained. Git whitespace and YAML/Markdown formatting checks pass.

These checks do not install packages on the local Windows host, access `.env`, use a database/provider or establish Ubuntu network availability. The new commit must run on GitHub before its CI result can be called passed. No full application suite was rerun for this workflow-only correction. Prior application acceptance limits remain in [FINAL_ACCEPTANCE.md](FINAL_ACCEPTANCE.md); no merge is authorized.
