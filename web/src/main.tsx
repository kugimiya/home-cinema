import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { UiStoreProvider } from "./state/uiStore";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <UiStoreProvider>
        <App />
      </UiStoreProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
