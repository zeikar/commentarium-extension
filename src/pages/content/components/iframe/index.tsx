import { useState, useEffect } from "react";
import Loading from "./loading";

interface IFrameProps {
  url: string;
}

const IFrame: React.FC<IFrameProps> = ({ url }) => {
  const [loading, setLoading] = useState(true);

  function onLoad() {
    setLoading(false);
  }

  // This code will run whenever the `url` prop changes
  useEffect(() => {
    setLoading(true);
  }, [url]);

  // first render
  if (url === "") {
    return <div className="commentarium-iframe-container">No URL</div>;
  }
  return (
    <>
      {loading ? Loading() : null}
      <iframe
        className={"commentarium-iframe-container" + (loading ? " hidden" : "")}
        key={url}
        src={"https://commentarium.app/comments?url=" + encodeURIComponent(url)}
        onLoad={onLoad}
      ></iframe>
    </>
  );
};

export default IFrame;
