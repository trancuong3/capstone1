# VietOCR V2: two independent datasets, free interactive Colab or paid Enterprise

User setup checklists: [free interactive Colab](viread-colab-free-training.md) or [optional paid Colab Enterprise](viread-colab-enterprise-setup.md).

The two data flows use separate immutable datasets, manifests, profiles, jobs, and reports. Both fine-tune the same hash-locked VietOCR Original `vgg_transformer` lineage into candidate VietOCR V2 checkpoints. A candidate remains inactive until it passes the independent paired Locked Test gate and an Admin approves it. Original weights are never overwritten.

## Data and job readiness

### Flow 1: externally reviewed real images + DBNet + TRDG

Prepare real line annotations with human-confirmed labels and explicit DBNet line boxes, then create the synthetic set from the reviewed Vietnamese text corpus and Vietnamese font files. Use the existing tools in `ai/vietocr_v2/` (`flow1_prepare`, `flow1_trdg_generate`, and `flow1_register`). Each registered object keeps its own source flow, source group, label, image checksum, and split. The scheduler only creates a Flow 1 job when that exact dataset version has 500–1,000 real samples and 20,000–50,000 TRDG samples, and each source independently contains train and validation samples. It never invents labels or lowers the thresholds.

**Flow 1 intake is not yet hands-free:** the DBNet/TRDG preparation and registration tools exist, and training is automatically queued after a qualifying dataset has been registered, but there is no secured inbox watcher or UI pipeline that automatically consumes a new external-data bundle and runs those tools. Until that intake driver is implemented, Flow 1 is `BLOCKED` for unattended end-to-end collection; do not describe dropping files or the existing manual tools as automatic collection. It still requires human-reviewed source images/annotations, a reviewed Vietnamese text corpus, and fonts.

### Flow 2: Admin VERIFIED page image + confirmed text

Admin confirmation creates the existing transactional outbox event. The outbox worker resolves that exact page and revision, verifies the source image, groups explicit word boxes into reading-order lines, and stores one crop plus the Admin-confirmed line text for each line. Page groups stay together across train, validation, and holdout. The scheduler waits until the immutable dataset has both train and validation rows. Draft, OCR suggestion, and unverified revision text are not eligible.

### Automatic Locked Test and candidate recovery

The scheduler can seal a Locked Test from genuine verified holdout rows after checking image hashes, verified labels, source lineage, and overlap against all Train/Validation images and document groups. It requires at least 200 distinct image/label pairs from at least 30 independent source groups. The test is immutable and each job pins its exact version and manifest hash. If the requirements are not met, the UI reports the remaining pair/group counts and the scheduler does not create or run a replacement job; collect more independent VERIFIED pages with holdout assignments first. It never moves Train/Validation samples into the test or fabricates examples.

An Admin can close a finished, unbenchmarked candidate from its queue card. This marks only the queue job closed and keeps the run/checkpoint for audit; it does not change the active model. The automatic scheduler creates a new generation for the same data/config/parent only after that explicit close and only when a valid Locked Test is ready. Active workers, submitted Colab executions, candidates with benchmarks, and candidates whose parent model changed cannot be closed through this action.

### Sequential scheduling and local-vs-cloud choice

The backend scheduler checks both profiles and allows only one unresolved training job at a time. A capable local GPU is selected only when CUDA PyTorch, at least 6 GiB free VRAM, 8 GiB free RAM, and 8 GiB disk all pass. On a local installation, `VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART=true` starts the dedicated trainer as a separate process; the FastAPI web process only schedules and tracks jobs. If local capacity is unavailable, the job waits for an interactive Colab worker by default. Colab Enterprise dispatch happens only when explicitly enabled. The local worker autostart must be false on Render.

On Render Free, explicitly set `VIREAD_LOCAL_TRAINING_ENABLED=false` and `VIREAD_OCR_WARMUP_ENABLED=false`. The 512 MiB web process is not a training host and should not import CUDA or load PaddleOCR/VietOCR on startup. This allows backend API endpoints and queue scheduling to start with lower memory use. OCR inference itself remains a memory-heavy operation; a successful API deployment does not prove OCR inference fits the Free instance.

## No-cost Colab Free architecture

