import { useEffect, useRef, type RefObject } from 'react';

type FocusTrapOptions = {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusable(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function useFocusTrap({ active, containerRef, onEscape }: FocusTrapOptions): void {
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFirstControl = () => {
      const focusable = visibleFocusable(containerRef.current);
      (focusable[0] ?? containerRef.current)?.focus();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        onEscape();
        return;
      }
      if (ev.key !== 'Tab') return;
      const focusable = visibleFocusable(containerRef.current);
      if (focusable.length === 0) {
        ev.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(focusFirstControl, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [active, containerRef, onEscape]);
}
