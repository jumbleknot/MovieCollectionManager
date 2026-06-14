/**
 * RenderImportReport unit tests (014 enhancement 3).
 *
 * The post-import report card shows a concise count and, when expanded, lists every skipped and
 * failed row with its reason — so the user can see exactly which movies were not imported and why.
 */
import { fireEvent, render } from '@testing-library/react-native';

import { RenderImportReport } from '@/components/agent/render-import-report';

const SKIPPED = [
  { title: 'Expected Import Failure 2', reason: 'invalid Year' },
  { title: 'Expected Import Failure 3', reason: 'missing Year' },
];
const FAILED = [
  { title: 'Expected Import Failure 1', reason: 'Owned must be true or false (mc-service 422)' },
];

describe('RenderImportReport', () => {
  it('shows a concise count and hides the detail until expanded', () => {
    const { getByTestId, queryByTestId } = render(
      <RenderImportReport imported={200} skipped={SKIPPED} failed={FAILED} />,
    );
    expect(getByTestId('import-report-summary')).toHaveTextContent('Imported 200. 2 skipped, 1 failed.');
    expect(queryByTestId('import-report-detail')).toBeNull(); // collapsed by default
  });

  it('lists every skipped and failed row with its reason when expanded', () => {
    const { getByTestId } = render(
      <RenderImportReport imported={200} skipped={SKIPPED} failed={FAILED} />,
    );
    fireEvent.press(getByTestId('import-report-toggle'));
    const skipped = getByTestId('import-report-skipped');
    expect(skipped).toHaveTextContent(/Expected Import Failure 2 — invalid Year/);
    expect(skipped).toHaveTextContent(/Expected Import Failure 3 — missing Year/);
    const failed = getByTestId('import-report-failed');
    expect(failed).toHaveTextContent(/Expected Import Failure 1 — Owned must be true or false/);
  });

  it('omits a section that has no rows', () => {
    const { getByTestId, queryByTestId } = render(
      <RenderImportReport imported={5} skipped={[]} failed={FAILED} />,
    );
    fireEvent.press(getByTestId('import-report-toggle'));
    expect(queryByTestId('import-report-skipped')).toBeNull();
    expect(getByTestId('import-report-failed')).toBeTruthy();
  });
});
