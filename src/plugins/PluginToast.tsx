import { createPortal } from "react-dom";
import "./plugin-toast.css";

export function PluginToast({ message }: { message: string }) {
  return createPortal(
    <div className="plugin-toast" role="status">
      {message}
    </div>,
    document.body,
  );
}
