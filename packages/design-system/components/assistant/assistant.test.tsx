/**
 * Design-system unit tests — AssistantAvatar + ChatBubble + ApprovalBubble (feature 015, T032).
 * Verifies the SVG avatar render + press, chat sender variants + thinking indicator,
 * and the approval bubble's approve/reject/loading/done states.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { AssistantAvatar } from './AssistantAvatar';
import { ChatBubble, ApprovalBubble } from './ChatBubble';

async function renderDS(ui: React.ReactElement) {
  return await render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('AssistantAvatar', () => {
  it('renders the SVG robot with its accessibility label', async () => {
    const { getByLabelText } = await renderDS(<AssistantAvatar />);
    expect(getByLabelText('Movie Assistant')).toBeTruthy();
  });

  it('fires onPress when pressed', async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await renderDS(<AssistantAvatar onPress={onPress} />);
    await fireEvent.press(getByLabelText('Movie Assistant'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders the thinking state without throwing', async () => {
    const { getByLabelText } = await renderDS(<AssistantAvatar thinking />);
    expect(getByLabelText('Movie Assistant')).toBeTruthy();
  });
});

describe('ChatBubble', () => {
  it('renders a user message', async () => {
    const { getByText } = await renderDS(<ChatBubble sender="user" message="Hello" />);
    expect(getByText('Hello')).toBeTruthy();
  });

  it('renders an assistant message with the avatar', async () => {
    const { getByText, getByLabelText } = await renderDS(
      <ChatBubble sender="assistant" message="Hi there" />,
    );
    expect(getByText('Hi there')).toBeTruthy();
    expect(getByLabelText('Movie Assistant')).toBeTruthy();
  });

  it('renders a system message', async () => {
    const { getByText } = await renderDS(<ChatBubble sender="system" message="Session expired" />);
    expect(getByText('Session expired')).toBeTruthy();
  });

  it('shows the thinking indicator (no message text) for a thinking assistant turn', async () => {
    const { queryByText } = await renderDS(<ChatBubble sender="assistant" thinking />);
    expect(queryByText('Hi there')).toBeNull();
  });

  it('renders generative children inside the bubble', async () => {
    const { getByText } = await renderDS(
      <ChatBubble sender="assistant" message="Found one">
        <ChatBubble sender="system" message="Inception (2010)" />
      </ChatBubble>,
    );
    expect(getByText('Found one')).toBeTruthy();
    expect(getByText('Inception (2010)')).toBeTruthy();
  });
});

describe('ApprovalBubble', () => {
  const baseProps = {
    title: 'Add 3 movies?',
    description: 'These will be added to Favourites.',
    onApprove: jest.fn(),
    onReject: jest.fn(),
  };

  it('renders title, description, and the approve/reject actions', async () => {
    const { getByText } = await renderDS(<ApprovalBubble {...baseProps} />);
    expect(getByText('Add 3 movies?')).toBeTruthy();
    expect(getByText('These will be added to Favourites.')).toBeTruthy();
    expect(getByText('Approve')).toBeTruthy();
    expect(getByText('Reject')).toBeTruthy();
  });

  it('fires onApprove and onReject', async () => {
    const onApprove = jest.fn();
    const onReject = jest.fn();
    const { getByText } = await renderDS(
      <ApprovalBubble {...baseProps} onApprove={onApprove} onReject={onReject} />,
    );
    await fireEvent.press(getByText('Approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    await fireEvent.press(getByText('Reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('does not fire onApprove while loading', async () => {
    const onApprove = jest.fn();
    const { getByText } = await renderDS(
      <ApprovalBubble {...baseProps} onApprove={onApprove} loading />,
    );
    await fireEvent.press(getByText(/Applying/));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('shows the approved status and hides the actions once approved', async () => {
    const { getByText, queryByText } = await renderDS(
      <ApprovalBubble {...baseProps} approved />,
    );
    expect(getByText(/Approved/)).toBeTruthy();
    expect(queryByText('Approve')).toBeNull();
  });
});
