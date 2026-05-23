import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message: string };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error('[ErrorBoundary] render error', error);
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="band">
        <div className="err-wrap">
          <div className="err-h">Something went wrong</div>
          <div className="err-detail">{this.state.message || 'Unknown render error'}</div>
          <button className="btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