The backend automatically creates a durable job when the selected profile's immutable dataset is ready. With `VIREAD_COLAB_EXECUTION_MODE=manual`, the job remains `WAITING_FOR_COLAB_WORKER`; a user opens the Colab notebook, connects an available GPU runtime, and runs one cell. That cell claims at most one ready job and processes it end-to-end. It exits after the job and never polls in the background. Rerun it to claim the next job. Colab Free cannot be started through a supported backend API, its GPU availability is not guaranteed, and sessions can disconnect. See [the step-by-step free guide](viread-colab-free-training.md).

The repository defaults to manual mode when `VIREAD_COLAB_EXECUTION_MODE` is unset. Do not configure Cloud Run, Colab Enterprise, a GCS resume bucket, or an Enterprise commit variable for the free path. Keep the Render worker token and put the same token in Colab Secrets; never expose it in notebook output.

## Optional paid Colab Enterprise architecture

The supported automatic path is:

1. The backend creates a durable job after a Flow 1 or Flow 2 dataset is ready.
2. A backend scheduler sends a timestamped HMAC-signed request to a small Cloud Run dispatcher.
3. The dispatcher creates one Google Colab Enterprise `NotebookExecutionJob` using the configured GPU runtime template. It puts only the job ID, profile, pinned repository commit, and Secret Manager resource names in the notebook source; it does not embed credentials.
4. The notebook checks out that exact commit, obtains the API base and training worker token from Secret Manager through its runtime service account, claims only the requested job, and downloads hash-verified dataset and parent checkpoint artifacts from the existing ViRead backend.
5. The worker restores job-scoped resume files from `gs://<output-bucket>/viread-resume/jobs/<job-id>` only when the manifest matches the exact job, profile, dataset, parent checkpoint, config, repository commit, and Locked Test version. Every 100 steps (and on validation) it uploads the latest optimizer/model state and the referenced best-validation weights; it publishes the checksummed manifest last. A retry after an interrupted execution resumes this same lineage. Corrupt, incomplete, or mismatched state is rejected instead of silently starting over. Candidate and paired Locked Test report files are included so a retry before run registration can continue from the completed training stage.
6. The worker fine-tunes the requested profile, uploads checkpoint shards, runs the pinned paired Locked Test, and reports the real result. The scheduler polls the Google execution resource and records its ID, operation, state, and safe failure code. A failure after a checkpoint run has already been registered remains `BLOCKED`; use the Admin close action only when the candidate is finished and unbenchmarked. Do not edit the database or blindly retry a run.

This is a Google Cloud paid service, not a way to start standard free browser Colab remotely. Google bills for the selected VM/GPU and persistent disks while provisioned; Cloud Run, Cloud Storage, and Secret Manager can also incur charges. A budget alert is not a hard spending cap. If the project must stay at exactly 0 cost, do not enable Enterprise dispatch; use the interactive one-job Colab Free notebook described below. Automatic unattended GPU execution cannot be promised at 0 cost.

## One-time Google Cloud setup (manual)

Use an existing Google Cloud project for which you control IAM and billing. This repository does not create a project, enable billing, create resources, or deploy services for you.

