/**
 * BFF /bff-api/agent/import-upload route (014 US2, T036).
 *
 * Accepts a spreadsheet (CSV/.xlsx) multipart upload, writes the raw bytes to the transient
 * file store (`import:file:<handle>`, short TTL, size guard), and stashes the resulting
 * `{handle, filename}` reference per user. The opaque handle stays server-side: the client just
 * uploads, then sends an `import …` turn; the next `/bff-api/agent/run` reads the reference and
 * bridges it to the gateway as the `X-Import-File` header → `config["configurable"].file_handle`
 * (mirrors the UI-snapshot bridge — never the run body, never checkpointed). spreadsheet-mcp
 * fetches the bytes by handle and deletes them (single-use).
 *
 * Auth is enforced per-handler (requireAuth → requireMcUser) like every agent route (enumerated
 * in agent-route-auth.integration.test.ts). The upload is audit-logged by filename/size ONLY —
 * never its contents or any token (SC-004 / Agent Security).
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { putImportFile, FileTooLargeError } from '@/bff-server/transient-file-store';
import { setAgentImportFile } from '@/bff-server/cache-service';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { audit } from '@/bff-server/audit-sink';

/** Accepted upload extensions (content is validated structurally by spreadsheet-mcp on parse). */
const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xlsm'];

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(async () => {
    try {
      const headers = Object.fromEntries(req.headers.entries());
      const { user } = await requireAuth(headers);
      requireMcUser(user);

      // Minimal multipart surface — the project's TS lib types `FormData` without `get`.
      const form = (await req.formData().catch(() => null)) as { get(name: string): unknown } | null;
      const file = form?.get('file');
      if (!(file instanceof File)) {
        throw new AuthError(AuthErrorCode.INVALID_INPUT, 'No file provided', 400);
      }
      const filename = file.name || 'upload.xlsx';
      if (!hasAllowedExtension(filename)) {
        throw new AuthError(
          AuthErrorCode.INVALID_INPUT,
          'Unsupported file type — upload a CSV or Excel (.xlsx) spreadsheet',
          400,
        );
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      let handle: string;
      try {
        handle = await putImportFile(bytes);
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          throw new AuthError(AuthErrorCode.INVALID_INPUT, 'File is empty or too large', 400);
        }
        throw err;
      }

      await setAgentImportFile(user.id, JSON.stringify({ handle, filename }));

      // Audit by filename + size only — NEVER the contents or the handle (SC-004).
      audit('agent_import_upload', { userId: user.id, filename, sizeBytes: bytes.length });

      // The handle is intentionally NOT returned to the client (server-side only).
      return new Response(JSON.stringify({ filename }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return handleMcApiError(err, 'agent_import_upload');
    }
  });
}
