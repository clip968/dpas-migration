// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

const fitViewMock = vi.fn(() => Promise.resolve(true));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    MiniMap: () => null,
    Panel: ({ children, position }: { children: React.ReactNode; position: string }) => (
      <div data-position={position}>{children}</div>
    ),
    Position: {
      Bottom: 'bottom',
      Left: 'left',
      Right: 'right',
      Top: 'top',
    },
    ReactFlow: ({ children, onInit }: { children: React.ReactNode; onInit?: (instance: { fitView: typeof fitViewMock }) => void }) => {
      React.useEffect(() => {
        onInit?.({ fitView: fitViewMock });
      }, [onInit]);

      return <div data-testid="react-flow">{children}</div>;
    },
  };
});

describe('App tree viewport', () => {
  afterEach(() => {
    cleanup();
    fitViewMock.mockClear();
  });

  it('centers the tree after ReactFlow initializes', async () => {
    render(<App />);

    await waitFor(() => {
      expect(fitViewMock).toHaveBeenCalledWith(expect.objectContaining({ padding: expect.any(Number) }));
    });
  });

  it('provides a bottom-right button that recenters the tree', async () => {
    render(<App />);
    await waitFor(() => expect(fitViewMock).toHaveBeenCalled());
    fitViewMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /트리 중앙으로/ }));

    expect(fitViewMock).toHaveBeenCalledWith(expect.objectContaining({ duration: expect.any(Number) }));
  });

  it('does not reset the viewport when a path card is selected', async () => {
    render(<App />);
    await waitFor(() => expect(fitViewMock).toHaveBeenCalled());
    fitViewMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /build loop/ }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('does not render the full card list in the sidebar', () => {
    const { container } = render(<App />);

    expect(container.querySelector('.card-list')).toBeNull();
    expect(screen.queryByPlaceholderText(/bio/)).toBeNull();
  });

  it('renders the card-writer summary without exposing duplicate internal fields', () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '상세 보기' }));

    expect(screen.queryByRole('heading', { name: '한 줄 결론' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: '핵심 질문' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: '입력 -> 변환 -> 출력' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '핵심 모델' })).not.toBeNull();
    expect(container.querySelector('.schema-visual pre code')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: '확인 질문' })).not.toBeNull();
  });
});
