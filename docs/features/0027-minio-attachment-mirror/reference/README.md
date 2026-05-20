# ZaloCRM-3.0 reference material for Feature 0027

These files are verbatim copies from `/tmp/zalocrm3` (saved as `.txt` so
TypeScript doesn't try to compile them — they reference 3.0's import paths
which don't exist in our codebase).

## Files

- **`3.0-minio-client.ts.txt`** — the storage wrapper. Port to
  `backend/src/shared/storage/minio-client.ts`. Adapt imports to our
  `config/index.ts`.
- **`3.0-chat-attachment-routes.ts.txt`** — the full outbound attachment
  flow with MinIO mirror. 277 lines. Port to
  `backend/src/modules/chat/chat-routes.ts` (or extract to a new
  `chat-attachment-routes.ts` if the agent prefers). Note this file has
  features we don't have:
    - Multi-file upload in one request (we currently accept 1 file).
    - Separate image/video/file send paths (we currently use one
      `sendMessage` for all).
    - `sendNativeVideo` helper (we don't have this).
    - `zaloOps.sendFile` fallback (we don't have this).
  Port the **MinIO integration** + the file-classification logic, but
  KEEP our current single-file API contract for now. Multi-file is a
  separate feature.
- **`3.0-docker-compose-minio-block.yml.txt`** — the `minio` +
  `minio-init` service definitions + the `minio_data` volume. Port to
  our `docker-compose.yml` and `docker-compose.dev.yml`.

## What the SPEC asks for

The SPEC at `../SPEC.md` is the authoritative scope. These reference
files are *implementation aids*, not requirements. Deviations from these
files are fine as long as they're documented and the SPEC's ACs pass.

## Why these files live here

`/tmp/zalocrm3` is outside the worktree sandbox, so implementation
agents can't read it directly. Committing the reference here is the
workaround. Delete these files when Feature 0027 ships and they've
served their purpose.
