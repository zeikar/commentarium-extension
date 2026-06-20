import { createRoot } from "react-dom/client";
import App from "@src/pages/content/components/panel/app";
import refreshOnUpdate from "virtual:reload-on-update-in-view";

refreshOnUpdate("pages/content");

const root = document.createElement("div");
root.id = "commentarium-content-view-root";
// Mount on <html>, not <body>: some SPAs (e.g. developers.openai.com) replace
// the entire <body> element on client-side navigation, which would detach a
// body-appended root and silently break the panel. documentElement survives.
document.documentElement.append(root);

createRoot(root).render(<App />);
