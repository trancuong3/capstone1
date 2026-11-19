---
name: viread-data
description: "Use for ViRead Supabase, PostgreSQL, auth/authorization, storage, RLS, schema, or query work."
---
# Data gateway
Open only needed files from `.agent-library/`.
- Supabase: `supabase`
- DB/query/index/schema: `supabase-postgres-best-practices`
- table design: `postgresql-table-design`
- ORM/migrations: `sqlalchemy-alembic-expert-best-practices-code-review`
- auth: `auth-implementation-patterns`
- security boundary only: `secure-code-guardian` or `owasp-top-10`
Never expose service-role/secret keys or signed URL tokens.
