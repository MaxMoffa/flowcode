import { resolveContentText } from "@flowkit-io/core";
import { registerStepComponent, type StepComponentProps } from "@flowkit-io/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n";
import "./mobile-app.css";
import type { MobileAppStep } from "./mobileAppStepType";

const RELEASES_URL = "https://github.com/MaxMoffa/flowcode/releases/latest";

/** Same slot flowkit's own steps use for the title icon (`.fk-title-icon`). */
function TitleIcon({ image }: { image: MobileAppStep["image"] }) {
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

/** Info step with a download button. The click is an explicit action, so the
 * link opens straight in the system browser (no "confirm link" prompt). */
function MobileAppStepView({ step, flow }: StepComponentProps<MobileAppStep>) {
  const { t } = useI18n();
  const title = step.title !== undefined ? resolveContentText(flow, step.title) : undefined;
  const subtitle = step.subtitle !== undefined ? resolveContentText(flow, step.subtitle) : undefined;

  return (
    <div className="fk-step fk-step-mobile-app">
      {(step.image || title) && (
        <h2 className="fk-title">
          <TitleIcon image={step.image} />
          {title}
        </h2>
      )}
      {subtitle && <p className="fk-subtitle">{subtitle}</p>}
      <button type="button" className="mobile-app-download" onClick={() => openUrl(RELEASES_URL).catch(() => {})}>
        {t("welcome.mobile.download")}
      </button>
    </div>
  );
}

registerStepComponent<MobileAppStep>("mobileApp", MobileAppStepView);
