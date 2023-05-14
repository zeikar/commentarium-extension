import { useState, useEffect } from "react";

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
    return <div className="iframe-container">No URL</div>;
  }
  return (
    <>
      {loading ? <div className="iframe-loading">Loading...</div> : null}
      <iframe
        className={"iframe-container" + (loading ? " hidden" : "")}
        src={"http://localhost:3000/comments?url=" + url}
        onLoad={onLoad}
      ></iframe>
    </>
  );
};

export default IFrame;
