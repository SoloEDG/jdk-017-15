import type { Projection } from "../../../shared/types";
import { clamp, radians, wrap } from "../../../shared/math";

export type Vec3 = [number, number, number];

const PITCH_LIMIT = 85;
const degrees = (r: number) => (r * 180) / Math.PI;
// 把角度差折返到 (-180, 180]，用于跨经线时取最短连续路径
const wrapDelta = (v: number) => wrap(v + 180, 360) - 180;

// 奇异区域阈值（约 1.5°）。本投影的相机模型里有两处求解退化：
// - 投影轴附近（屏幕中心）：锚点落在轴上时，偏航对锚点位置不起作用，
//   指针的亚像素抖动会被放大成偏航狂转；
// - 投影赤道奇异点（r·zoom ≈ 1 且光线与 x 轴平行）：俯仰对锚点几乎不起作用。
// 进入这些区域时冻结对应自由度、另一自由度仍精确求解（见 solveOrientation）。
const SINGULAR_SIN = Math.sin(radians(1.5));

const rotX = (v: Vec3, t: number): Vec3 => [
  v[0],
  v[1] * Math.cos(t) - v[2] * Math.sin(t),
  v[1] * Math.sin(t) + v[2] * Math.cos(t),
];
// 绕 y 轴旋转，使经度角 λ = atan2(z, x) 增加 a（与 projectPoint 的 yaw 同向）
const rotY = (v: Vec3, a: number): Vec3 => [
  v[0] * Math.cos(a) - v[2] * Math.sin(a),
  v[1],
  v[0] * Math.sin(a) + v[2] * Math.cos(a),
];

export interface ViewCamera {
  zoom: number;
  roll: number;
  mode: Projection["mode"];
}

// 屏幕偏移（相对画布中心，CSS 像素）→ 相机空间单位光线。
// 与 projection/lib/coordinates.ts 的 projectPoint 使用同一相机模型；
// 只依赖偏移量与画布半宽的比值，因此画布被响应式布局缩放时结果不变。
export function rayFromScreen(
  dx: number,
  dy: number,
  half: number,
  cam: ViewCamera,
): Vec3 {
  const a = dx / half / cam.zoom;
  const b = dy / half / cam.zoom;
  const theta = 2 * Math.atan(Math.hypot(a, b));
  const angle = Math.atan2(b, a) + radians(cam.roll);
  const s = cam.mode === "planet" ? -1 : 1;
  return [
    Math.sin(theta) * Math.cos(angle),
    s * Math.cos(theta),
    Math.sin(theta) * Math.sin(angle),
  ];
}

// 屏幕偏移 → 球面世界方向（单位向量）：光线依次施加俯仰与偏航。
export function worldFromScreen(
  dx: number,
  dy: number,
  half: number,
  p: Projection,
): Vec3 {
  return rotY(
    rotX(rayFromScreen(dx, dy, half, p), radians(p.pitch)),
    radians(p.yaw),
  );
}

export interface OrientationSolve {
  yaw: number; // 度，未折返，与 current 保持连续
  pitch: number; // 度，限制在 ±85°
  frozen: "none" | "yaw" | "pitch";
}

// 精确锚点求解：求取景 (yaw, pitch)，使被抓取的世界方向 anchor 恰好落在
// 当前指针对应的相机光线 c 上，即 Ry(yaw)·Rx(pitch)·c = anchor。
// 每次调用都由球面几何闭式解出，不做增量累计，因此不会漂移；
// 偏航分支与俯仰分支都取离当前取景最近的解，保证跨经线连续。
// 锚点不可达（俯仰超界被钳制）时，锚点沿最近可达位置滑动。
export function solveOrientation(
  c: Vec3,
  anchor: Vec3,
  current: { yaw: number; pitch: number },
): OrientationSolve {
  let frozen: OrientationSolve["frozen"] = "none";
  let pitch = current.pitch;
  const rho = Math.hypot(c[1], c[2]);
  if (rho < SINGULAR_SIN) {
    // 光线几乎与 x 轴平行（赤道奇异点）：俯仰对锚点不起作用，冻结俯仰
    frozen = "pitch";
  } else {
    // c.y·cos p − c.z·sin p = anchor.y  →  p = −δ ± acos(anchor.y / ρ)
    const delta = Math.atan2(c[2], c[1]);
    const turn = Math.acos(clamp(anchor[1] / rho, -1, 1));
    const p1 = degrees(-delta + turn);
    const p2 = degrees(-delta - turn);
    const pick =
      Math.abs(wrapDelta(p1 - current.pitch)) <=
      Math.abs(wrapDelta(p2 - current.pitch))
        ? p1
        : p2;
    // 两个分支都是模 360° 的解：先归一到当前俯仰附近的等价角，再钳制
    pitch = clamp(
      current.pitch + wrapDelta(pick - current.pitch),
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
  }
  const d = rotX(c, radians(pitch));
  let yaw = current.yaw;
  if (Math.hypot(d[0], d[2]) < SINGULAR_SIN) {
    // 锚点落在投影轴上（屏幕中心）：偏航无法由指针稳定决定，冻结偏航
    if (frozen === "none") frozen = "yaw";
  } else {
    const target = degrees(
      Math.atan2(anchor[2], anchor[0]) - Math.atan2(d[2], d[0]),
    );
    yaw = current.yaw + wrapDelta(target - current.yaw);
  }
  return { yaw, pitch, frozen };
}
