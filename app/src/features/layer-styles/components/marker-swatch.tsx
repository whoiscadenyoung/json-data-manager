import { cn } from "@caden/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

import { iconImage, type IconImage, type UploadedIcon } from "../lib/icon-images";
import { SDF_EDGE } from "../lib/sdf";

/** SDF alpha either side of the edge that fades from transparent to solid (anti-aliasing). */
const EDGE_SOFTNESS = 24;

/** An SDF image as a flat coverage mask (alpha only), the way MapLibre would fill it. */
function sdfMask(image: IconImage): Uint8ClampedArray<ArrayBuffer> {
  const mask = new Uint8ClampedArray(image.data.length);
  for (let index = 3; index < image.data.length; index += 4) {
    const t = (image.data[index] - (SDF_EDGE - EDGE_SOFTNESS)) / (2 * EDGE_SOFTNESS);
    mask[index] = Math.round(Math.min(1, Math.max(0, t)) * 255);
  }
  return mask;
}

function draw(canvas: HTMLCanvasElement, image: IconImage, color: string) {
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  context.putImageData(
    new ImageData(image.sdf ? sdfMask(image) : new Uint8ClampedArray(image.data), image.width),
    0,
    0,
  );
  if (image.sdf) {
    // Tint the mask: keep its alpha, take the class color.
    context.globalCompositeOperation = "source-in";
    context.fillStyle = color;
    context.fillRect(0, 0, image.width, image.height);
  }
}

/**
 * A point marker drawn the way the map draws it: the icon's SDF filled with
 * the class color (full-color uploads as they are). Used by the legend, the
 * Marker picker, and per-category rows. Falls back to a plain dot while the
 * sprite loads or when the icon is gone.
 */
export function MarkerSwatch({
  icon,
  color,
  uploads,
  size = 14,
  className,
}: {
  icon: string;
  color: string;
  uploads: ReadonlyMap<string, UploadedIcon>;
  /** Rendered size in CSS pixels. */
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    upload = uploads.get(icon),
    uploadKey = upload === undefined ? "" : (upload.url ?? ""),
    [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const source =
      upload === undefined ? new Map<string, UploadedIcon>() : new Map([[icon, upload]]);
    iconImage(icon, source)
      .then((image) => {
        if (cancelled) {
          return;
        }
        if (image === undefined || canvasRef.current === null) {
          setMissing(image === undefined);
          return;
        }
        setMissing(false);
        draw(canvasRef.current, image, color);
      })
      .catch(() => {
        if (!cancelled) {
          setMissing(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // `upload` is keyed by its URL; a fresh Map identity alone doesn't need a redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icon, color, uploadKey]);

  if (missing) {
    return (
      <span
        aria-hidden
        className={cn("inline-block shrink-0 rounded-full", className)}
        style={{ backgroundColor: color, height: size * 0.7, width: size * 0.7 }}
      />
    );
  }
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("inline-block shrink-0", className)}
      style={{ height: size, width: size }}
    />
  );
}
