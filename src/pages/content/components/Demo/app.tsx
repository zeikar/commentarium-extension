import { useState, useEffect } from "react";
import IFrame from "../iframe";
import Header from "./header";

export default function App() {
  const [shown, setShown] = useState(false);
  const [url, setUrl] = useState("");

  function updatePage(url) {
    setShown((prevShown) => !prevShown);
    setUrl(url);
  }

  function messageListener(msg, sender) {
    console.log("content view message received", msg, sender);
    if (msg.type === "toggle") {
      updatePage(msg.url);
    } else if (msg.type === "urlChange") {
      setUrl(msg.url);
    }
  }

  useEffect(() => {
    console.log("content view loaded");

    // Register the event listener
    chrome.runtime.onMessage.addListener(messageListener);

    // Cleanup function to remove the event listener when the component unmounts
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  return (
    <div className={`commentarium-view ${shown ? "open" : ""}`}>
      <Header onClick={() => setShown(false)} />
      <IFrame url={url} />
    </div>
  );
}
