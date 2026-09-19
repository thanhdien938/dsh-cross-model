import { useEffect, useRef } from 'react';

export interface UseDialogA11yOptions {
  onClose?: () => void;
  canClose?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement>;
}

export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(
  options: UseDialogA11yOptions = {},
) {
  const dialogRef = useRef<T>(null);
  const { onClose, canClose = true, initialFocusRef } = options;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const canCloseRef = useRef(canClose);
  canCloseRef.current = canClose;

  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;

  // Track the opener element across renders, set once on mount
  const openerRef = useRef<HTMLElement | null>(null);

  // Mount effect: capture opener, set initial focus once, restore focus on unmount once
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;

    const timer = setTimeout(() => {
      if (initialFocusRefRef.current?.current) {
        initialFocusRefRef.current.current.focus();
        return;
      }
      if (dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          dialogRef.current.focus();
        }
      }
    }, 16);

    return () => {
      clearTimeout(timer);
      if (openerRef.current && typeof openerRef.current.focus === 'function') {
        openerRef.current.focus();
      }
    };
  }, []);

  // Keyboard navigation effect: Escape and Tab trapping
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (canCloseRef.current && onCloseRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  return dialogRef;
}
