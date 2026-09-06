/**
 * ToolCallPending (066 T003) — the shared incomplete state every generative-UI render site falls
 * back to while a tool call's arguments are still streaming.
 */
import React from 'react';
import { render } from '@/test-support/render';

import { ToolCallPending } from '@/components/agent/tool-call-pending';

describe('ToolCallPending', () => {
  it('renders its label under a stable testID', () => {
    const { getByTestId } = render(<ToolCallPending label="Loading the movie…" />);

    expect(getByTestId('tool-call-pending')).toBeTruthy();
    expect(getByTestId('tool-call-pending-label')).toHaveTextContent('Loading the movie…');
  });
});
