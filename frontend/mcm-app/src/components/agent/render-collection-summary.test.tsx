/**
 * RenderCollectionSummary unit tests (T052).
 *
 * The organizer emits a `render_collection_summary` AG-UI tool call whose args are the contract
 * props (generative-ui-and-actions.md). CopilotKit's `useRenderTool` maps those args to this
 * presentational component, rendered inline in the assistant dock. These tests pin the
 * presentational contract deterministically (no agent/gateway).
 */
import { render } from '@/test-support/render';

import { RenderCollectionSummary } from '@/components/agent/render-collection-summary';

const PROPS = {
  collectionId: 'c1',
  name: 'Sci-Fi',
  movieCount: 3,
  role: 'owner' as const,
};

describe('RenderCollectionSummary', () => {
  it('renders the collection name', () => {
    const { getByTestId } = render(<RenderCollectionSummary {...PROPS} />);
    expect(getByTestId('render-collection-summary')).toBeTruthy();
    expect(getByTestId('render-collection-summary-name')).toHaveTextContent('Sci-Fi');
  });

  it('renders a pluralized movie count and the role', () => {
    const { getByTestId } = render(<RenderCollectionSummary {...PROPS} />);
    expect(getByTestId('render-collection-summary-count')).toHaveTextContent('3 movies');
    expect(getByTestId('render-collection-summary-role')).toHaveTextContent('Owner');
  });

  it('uses the singular "movie" for a count of one', () => {
    const { getByTestId } = render(<RenderCollectionSummary {...PROPS} movieCount={1} />);
    expect(getByTestId('render-collection-summary-count')).toHaveTextContent('1 movie');
  });
});
