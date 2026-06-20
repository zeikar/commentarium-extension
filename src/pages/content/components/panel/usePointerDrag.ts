// generic pointer-capture drag; reused by inline anchored comments.
import { useCallback, useEffect, useRef } from "react";
import type { PointerEventHandler } from "react";

interface DragOptions {
  onStart?(): void;
  onMove(delta: { dx: number; dy: number }, e: PointerEvent): void;
  onEnd?(): void;
}

// Listener references kept in a ref so releaseAndCleanup can remove the exact
// same function instances that were added (gotcha #1).
interface GestureListeners {
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  cancel: (e: PointerEvent) => void;
}

export function usePointerDrag(options: DragOptions): {
  onPointerDown: PointerEventHandler<Element>;
} {
  // Latest options ref — avoids stale closures without re-creating handlers (gotcha #2).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const capturedElementRef = useRef<Element | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const listenersRef = useRef<GestureListeners | null>(null);

  const releaseAndCleanup = useCallback(() => {
    // Remove window listeners using the exact references that were added.
    if (listenersRef.current) {
      const { move, up, cancel } = listenersRef.current;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      listenersRef.current = null;
    }

    // Release pointer capture, guarded because releasing an already-released
    // pointer can throw (e.g. element removed from DOM mid-drag).
    if (capturedElementRef.current !== null && pointerIdRef.current !== null) {
      try {
        capturedElementRef.current.releasePointerCapture(pointerIdRef.current);
      } catch {
        // ignore: pointer may already be released
      }
      capturedElementRef.current = null;
      pointerIdRef.current = null;
    }
  }, []);

  // Unmount cleanup tears down any in-progress gesture (gotcha #5).
  useEffect(() => () => releaseAndCleanup(), [releaseAndCleanup]);

  const onPointerDown: PointerEventHandler<Element> = useCallback((e) => {
    // Only respond to primary (left) mouse button / primary touch.
    if (e.button !== 0) return;

    // Guard against re-entrancy: clean up any orphaned prior-gesture listeners
    // before setting up new state (e.g. rapid pointerdown before pointerup).
    releaseAndCleanup();

    const startX = e.clientX;
    const startY = e.clientY;

    // Use currentTarget — target can be a child element (gotcha #4).
    capturedElementRef.current = e.currentTarget;
    pointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);

    optionsRef.current.onStart?.();
    e.preventDefault();

    // Create handlers once per gesture so releaseAndCleanup can remove them
    // by reference (gotcha #1).
    const handleMove = (ev: PointerEvent) => {
      optionsRef.current.onMove(
        { dx: ev.clientX - startX, dy: ev.clientY - startY },
        ev,
      );
    };

    const handleEnd = () => {
      releaseAndCleanup();
      optionsRef.current.onEnd?.();
    };

    const listeners: GestureListeners = {
      move: handleMove,
      up: handleEnd,
      cancel: handleEnd,
    };
    listenersRef.current = listeners;

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  }, []); // stable — reads latest options via optionsRef (gotcha #2)

  return { onPointerDown };
}
