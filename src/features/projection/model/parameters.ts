import type { Projection } from "../../../shared/types";
import { clamp, wrap } from "../../../shared/math";
import { interruptMotion } from "../../../shared/motion";
import { defaultProjection } from "../../../shared/defaults";
export function updateProjection(
  p: Projection,
  key: keyof Projection,
  value: number | string,
) {
  // 滑块、模式切换等显式输入优先于进行中的惯性滑行
  interruptMotion();
  if (key === "mode") {
    p.mode = value === "tunnel" ? "tunnel" : "planet";
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  if (key === "zoom") p.zoom = clamp(n, 0.3, 3);
  if (key === "yaw" || key === "roll") p[key] = wrap(n, 360);
  if (key === "pitch") p.pitch = clamp(n, -85, 85);
}
export function resetProjection(p: Projection) {
  interruptMotion();
  Object.assign(p, defaultProjection());
}
