-- Additive schema for one ReadingSession covering a verified page range.
ALTER TABLE public.readingsessions
    ADD COLUMN IF NOT EXISTS startpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS endpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS currentpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.readingsessionpages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
    pageid uuid NOT NULL REFERENCES public.bookpages(id) ON DELETE RESTRICT,
    pagerevisionid uuid NOT NULL REFERENCES public.pagerevisions(id) ON DELETE RESTRICT,
    pagenumber smallint NOT NULL CHECK (pagenumber >= 1),
    pageorder smallint NOT NULL CHECK (pageorder >= 0),
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
    startedat timestamptz,
    completedat timestamptz,
    CONSTRAINT uq_readingsessionpages_session_order UNIQUE (sessionid, pageorder),
    CONSTRAINT uq_readingsessionpages_session_page UNIQUE (sessionid, pageid)
);

CREATE INDEX IF NOT EXISTS ix_readingsessionpages_session_status
    ON public.readingsessionpages (sessionid, status);
