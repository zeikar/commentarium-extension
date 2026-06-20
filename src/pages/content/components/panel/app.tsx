import { useState, useEffect, useCallback, useRef } from "react";
import IFrame from "../iframe";
import Header from "./header";
import { usePointerDrag } from "./usePointerDrag";
import {
  type PanelRect,
  clampRect,
  defaultRect,
  rectToTransform,
  rectsEqual,
  readStoredRect,
  writeRect,
  writeRectDebounced,
} from "./geometry";

export default function App() {
  const [iframeRendered, setIframeRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const [url, setUrl] = useState("");

  const [rect, setRect] = useState<PanelRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [restored, setRestored] = useState(false);

  // latestRectRef is the synchronous source of truth for geometry — handlers
  // and effects read it instead of the (possibly stale) rect state.
  const latestRectRef = useRef<PanelRect | null>(null);
  const dragStartRectRef = useRef<PanelRect | null>(null);

  // Track current state with ref to prevent unnecessary function recreations
  const shownRef = useRef(shown);

  // Update ref whenever shown state changes
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  // Every geometry mutation goes through applyRect so latestRectRef stays current.
  const applyRect = useCallback((next: PanelRect) => {
    const clamped = clampRect(next, window.innerWidth, window.innerHeight);
    latestRectRef.current = clamped;
    setRect(clamped);
  }, []);

  // Keep stable reference to updatePage function with empty deps
  const updatePage = useCallback((newUrl: string) => {
    if (!iframeRendered) {
      setIframeRendered(true);
    }
    setShown((prevShown) => !prevShown);
    setUrl(newUrl);
  }, []);

  // Message listener always references latest state through ref
  const messageListener = useCallback((msg: any, sender: any) => {
    if (__DEV__) console.log("content view message received", msg, sender);
    if (msg.type === "toggle") {
      updatePage(msg.url);
    } else if (msg.type === "urlChange") {
      if (shownRef.current) {
        // Always reference the latest shown value
        setUrl(msg.url);
      }
    }
  }, []); // Empty dependency array

  useEffect(() => {
    if (__DEV__) console.log("content view loaded");

    // Register the event listener only once
    chrome.runtime.onMessage.addListener(messageListener);

    // Cleanup function
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []); // Empty dependency array - only runs on mount/unmount

  // Restore persisted rect (or fall back to default) on mount.
  useEffect(() => {
    const restore = async () => {
      const stored = await readStoredRect();
      applyRect(stored ?? defaultRect(window.innerWidth, window.innerHeight));
      setRestored(true);
      // Persist only when a stored rect existed AND clamping changed it.
      if (
        stored &&
        latestRectRef.current &&
        !rectsEqual(stored, latestRectRef.current)
      ) {
        writeRect(latestRectRef.current);
      }
    };
    restore();
  }, [applyRect]);

  // Re-clamp on viewport change; reads the ref, never state.
  useEffect(() => {
    const onResize = () => {
      const latest = latestRectRef.current;
      if (!latest) return;
      applyRect(latest);
      const corrected = latestRectRef.current;
      if (corrected) writeRectDebounced(corrected);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [applyRect]);

  const headerDrag = usePointerDrag({
    onStart: () => {
      setDragging(true);
      dragStartRectRef.current = latestRectRef.current;
    },
    onMove: ({ dx, dy }) => {
      const start = dragStartRectRef.current;
      if (!start) return;
      applyRect({ ...start, x: start.x + dx, y: start.y + dy });
    },
    onEnd: () => {
      setDragging(false);
      const latest = latestRectRef.current;
      if (latest) writeRect(latest);
    },
  });

  const resizeDrag = usePointerDrag({
    onStart: () => {
      setDragging(true);
      dragStartRectRef.current = latestRectRef.current;
    },
    onMove: ({ dx, dy }) => {
      const start = dragStartRectRef.current;
      if (!start) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const startRight = start.x + start.w;
      // Clamp size for the current viewport, then anchor the right edge so
      // clamping at min/max width never moves the right side.
      const sized = clampRect(
        { x: start.x, y: start.y, w: start.w - dx, h: start.h + dy },
        vw,
        vh,
      );
      const w = sized.w;
      // Anchor the TOP edge: cap height to space below start.y so applyRect's
      // internal clampRect cannot shift y upward. Only the bottom edge moves.
      const h = Math.min(sized.h, vh - start.y);
      applyRect({ x: startRight - w, y: start.y, w, h });
    },
    onEnd: () => {
      setDragging(false);
      const latest = latestRectRef.current;
      if (latest) writeRect(latest);
    },
  });

  const className =
    "commentarium-view" +
    (shown ? " open" : "") +
    (dragging ? " dragging" : "") +
    (!restored ? " restoring" : "");

  const style = rect
    ? {
        width: rect.w,
        height: rect.h,
        transform: rectToTransform(rect, shown, window.innerWidth),
      }
    : undefined;

  return (
    <div className={className} style={style}>
      <Header
        onClick={() => setShown(false)}
        onDragPointerDown={headerDrag.onPointerDown}
      />
      {iframeRendered && <IFrame url={url} />}
      <div className="commentarium-resize-handle" {...resizeDrag} />
    </div>
  );
}
