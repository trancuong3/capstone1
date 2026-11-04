# ViRead Backend Deployment: Render + Supabase Transaction Pooler

## Production connection mode

The supported production default for a Render FastAPI Web Service is the Supabase **Shared Transaction Pooler** on port **6543**.

The backend uses:

- SQLAlchemy 2.x AsyncSession.
- asyncpg.
- SQLAlchemy NullPool.
- SQLAlchemy asyncpg prepared_statement_cache_size=0.
- asyncpg statement_cache_size=0.
- TLS using the Supabase CA certificate with hostname verification.
- A per-process transaction concurrency limit.

Do not use Supabase Direct Connection as the default from Render. Render's outbound networking does not provide the IPv6 path used by Supabase's default Direct endpoint. Do not use Shared Session Pooler as the default unless a verified application requirement needs PostgreSQL session state.

## 1. Get the correct Supabase connection string

1. Open the Supabase project Dashboard.
2. Open **Connect**.
3. Select **Transaction Pooler**.
4. Copy the host, port, database, username and connection information shown by the Dashboard.
5. Use port **6543**.
6. Convert the URI to the SQLAlchemy async driver form: **postgresql+asyncpg://...**.
7. URL-encode the database password before inserting it into the URI.

Do not guess the pooler hostname or username. The Shared Pooler endpoint and username are project-specific.

Set APP_ENVIRONMENT=production and DATABASE_POOLER_MODE=transaction. The backend rejects a production configuration that omits transaction mode or uses a different port. It adds prepared_statement_cache_size=0 using SQLAlchemy URL utilities and passes statement_cache_size=0 to asyncpg.

## 2. Render environment variables

Configure these under the Render Web Service's Environment section:

| Variable | Production value |
|---|---|
| APP_ENVIRONMENT | production |
| DATABASE_URL | The SQLAlchemy asyncpg URL from Supabase Transaction Pooler, port 6543 |
| DATABASE_POOLER_MODE | transaction |
| DATABASE_SSL_REQUIRED | true |
| DATABASE_SSL_ROOT_CERT | /etc/secrets/supabase-root.crt |
| DATABASE_CONCURRENCY_LIMIT | 8 initially; tune only after load tests |
| DATABASE_CONCURRENCY_WAIT_TIMEOUT | 5 seconds initially |
| DATABASE_CONNECT_TIMEOUT | 10 seconds |
| DATABASE_COMMAND_TIMEOUT | 30 seconds |
| SUPABASE_URL | Project URL |
| SUPABASE_KEY | Publishable key |
| SUPABASE_SECRET_KEY | Server-only secret key, if required by configured Admin/Storage operations |

Never place the database URL, password, Supabase secret key or service-role key in the frontend or a committed file.

### Upload the Supabase CA certificate

1. Obtain the correct CA certificate from the Supabase Dashboard / database connection information for this project.
2. In Render, open the Web Service's **Environment** section.
3. Under **Secret Files**, add a file named **supabase-root.crt**.
4. Paste the CA certificate contents into the secret file.
5. Set DATABASE_SSL_ROOT_CERT=/etc/secrets/supabase-root.crt.
6. Save and redeploy.

Render exposes Secret Files at /etc/secrets/<filename>. The backend uses ssl.create_default_context(cafile=...), which verifies the certificate chain and hostname. Production startup fails when transaction mode is selected but the CA file is missing.

Do not disable certificate verification to work around a bad certificate path or hostname.

## 3. Start command and initial scaling

Recommended initial Render Web Service start command, with the service root at the repository root:

~~~bash
cd backend && uvicorn app.sever:app --host 0.0.0.0 --port "$PORT" --workers 1
~~~

Start with:
- One Render Web Service instance.
- One Uvicorn worker per instance.
- DATABASE_CONCURRENCY_LIMIT=8 per worker as an initial upper bound.
- No background or scheduled DB worker unless its connection budget is also configured.

