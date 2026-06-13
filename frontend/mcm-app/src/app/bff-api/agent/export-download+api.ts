/**
 * BFF /bff-api/agent/export-download route (014 US3, T047).
 *
 * Streams a generated export workbook to the browser. The export node built the `.xlsx` via
 * spreadsheet-mcp and stored it in the transient store under an opaque handle; the assistant
 * surfaced that handle in a `download_export` UI-action. The client GETs this route with the
 * handle, and the BFF streams the bytes once (single-use) with a `Content-Disposition` attachment.
 *
 * Auth is enforced per-handler (requireAuth → requireMcUser) like every agent route. The workbook
 * was built solely from the requesting user's OWN collections (downscoped reads in the node), so
 * the opaque, single-use, short-TTL handle IS the capability — knowing it authorizes the download
 * (FR-028). Audit-logged by filename/size only — never contents or any token (SC-004).
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { takeExportFile } from '@/bff-server/transient-file-store';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { audit } from '@/bff-server/audit-sink';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(async () => {
    try {
      const headers = Object.fromEntries(req.headers.entries());
      const { user } = await requireAuth(headers);
      requireMcUser(user);

      const handle = new URL(req.url).searchParams.get('handle');
      if (!handle) {
        throw new AuthError(AuthErrorCode.INVALID_INPUT, 'Missing download handle', 400);
      }

      const file = await takeExportFile(handle);
      if (!file) {
        // Expired, already consumed, or never existed — never reveal which (FR-028).
        throw new AuthError(AuthErrorCode.UNKNOWN, 'Export not found or expired', 404);
      }

      audit('agent_export_download', {
        userId: user.id, filename: file.filename, sizeBytes: file.bytes.length,
      });

      // Copy into a plain Uint8Array — the BFF runtime's Response BodyInit accepts a typed-array
      // view but the project's TS lib does not widen Node's Buffer to BodyInit.
      const body = new Uint8Array(file.bytes);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': XLSX_MIME,
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Content-Length': String(body.byteLength),
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return handleMcApiError(err, 'agent_export_download');
    }
  });
}
