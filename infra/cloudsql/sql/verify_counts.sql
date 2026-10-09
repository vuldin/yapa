-- verify_counts.sql: read-only fingerprint of the YAPA data, used by the
-- migration check and the restore drill (RESTORE.md). Run the same file on
-- both sides and diff the output. Safe as any role with SELECT.

\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT now() AS taken_at;

SELECT max(version) AS schema_version FROM schema_version;

SELECT count(*) AS documents,
       max(synced_at) AS max_synced_at,
       count(*) FILTER (WHERE collection = 'global' OR collection LIKE 'private-%' OR collection LIKE 'local-%') AS local_only_rows,
       count(*) FILTER (WHERE vector_dims(embedding) <> 384) AS non_384_rows
  FROM documents;

SELECT collection, count(*) AS n FROM documents GROUP BY 1 ORDER BY 1;
SELECT origin_user, count(*) AS n FROM documents GROUP BY 1 ORDER BY 1;

-- Content and embedding checksum over every row (order-independent of storage).
SELECT md5(string_agg(id || ':' || md5(content) || ':' || md5(embedding::text) || ':' || md5(metadata::text), ',' ORDER BY id))
       AS documents_checksum
  FROM documents;

SELECT (SELECT count(*) FROM users)     AS users,
       (SELECT count(*) FROM deletions) AS deletions,
       (SELECT count(*) FROM audit_log) AS audit_log;

COMMIT;