Do not infer that one process can serve a particular number of users from the database connection limit alone. Measure CPU, memory, HTTP latency, queueing and DB behavior before scaling.

## 4. How the concurrency limit works

NullPool does not maintain an application-side pool of idle connections. Each connection is closed when its SQLAlchemy connection lifecycle ends.

A process-local limiter is acquired immediately before the first database operation and remains held until the SQLAlchemy session commits, rolls back or closes. It is not a global limit across Render instances.

The theoretical upper bound is:

~~~text
maximum active application DB transactions
  = Render instances
  × Uvicorn workers per instance
  × DATABASE_CONCURRENCY_LIMIT
~~~

For example, three instances with one worker each and a limit of eight can have at most 24 application transactions holding a permit. This is a theoretical client-side bound, not a guarantee that Supabase executes 24 PostgreSQL backend transactions concurrently. Supavisor multiplexes transaction-pooler clients over its configured backend pool.

Every independently started background worker or scheduled process has its own process-local limit and must be included in the connection budget.

## 5. Transaction boundaries

Do not hold a database transaction or row lock while performing:
- Supabase Storage upload/download or signed-URL calls.
- Tesseract OCR / OpenCV processing.
- ElevenLabs STT/TTS.
- Other external HTTP requests.
- CPU-intensive alignment or media work.

End the database transaction before external work, then open a new short transaction to persist or finalize the result. When a workflow needs a reservation, design a durable reservation with explicit concurrency and cleanup semantics; do not keep a row lock open while waiting for an external service.

Use transaction-scoped locks such as SELECT ... FOR UPDATE only inside short database transactions. Do not add session-level PostgreSQL state, temporary tables, LISTEN/NOTIFY, session advisory locks or persistent SET state to the transaction-pooler application path without a separate architecture review.

## 6. Local development and CI

Local PostgreSQL and the GitHub Actions PostgreSQL 16 service use:

~~~env
DATABASE_POOLER_MODE=local
DATABASE_SSL_REQUIRED=false
DATABASE_URL=postgresql+asyncpg://<user>:<password>@<host>:5432/postgres
~~~

The application still disables prepared-statement caches for local mode so tests exercise the same SQLAlchemy/asyncpg execution settings. Local mode only disables the production Supabase CA requirement; do not set it on the Render service.

Normal CI must not require a Supabase password or staging project.

## 7. Staging smoke test

Before adding production credentials to Render, use a non-production Supabase project and verify:

1. TLS connection succeeds using the CA Secret File.
2. The configured URL uses the Shared Transaction Pooler host and port 6543.
3. Several sequential SELECT statements succeed.
4. A transaction can insert/update and commit test data.
5. A transaction can roll back test data.
6. Repeated ORM statements succeed across separate transactions.
7. Concurrent sessions at and above the configured application limit are bounded.
8. The application reports a safe 503 after the configured wait timeout instead of creating unbounded connections.
9. Admin OCR failures clean up staged Storage objects and do not leave persistent locks.
10. Render restart and redeployment close application connections cleanly.

Never run destructive smoke tests against production data.

## 8. Monitoring and scaling

Monitor both sides of the pooler:
- Supabase Shared Pooler Client Connections.
- Supabase PostgreSQL backend / Database Connections.
- PostgreSQL query latency and saturation.
- Render CPU and memory.
- HTTP p50 / p95 / p99.
- 5xx responses.
- Application concurrency-limit timeout events.
- Transaction duration.

A high number of pooler client connections does not necessarily mean the same number of PostgreSQL backend connections.

Do not increase DATABASE_CONCURRENCY_LIMIT, worker count or Render instances until you have checked the Supabase compute connection limits and measured the bottleneck.

## 9. Alternative connection mode

Shared Session Pooler is not the production default. Consider it only when code is proven to require PostgreSQL session state or session-persistent prepared statements. That change requires a separate review of session semantics, per-client backend connection capacity, worker/instance multiplication and the prepared-statement configuration.

Do not automatically fall back from Transaction Pooler to Session Pooler at runtime.
