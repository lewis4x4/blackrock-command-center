import { useRef, type ReactNode } from 'react';
import { useFocusTrap } from './hooks/useFocusTrap';

export function SlideOver({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap({ active: open, containerRef: panelRef, onEscape: onClose });

  if (!open) return null;

  return (
    <div className="slideover-root" role="dialog" aria-modal="true" aria-label={title}>
      <button className="slideover-backdrop" aria-label="Close panel" onClick={onClose} />
      <aside className="slideover-panel" ref={panelRef} tabIndex={-1}>
        <header className="slideover-header">
          <div className="slideover-title-wrap">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="slideover-close" aria-label="Close panel" onClick={onClose}>×</button>
        </header>
        <div className="slideover-body">{children}</div>
        {footer && <footer className="slideover-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
