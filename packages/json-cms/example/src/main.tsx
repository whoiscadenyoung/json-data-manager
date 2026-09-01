import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.jsx";

// oxlint-disable-next-line import/no-unassigned-import
import "./index.css";

const address = import.meta.env.VITE_CONVEX_URL,
  convex = new ConvexReactClient(address);

// oxlint-disable-next-line typescript/no-non-null-assertion
createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
