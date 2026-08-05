/**
 * ImportProgress unit tests (047 US3 / FR-014a, FR-014b).
 *
 * The component is deliberately transport-agnostic — it takes numbers and renders a line — so
 * everything the requirement actually promises is testable here without AG-UI, agent state, or a
 * running gateway.
 */
import { render } from '@/test-support/render';

import { ImportProgress } from '@/components/agent/import-progress';

describe('ImportProgress', () => {
  it('shows how far a running import has got', () => {
    const { getByTestId } = render(<ImportProgress applied={1300} total={2300} />);
    expect(getByTestId('import-progress-label')).toHaveTextContent('Importing 1,300 of 2,300…');
  });

  it('renders NOTHING when no run is in flight (FR-014b)', () => {
    // The gateway clears the counters when the run concludes, so the report — not a stale
    // "2,300 of 2,300" line — is what the member is left looking at.
    expect(render(<ImportProgress applied={0} total={0} />).queryByTestId('import-progress')).toBeNull();
    expect(render(<ImportProgress applied={2300} total={0} />).queryByTestId('import-progress')).toBeNull();
  });

  it('updates IN PLACE rather than adding a second surface', () => {
    // The FR-014a distinction: re-rendering with a new count must leave exactly one progress
    // surface, not append another. A component that returned a list, or that the dock mapped over
    // per emission, would fail here — which is the flood the requirement exists to prevent.
    const { rerender, getAllByTestId, getByTestId } = render(
      <ImportProgress applied={500} total={2300} />,
    );
    rerender(<ImportProgress applied={1300} total={2300} />);
    rerender(<ImportProgress applied={2300} total={2300} />);

    expect(getAllByTestId('import-progress')).toHaveLength(1);
    expect(getByTestId('import-progress-label')).toHaveTextContent('Importing 2,300 of 2,300…');
  });

  it('never renders a count beyond the total, or a negative one', () => {
    // Progress arrives over a network as independent snapshots; a late-delivered or malformed
    // one must not produce "2,400 of 2,300" or a backwards bar.
    const over = render(<ImportProgress applied={9999} total={2300} />);
    expect(over.getByTestId('import-progress-label')).toHaveTextContent('Importing 2,300 of 2,300…');

    const under = render(<ImportProgress applied={-5} total={2300} />);
    expect(under.getByTestId('import-progress-label')).toHaveTextContent('Importing 0 of 2,300…');
  });

  it('exposes itself as a progress indicator to assistive tech', () => {
    const { getByTestId } = render(<ImportProgress applied={10} total={100} />);
    expect(getByTestId('import-progress').props.accessibilityRole).toBe('progressbar');
  });
});
