import React from "react";
import ReactDOM from "react-dom/client";

import DiffApp from "./DiffApp.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiffApp />
  </React.StrictMode>,
);
