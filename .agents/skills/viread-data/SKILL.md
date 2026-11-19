---
name: viread-data
description: "ViRead Supabase/Postgres/auth/storage/RLS."
---
Use source/schema first. Load `supabase` only for provider/client/Auth/Storage/RLS semantics; DB query/index/schema performance → `supabase-postgres-best-practices`; table design → `postgresql-table-design`; ORM/migrations → `sqlalchemy-alembic-expert-best-practices-code-review`; auth design → `auth-implementation-patterns`; security-boundary review only → `secure-code-guardian` or `owasp-top-10`.
