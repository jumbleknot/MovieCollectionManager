/**
 * Unit tests: switching scheduled backups off gives the standing permission up, and giving the
 * permission up switches scheduled backups off (spec 083 T011, item #843 — feature 073 FR-023,
 * SC-012).
 *
 * Measured in production: "Withdraw permission" revoked the grant but left the job scheduled, so
 * the screen said "Scheduled backups are switched off" over a switch still reading On; and turning
 * the switch off cleared nothing (the client sent no `schedule` field) and revoked nothing (no
 * route called `revokeIfNoScheduleRemains`, which existed and was integration-tested).
 *
 * These mock the stores and the route wrapper, so they are unit tests. The real-Keycloak proof
 * that a revoked grant is dead is tests/integration/backup-offline-token.integration.test.ts.
 */

const mockUpdateJob = jest.fn();
const mockDeleteJob = jest.fn();
const mockClearSchedules = jest.fn();
jest.mock('@/bff-server/backup-job-store', () => ({
  ...jest.requireActual('@/bff-server/backup-job-store'),
  updateJob: (...a: unknown[]) => mockUpdateJob(...a),
  deleteJob: (...a: unknown[]) => mockDeleteJob(...a),
  clearSchedules: (...a: unknown[]) => mockClearSchedules(...a),
}));

const mockRevokeIfNone = jest.fn();
const mockRevoke = jest.fn();
jest.mock('@/bff-server/backup-offline-token', () => {
  const actual = jest.requireActual('@/bff-server/backup-offline-token');
  return {
    OfflineTokenRevocationError: actual.OfflineTokenRevocationError,
    revokeIfNoScheduleRemains: (...a: unknown[]) => mockRevokeIfNone(...a),
    revokeOfflineToken: (...a: unknown[]) => mockRevoke(...a),
  };
});

// The wrapper's authentication is covered by backup-jobs-authz.integration.test.ts; here it only
// hands the body the caller's id, which is all these routes ever see.
jest.mock('@/bff-server/backup-route-support', () => ({
  ...jest.requireActual('@/bff-server/backup-route-support'),
  withBackupRoute: (_req: Request, _action: string, body: (ctx: { userId: string; jwt: string }) => Promise<Response>) =>
    body({ userId: 'user-1', jwt: 'jwt' }),
}));

jest.mock('@/bff-server/security-headers', () => ({ securityHeaders: () => new Headers() }));

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { OfflineTokenRevocationError } from '@/bff-server/backup-offline-token';
import { PATCH, DELETE as deleteJob } from '@/app/bff-api/backups/jobs/[jobId]/index+api';
import { DELETE as withdraw } from '@/app/bff-api/backups/consent+api';

const URL_JOB = 'http://localhost:8082/bff-api/backups/jobs/job-1';

function patchReq(body: unknown): Request {
  return new Request(URL_JOB, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateJob.mockResolvedValue({ id: 'job-1', label: 'j', enabled: true });
  mockDeleteJob.mockResolvedValue(true);
  mockRevokeIfNone.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(undefined);
  mockClearSchedules.mockResolvedValue(1);
});

describe('PATCH /bff-api/backups/jobs/{id} — turning a schedule off', () => {
  it('gives the permission up when the schedule is cleared and no other schedule remains', async () => {
    const res = await PATCH(patchReq({ schedule: null }), { jobId: 'job-1' });

    expect(res.status).toBe(200);
    expect(mockUpdateJob).toHaveBeenCalledWith('user-1', 'job-1', { schedule: undefined });
    expect(mockRevokeIfNone).toHaveBeenCalledWith('user-1');
  });

  it('gives the permission up when the job is disabled', async () => {
    await PATCH(patchReq({ enabled: false }), { jobId: 'job-1' });

    expect(mockRevokeIfNone).toHaveBeenCalledWith('user-1');
  });

  it('leaves the permission alone for an edit that does not turn anything off', async () => {
    await PATCH(patchReq({ label: 'renamed' }), { jobId: 'job-1' });

    expect(mockRevokeIfNone).not.toHaveBeenCalled();
  });

  it('answers 502 when the identity provider refuses, rather than reporting the permission gone', async () => {
    mockRevokeIfNone.mockRejectedValue(new OfflineTokenRevocationError('refused'));

    const res = await PATCH(patchReq({ schedule: null }), { jobId: 'job-1' });

    expect(res.status).toBe(502);
  });

  it('does not touch the permission for a job that is not the caller’s', async () => {
    mockUpdateJob.mockResolvedValue(null);

    const res = await PATCH(patchReq({ schedule: null }), { jobId: 'job-1' });

    expect(res.status).toBe(404);
    expect(mockRevokeIfNone).not.toHaveBeenCalled();
  });
});

describe('DELETE /bff-api/backups/jobs/{id}', () => {
  it('gives the permission up when the deleted job was the last scheduled one', async () => {
    const res = await deleteJob(new Request(URL_JOB, { method: 'DELETE' }), { jobId: 'job-1' });

    expect(res.status).toBe(204);
    expect(mockRevokeIfNone).toHaveBeenCalledWith('user-1');
  });

  it('does not touch the permission when nothing was deleted', async () => {
    mockDeleteJob.mockResolvedValue(false);

    const res = await deleteJob(new Request(URL_JOB, { method: 'DELETE' }), { jobId: 'job-1' });

    expect(res.status).toBe(404);
    expect(mockRevokeIfNone).not.toHaveBeenCalled();
  });
});

describe('DELETE /bff-api/backups/consent — withdrawing the permission', () => {
  const req = () => new Request('http://localhost:8082/bff-api/backups/consent', { method: 'DELETE' });

  it('switches every schedule off, AFTER the revocation succeeded', async () => {
    const order: string[] = [];
    mockRevoke.mockImplementation(async () => { order.push('revoke'); });
    mockClearSchedules.mockImplementation(async () => { order.push('clear'); return 1; });

    const res = await withdraw(req());

    expect(res.status).toBe(200);
    expect(mockClearSchedules).toHaveBeenCalledWith('user-1');
    expect(order).toEqual(['revoke', 'clear']);
  });

  it('keeps the schedules when the identity provider refuses — nothing changed, so nothing is claimed', async () => {
    mockRevoke.mockRejectedValue(new OfflineTokenRevocationError('refused'));

    const res = await withdraw(req());

    expect(res.status).toBe(502);
    expect(mockClearSchedules).not.toHaveBeenCalled();
  });
});
