import '@fontsource/inter/latin-400.css';
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Demo from "./DemoV2";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>
);
