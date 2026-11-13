# VietOCR V2 Flow 2 automatic training

Flow 2 keeps its Admin VERIFIED dataset separate from Flow 1. After the outbox worker crops and labels a committed VERIFIED revision, the training scheduler creates an immutable snapshot and a durable job only when both `train` and `validation` are present. Page groups remain in a single split; holdout and Locked Test rows are excluded from training.

## Local automatic training

The backend background worker checks a real CUDA-enabled PyTorch runtime, free VRAM, available RAM, and free work-disk space before it claims a local job. The defaults are 6 GiB free VRAM, 8 GiB free RAM, and 8 GiB free disk. Adjust `VIETOCR_TRAINING_MIN_VRAM_MIB`, `VIETOCR_TRAINING_MIN_RAM_GB`, and `VIETOCR_TRAINING_MIN_DISK_GB` only for a machine profile that has been checked. CPU-only PyTorch, unavailable CUDA, a failed hardware probe, or insufficient resources routes a ready job to `WAITING_FOR_COLAB_WORKER`.

Set `VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=true`. Set `VIETOCR_TRAINING_WORK_DIR` to a persistent local directory with enough free disk. The backend must be installed with the matching CUDA-enabled PyTorch build; the OCR runtime's existing CPU-only PyTorch installation will not qualify. Do not install or replace PaddleOCR/Tesseract for training.

## One-time Colab worker setup

1. Create one random worker token of at least 32 characters. Store it only in the backend's secret environment as `VIREAD_TRAINING_WORKER_TOKEN` and in Google Colab Secrets with the same name. For example, generate a token locally with Python's `secrets.token_urlsafe(48)` and transfer it through the secret managers; do not paste it into a notebook cell, issue, log, or Git.
2. Set `VIREAD_API_BASE` in Colab Secrets to the HTTPS base URL of the deployed ViRead API. A Colab runtime cannot reach a private `localhost`; local development needs a securely configured HTTPS-accessible backend. Do not expose the service with an unauthenticated tunnel.
3. Set `VIREAD_REPOSITORY_REF` to the deployed code branch or commit if the default `feature/viread-dual-training-flows-20261112` is not where the worker implementation has been deployed.
4. Open `ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb`, connect a GPU runtime, and start the worker cell. The worker polls automatically and takes jobs without profile, dataset, test-set, run-ID, or parameter entry. It mounts Drive once and keeps a per-job resume directory there. The separate `viread_vietocr_v2_colab.ipynb` remains the manual notebook for controlled experiments and does not run the queue worker.

The Google-supported runtime start API applies to **Colab Enterprise** resources in a Google Cloud project; it requires a configured runtime resource and IAM permission such as `aiplatform.notebookRuntimes.start`. This repository has no configured Google Cloud project, Enterprise runtime ID, or backend Google identity, so it cannot start or verify an Enterprise runtime here. Standard browser Colab is handled by the persistent worker notebook: while its GPU runtime stays connected, every queued job is automatic; after that runtime stops, an operator must reconnect it and start the worker cell again. Jobs remain `WAITING_FOR_COLAB_WORKER` until then. Do not use private Colab endpoints, cookies, or browser automation. An Enterprise auto-start integration remains blocked until a project, runtime, supported identity, and post-start worker deployment are provisioned.

The worker token only authorizes the Flow 2 worker routes. It is not a Supabase key and is not an Admin browser bearer token. The backend validates it in constant time, then enforces the job lease, dataset identity, parent lineage and Admin ownership for each operation. Rotate the token in both secret managers together.

## Training, recovery, and promotion

Local and Colab workers call the same `ai.vietocr_v2.train.run_training` implementation with the settings saved in the job. Candidate checkpoints are written durably before upload; Colab resume state is kept in Drive. The workers hash-check the dataset receipt, every image, the parent checkpoint, uploaded shards, and checkpoint lineage. A lease and `SKIP LOCKED` prevent concurrent claims. Interrupted Colab jobs become claimable after lease expiry and retry up to three times with backoff. A completed candidate automatically runs the paired Original/V2 benchmark if an independent Locked Test exists; otherwise it stays a candidate awaiting that dataset. Quality-gate failure never activates the candidate. Admin approval remains a separate required action.

For local development, start the backend normally; the scheduler starts from the app lifespan unless `VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=false`. Apply migrations before starting the updated API. The job appears on Admin → Huấn luyện OCR with target, state, stage, retry count, and safe error code. Typical states include `WAITING_FOR_DATA`, `QUEUED`, `LOCAL_RUNNING`, `FALLBACK_QUEUED_COLAB`, `WAITING_FOR_COLAB_WORKER`, `COLAB_RUNNING`, `CANDIDATE`, `BENCHMARKED`, `FAILED`, and `BLOCKED`.

No GPU, database, Supabase Storage, configured provider, Colab runtime, training run, or benchmark is claimed to be live until the deployment has been connected and an actual run record is visible. The token and database URL are never stored in the notebook or frontend source.
