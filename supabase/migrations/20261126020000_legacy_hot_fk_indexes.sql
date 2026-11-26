-- Add missing non-partial B-tree foreign-key indexes on legacy high-traffic tables
-- (readingsessions, readingevents, bookpages, comprehensionquestions,
-- difficult_word_practice_attempts, parent_book_page_submissions, books,
-- childbookcollections, pagerevisions, and core reading/consent tables).
-- Strictly additive, idempotent, lock-bounded, and safe on both full production
-- databases and minimal CI schemas.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $legacy_hot_fk_indexes$
declare
  target record;
  tbl_oid oid;
  col_attnum smallint;
  leading_idx_exists boolean;
begin
  for target in
    select *
    from (
      values
        ('bookpages', 'currentverifiedrevisionid', 'idx_bookpages_currentverifiedrevisionid'),
        ('books', 'createdby', 'idx_books_createdby'),
        ('books', 'deleted_by', 'idx_books_deleted_by'),
        ('books', 'suspended_by', 'idx_books_suspended_by'),
        ('childbookcollections', 'bookid', 'idx_childbookcollections_bookid'),
        ('comprehensionquestions', 'pageid', 'idx_comprehensionquestions_pageid'),
        ('comprehensionquestions', 'pagerevisionid', 'idx_comprehensionquestions_pagerevisionid'),
        ('consentrecords', 'childid', 'idx_consentrecords_childid'),
        ('consentrecords', 'parentid', 'idx_consentrecords_parentid'),
        ('difficult_word_practice_attempts', 'parentid', 'idx_dwpa_parentid'),
        ('difficult_word_practice_attempts', 'pageid', 'idx_dwpa_pageid'),
        ('difficult_word_practice_attempts', 'pagerevisionid', 'idx_dwpa_pagerevisionid'),
        ('difficult_word_practice_attempts', 'sessionid', 'idx_dwpa_sessionid'),
        ('difficult_word_practice_attempts', 'wordid', 'idx_dwpa_wordid'),
        ('pagerevisions', 'verifiedby', 'idx_pagerevisions_verifiedby'),
        ('parent_book_flow2_candidates', 'outbox_event_id', 'idx_parent_book_flow2_candidates_outbox_event_id'),
        ('parent_book_flow2_candidates', 'owner_parent_id', 'idx_parent_book_flow2_candidates_owner_parent_id'),
        ('parent_book_flow2_candidates', 'submission_id', 'idx_parent_book_flow2_candidates_submission_id'),
        ('parent_book_flow2_candidates', 'verified_by', 'idx_parent_book_flow2_candidates_verified_by'),
        ('parent_book_moderation_requests', 'decided_by', 'idx_parent_book_mod_req_decided_by'),
        ('parent_book_moderation_requests', 'owner_parent_id', 'idx_parent_book_mod_req_owner_parent_id'),
        ('parent_book_page_submissions', 'approved_by', 'idx_pbps_approved_by'),
        ('parent_book_page_submissions', 'committed_page_id', 'idx_pbps_committed_page_id'),
        ('parent_book_page_submissions', 'committed_revision_id', 'idx_pbps_committed_revision_id'),
        ('readingcomparisonreports', 'pagerevisionid', 'idx_readingcomparisonreports_pagerevisionid'),
        ('readingevents', 'pagerevisionid', 'idx_readingevents_pagerevisionid'),
        ('readingevents', 'wordid', 'idx_readingevents_wordid'),
        ('readingpresencealerts', 'childid', 'idx_readingpresencealerts_childid'),
        ('readingsessionpages', 'pagerevisionid', 'idx_readingsessionpages_pagerevisionid'),
        ('readingsessions', 'currentpageid', 'idx_readingsessions_currentpageid'),
        ('readingsessions', 'endpageid', 'idx_readingsessions_endpageid'),
        ('readingsessions', 'selectedpageid', 'idx_readingsessions_selectedpageid'),
        ('readingsessions', 'selectedpagerevisionid', 'idx_readingsessions_selectedpagerevisionid'),
        ('readingsessions', 'startpageid', 'idx_readingsessions_startpageid')
    ) as t(tbl_name, col_name, idx_name)
  loop
    tbl_oid := to_regclass('public.' || target.tbl_name);
    if tbl_oid is null then
      continue;
    end if;

    select a.attnum
      into col_attnum
      from pg_attribute a
     where a.attrelid = tbl_oid
       and a.attname = target.col_name
       and not a.attisdropped;

    if col_attnum is null then
      continue;
    end if;

    -- Skip if any non-partial valid index already has this FK column as its leading key.
    select exists (
      select 1
      from pg_index i
      where i.indrelid = tbl_oid
        and i.indisvalid
        and i.indpred is null
        and i.indkey[0] = col_attnum
    ) into leading_idx_exists;

    if not leading_idx_exists and to_regclass('public.' || target.idx_name) is null then
      execute format(
        'create index if not exists %I on public.%I (%I)',
        target.idx_name,
        target.tbl_name,
        target.col_name
      );
    end if;
  end loop;
end;
$legacy_hot_fk_indexes$;

commit;
