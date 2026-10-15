import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Không tìm thấy vùng hiển thị ứng dụng.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
