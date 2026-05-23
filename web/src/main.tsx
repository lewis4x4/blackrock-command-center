import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DecisionConfirmPage, confirmRouteFromLocation } from './confirmRoute';
import { ErrorBoundary } from './ErrorBoundary';
import './index.css';

function Root() {
  const confirmRoute = confirmRouteFromLocation();
  if (confirmRoute) return <DecisionConfirmPage {...confirmRoute} />;
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Root /></React.StrictMode>
);
