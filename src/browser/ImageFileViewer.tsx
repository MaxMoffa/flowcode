import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { basename } from "../lib/path";
import { PathIcons } from "../lib/fileLinks";
import { MenuIcons } from "../context-menu/menuIcons";
import { readEnum, writeString } from "../lib/storage";
import { copyImage, formatBytes } from "../imageView/imageActions";
import { ImageButton, ImageSeparator, ZoomControls, ZoomStage, useZoomPan } from "../imageView/ZoomStage";
import { useBrowserSettings } from "./browserSettings";
import "./image-file-viewer.css";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };
type Background = "dark" | "light" | "checker";
const BACKGROUNDS: readonly Background[] = ["dark", "light", "checker"];
const BACKGROUND_KEY = "flowcode.imageViewer.bg";

/** Local image bytes stay in the native viewer rather than an artifact iframe. */
export default function ImageFileViewer({ path, reloadNonce, onLoading }: { path: string; reloadNonce: number; onLoading: (loading: boolean) => void }) {
  const { t } = useI18n();
  const { autoReloadArtifacts } = useBrowserSettings();
  const [source, setSource] = useState<{ src: string; bytes: number; path: string } | null>(null);
  const [error, setError] = useState(false);
  const [dims, setDims] = useState<{ src: string; width: number; height: number } | null>(null);
  const [background, setBackground] = useState(() => readEnum(BACKGROUND_KEY, BACKGROUNDS, "checker"));
  const src = source?.path === path ? source.src : null;
  const zoom = useZoomPan(src);
  const loadingCallback = useRef(onLoading);
  loadingCallback.current = onLoading;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  useEffect(() => {
    let stale = false;
    let objectUrl: string | null = null;
    setSource(null);
    setError(false);
    setDims(null);
    loadingCallback.current(true);
    void invoke<ArrayBuffer>("preview_image_bytes", { path }).then((bytes) => {
      if (stale) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: MIME[extension] }));
      setSource({ src: objectUrl, bytes: bytes.byteLength, path });
    }, () => {
      if (stale) return;
      setError(true);
      loadingCallback.current(false);
    });
    return () => {
      stale = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      loadingCallback.current(false);
    };
  }, [path, extension, reloadNonce]);
  const dimensions = dims?.src === src ? dims : null;
  return <div className="image-file-viewer">
    <div className="image-file-info">
      {dimensions && <span className="image-file-chip">{dimensions.width}×{dimensions.height}</span>}
      {source?.path === path && <span className="image-file-chip">{formatBytes(source.bytes)}</span>}
      <span className="image-file-chip">{extension.toUpperCase()}</span>
      {autoReloadArtifacts && <span className="image-file-reload" title={t("image.autoReload")}>⟳ {t("image.autoReload")}</span>}
    </div>
    <ZoomStage zoom={zoom} src={error ? null : src} alt={basename(path)} className={`image-file-stage image-bg-${background}`}
      onDims={(width, height) => { if (src) setDims({ src, width, height }); loadingCallback.current(false); }}
      onError={() => { setError(true); loadingCallback.current(false); }}>
      {error && <div className="image-file-error" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m4 18 5-5 4 4 3-3 4 4" /></svg><span>{t("image.missing")}</span></div>}
      <div className="image-file-tools">
        <ZoomControls zoom={zoom} />
        <ImageSeparator />
        {BACKGROUNDS.map((value) => <ImageButton key={value} title={t(value === "dark" ? "image.bgDark" : value === "light" ? "image.bgLight" : "image.bgChecker")} active={background === value} onClick={() => { setBackground(value); writeString(BACKGROUND_KEY, value); }}><span className={`image-file-swatch image-bg-${value}`} /></ImageButton>)}
        <ImageSeparator />
        <ImageButton title={t("chat.image.copy")} disabled={!src || error} onClick={() => { if (src) void copyImage(src).catch(() => {}); }}>{PathIcons.copy}</ImageButton>
        <ImageButton title={t("chat.image.open")} onClick={() => void invoke("open_with_default_app", { path }).catch(() => {})}>{MenuIcons.openExternal}</ImageButton>
        <ImageButton title={t("chat.image.reveal")} onClick={() => void revealItemInDir(path).catch(() => {})}>{PathIcons.folder}</ImageButton>
      </div>
    </ZoomStage>
  </div>;
}
