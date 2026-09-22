import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveContentText } from "@flowkit-io/core";
import { registerStepComponent, type StepComponentProps } from "@flowkit-io/react";
import type { DirectoryStep } from "./directoryStepType";

/** Same visual slot flowkit's own steps use for their title icon
 * (`.fk-title-icon`, see `StepImage`/`StepTitle` in `@flowkit-io/react`) -
 * kept minimal here (only the "emoji"/"image" kinds this flow actually
 * uses) rather than pulling in flowkit's internal, unexported component. */
function TitleIcon({ image }: { image: DirectoryStep["image"] }) {
  if (!image) return null;
  if (image.kind === "image") {
    return (
      <span className="fk-title-icon">
        <img src={image.value} alt="" />
      </span>
    );
  }
  return <span className="fk-title-icon">{image.value}</span>;
}

/** Folder picker matching a classic desktop installer's "destination
 * folder" step: a read-only path display plus a native "Sfoglia..." dialog
 * (`installer_pick_dir`, Rust side), instead of flowkit's built-in `text`
 * step (a bare input the user had to type a Windows path into by hand). */
function DirectoryStepView({ step, value, onChange, flow }: StepComponentProps<DirectoryStep>) {
  const [browsing, setBrowsing] = useState(false);
  const stringValue = typeof value === "string" ? value : "";
  const title = step.title !== undefined ? resolveContentText(flow, step.title) : undefined;
  const subtitle = step.subtitle !== undefined ? resolveContentText(flow, step.subtitle) : undefined;
  const placeholder = step.placeholder;

  async function browse() {
    setBrowsing(true);
    try {
      const picked = await invoke<string | null>("installer_pick_dir", {
        defaultDir: stringValue || placeholder || "",
      });
      if (picked) onChange(picked);
    } catch {
      // Dialog plugin unavailable (e.g. running outside the installer
      // binary) - the text field below still lets the user type a path.
    } finally {
      setBrowsing(false);
    }
  }

  return (
    <div className="fk-step fk-step-directory">
      {(step.image || title) && (
        <h2 className="fk-title">
          <TitleIcon image={step.image} />
          {title}
        </h2>
      )}
      {subtitle && <p className="fk-subtitle">{subtitle}</p>}
      <div className="installer-dir-row">
        <input
          className="fk-input installer-dir-input"
          type="text"
          value={stringValue}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        <button type="button" className="fk-btn-secondary installer-dir-browse" onClick={browse} disabled={browsing}>
          Sfoglia...
        </button>
      </div>
    </div>
  );
}

registerStepComponent<DirectoryStep>("directory", DirectoryStepView);
