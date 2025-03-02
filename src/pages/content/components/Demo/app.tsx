import { useState, useEffect, useCallback, useRef } from "react";
import IFrame from "../iframe";
import Header from "./header";

export default function App() {
  const [iframeRendered, setIframeRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const [url, setUrl] = useState("");

  // Track current state with ref to prevent unnecessary function recreations
  const shownRef = useRef(shown);

  // Update ref whenever shown state changes
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

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
    console.log("content view message received", msg, sender);
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
    console.log("content view loaded");

    // Register the event listener only once
    chrome.runtime.onMessage.addListener(messageListener);

    // Cleanup function
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []); // Empty dependency array - only runs on mount/unmount

  return (
    <div className={`commentarium-view ${shown ? "open" : ""}`}>
      <Header onClick={() => setShown(false)} />
      {iframeRendered && <IFrame url={url} />}
    </div>
  );
}