1. Confirm the project has a billing account and review current Colab Enterprise, Compute Engine GPU, Cloud Storage, Cloud Run, and Secret Manager pricing. Eligible new Google Cloud accounts may have a $300 trial credit for 90 days, subject to [Google’s current trial terms](https://cloud.google.com/signup-faqs); do not treat a trial credit as permanent $0 training. Google currently documents a change effective November 16, 2026 that excludes Gemini Enterprise Agent Platform/Vertex AI services from trial credit for accounts signing up/upgrading on or after that date; check the [current free-trial exclusions](https://docs.cloud.google.com/free/docs/free-cloud-features) to see whether Colab Enterprise execution is covered for your account before starting. [Colab Enterprise charges for compute and disks](https://docs.cloud.google.com/colab/docs/runtimes). Choose a maximum execution timeout and set a billing budget alert before creating a runtime. [Alerts alone do not stop charges](https://docs.cloud.google.com/billing/docs/how-to/budgets); use a supported spend cap if available and verify its scope, set a short execution timeout/idle shutdown, and delete unused runtimes and disks.
2. Enable the required APIs in that project: Vertex AI / Colab Enterprise (`aiplatform.googleapis.com`), Compute Engine (`compute.googleapis.com`), Cloud Storage (`storage.googleapis.com`), Secret Manager (`secretmanager.googleapis.com`), Cloud Run (`run.googleapis.com`), Cloud Build (`cloudbuild.googleapis.com`), and Artifact Registry (`artifactregistry.googleapis.com`).
3. Create a dedicated Cloud Storage bucket for notebook outputs and resume state. Set a lifecycle policy long enough to cover the maximum retry/recovery window (for example, 30 days), then remove old execution and resume objects. Resume files are checkpoints, not source datasets; do not put production images or secrets in this bucket. The notebook reads training data through the existing ViRead API.
4. Create a Colab Enterprise runtime template in one region with a GPU that has at least 6 GiB VRAM; a T4-class 16 GiB GPU is a practical baseline for the current training settings. Choose a Python runtime compatible with the pinned training requirements (Python 3.12 is the current target), set a suitable boot/data disk and execution timeout, and make sure outbound access to GitHub, the backend HTTPS API, and Secret Manager is allowed. The runtime template and dispatcher must use the same region.
5. Create a dedicated runtime service account for the notebook. Grant it Secret Manager Secret Accessor on only the two required secrets (API base and worker token), plus `Storage Object Admin` scoped to the dedicated output/resume bucket so it can atomically update and prune its job-scoped resume objects. Ensure the Colab Enterprise service agent and runtime service account have the roles required by the selected runtime template.
6. Create these two Secret Manager secrets, with values taken from the deployed ViRead backend and your backend secret manager. Do not put the values in Git, the notebook, a screenshot, or this chat:
   - `viread-api-base`: HTTPS base URL of the deployed backend API (the same base used by the existing worker client).
   - `viread-training-worker-token`: the same random worker token configured as `VIREAD_TRAINING_WORKER_TOKEN` in the backend.
7. Create a dedicated Cloud Run service account for the dispatcher. Give it Colab Enterprise permissions to create and get notebook execution jobs, permission to use the selected runtime template, and `iam.serviceAccounts.actAs` on the dedicated runtime service account. Avoid broad project Owner/Editor grants. The Colab Enterprise IAM page lists the role permissions and service-agent roles; do not grant service-agent roles to ordinary service accounts.
8. Generate a separate random HMAC shared secret of at least 32 characters. Store it in Cloud Run as `VIREAD_COLAB_DISPATCH_SHARED_SECRET` and later in Render under the same name. It is different from the training worker token.
9. From the repository root, deploy the dispatcher source directory `cloud/colab-enterprise-dispatcher` to Cloud Run. Configure these Cloud Run variables (use your own project/region/resource names):

   ```text
   GCP_PROJECT_ID=<existing Google Cloud project ID>
   GCP_REGION=<Colab Enterprise region>
   COLAB_RUNTIME_TEMPLATE_RESOURCE=projects/<project>/locations/<region>/notebookRuntimeTemplates/<template>
   COLAB_OUTPUT_GCS_URI=gs://<output-bucket>
   COLAB_RUNTIME_SERVICE_ACCOUNT=<runtime-service-account-email>
   VIREAD_REPOSITORY_URL=https://github.com/trancuong3/capstone1
   VIREAD_REPOSITORY_COMMIT=<40-character commit SHA that contains this dispatcher worker code>
   VIREAD_API_BASE_SECRET_RESOURCE=projects/<project>/secrets/viread-api-base/versions/latest
   VIREAD_WORKER_TOKEN_SECRET_RESOURCE=projects/<project>/secrets/viread-training-worker-token/versions/latest
   COLAB_EXECUTION_TIMEOUT_SECONDS=21600
   ```

   Also attach the HMAC shared secret from Secret Manager as the environment variable `VIREAD_COLAB_DISPATCH_SHARED_SECRET`. Configure an HTTP health check if your Cloud Run settings require one; `/status/<execution-id>` is signed and must not be used as an unauthenticated health endpoint. Use Cloud Run's provided service URL as the dispatcher URL.

10. Configure the deployed backend's Render service with the existing database and Supabase variables plus:

   ```text
   VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=true
   VIREAD_LOCAL_TRAINING_ENABLED=false
   VIREAD_OCR_WARMUP_ENABLED=false
   VIREAD_COLAB_EXECUTION_MODE=enterprise
   VIREAD_COLAB_DISPATCH_URL=https://<Cloud-Run-service-URL>
   VIREAD_COLAB_DISPATCH_SHARED_SECRET=<same HMAC secret as Cloud Run>
   VIREAD_COLAB_REPOSITORY_URL=https://github.com/trancuong3/capstone1
   VIREAD_COLAB_REPOSITORY_COMMIT=<same 40-character pinned commit SHA>
   VIREAD_TRAINING_WORKER_TOKEN=<same token stored in Secret Manager>
   ```

11. Review the additive Supabase migration `supabase/migrations/20261113051337_viread_colab_enterprise_dispatch.sql` and apply it to the existing project through your approved migration process before deploying the matching backend. It widens the current queue constraints and adds execution tracking fields. Do not apply the older queue migration twice; verify its recorded migration status first. In Supabase SQL Editor, read-only checks can confirm the existing tables and new columns:

   ```sql
   select to_regclass('public.viread_ocr_training_jobs') as training_jobs,
          to_regclass('public.viread_ocr_dataset_versions') as datasets;

   select column_name
   from information_schema.columns
   where table_schema='public' and table_name='viread_ocr_training_jobs'
     and column_name in ('colab_execution_id','colab_execution_resource_name',
                         'colab_operation_name','colab_execution_number')
   order by column_name;
   ```

   The first query should return table names; the second should return all four columns after the new migration is applied. Check migration history in the project’s migration workflow/CLI as well. This development session does not run a production migration.
12. Deploy the exact commit to Render, then check backend health and Admin → Huấn luyện OCR. Start with one small real job only after the Cloud Run URL, runtime template, secrets, permissions, database migration, and Locked Test are in place.

## Evidence that automatic training worked

For one real job, retain these audit facts in the system: source dataset version ID and manifest SHA256; profile; train/validation counts; parent Original/V2 checkpoint SHA256; job ID; Google `NotebookExecutionJob` resource name and operation; worker runtime GPU name/VRAM; downloaded image and label checksums; produced checkpoint SHA256; Locked Test manifest/checkpoint hashes and paired metrics; quality-gate result; and Admin approval decision. The Admin page should move through a queued/submitted/running state and end in `CANDIDATE`, `BENCHMARKED`, `QUALITY_GATE_REJECTED`, `FAILED`, or an explicit `BLOCKED` state. `BENCHMARKED` is not proof of promotion; the active model stays unchanged until approval.

If an execution fails before it creates a training run, the scheduler retries up to three separate executions with backoff. It deliberately blocks automatic retry after a run record/checkpoint may already exist, because blindly repeating an upload could corrupt or misrepresent checkpoint lineage; an Admin must inspect and recover that run. A finished Google execution with no API result is marked blocked rather than reported as successful.

## Stop, rotate, and troubleshoot

- To stop new paid jobs, set `VIREAD_COLAB_EXECUTION_MODE=disabled` in the backend and redeploy. For interactive Colab Free, use `manual`; for automatic Enterprise, explicitly opt in with `enterprise` and configure its billable Google Cloud resources.
- Cancel an in-progress NotebookExecutionJob in the Google Cloud console, then verify its terminal state and the matching ViRead job state. Delete unused runtimes and output artifacts; deleting a runtime does not remove stored execution outputs.
- `BLOCKED_CONFIGURATION` means the scheduler cannot safely submit. Use its `last_error_code`, check the Render variables, Cloud Run signature, pinned commit, runtime template/region, IAM, Secret Manager access, and migration status. After correcting configuration or IAM, the scheduler rechecks this state and retries after up to five minutes.
- `COLAB_EXECUTION_FINISHED_WITHOUT_JOB_RESULT` means Google execution ended but the worker did not report a durable result; inspect Cloud Run/Colab logs and the job's run record before retrying.
- Rotate the backend worker token in Render and Secret Manager together. Rotate the HMAC key in Render and Cloud Run together. If any Supabase service key or database credential has appeared in a shared screenshot, rotate it in Supabase/Render before using the deployment.

## Manual browser Colab fallback

`ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb` is the interactive free worker. Add the API base and worker token to Colab Secrets, connect a GPU runtime, and run the cell to claim at most one ready job. It exits after that job and does not poll in the background. Browser Colab cannot be automatically started through a supported public API after the runtime disconnects; reconnect and run the cell again manually. The Enterprise path above is the unattended option and can incur Google Cloud charges.

No real GPU run, checkpoint, quality-gate result, or automatic Google execution is claimed until a real job record and execution evidence exist.
