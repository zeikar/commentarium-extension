import { useState, useEffect } from "react";

export default function App() {
  const [shown, setShown] = useState(false);

  function toggle() {
    console.log("toggle");
    setShown((prevShown) => !prevShown);
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

  function messageListener(msg, sender) {
    console.log("content view message received", msg, sender);
    if (msg.type === "toggle") {
      toggle();
    }
  }

  return (
    <div className={`commentarium-view ${shown ? "open" : ""}`}>
      {/* <iframe
        src="https://commentarium.vercel.app/api/comments"
      ></iframe> */}
    </div>
  );
}
