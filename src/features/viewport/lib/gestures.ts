import type { Projection } from "../../../shared/types";
import { clamp, wrap } from "../../../shared/math";
import { interruptMotion, motionEpoch } from "../../../shared/motion";
import {
  rayFromScreen,
  solveOrientation,
  worldFromScreen,
  type Vec3,
} from "./sphere";

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;

export function wheelZoom(zoom: number, delta: number) {
  return clamp(
    zoom * Math.exp(-clamp(delta, -150, 150) * 0.002),
    ZOOM_MIN,
    ZOOM_MAX,
  );
}

interface Point {
  x: number;
  y: number;
}

export interface GestureTarget {
  projection: Projection; // 响应式取景参数，就地修改
  rect: () => DOMRect | null; // 画布在视口中的实际位置与尺寸
}

const PITCH_LIMIT = 85;
const INERTIA_MIN_SPEED = 8; // °/s，低于该速度不触发惯性
const INERTIA_STOP_SPEED = 3; // °/s，惯性衰减到该速度即停止
const INERTIA_MAX_SPEED = 900; // °/s，初始冲量上限
const INERTIA_DECAY = 0.22; // s，指数衰减时间常数
const SAMPLE_WINDOW = 100; // ms，释放时用于估算速度的历史窗口

// 取景手势：单指（或鼠标）按住某处后该景物随指针移动；双指同时旋转与缩放；
// 松开带减速惯性。
//
// 关键约定：
// - 每次指针集合变化（按下/抬起/增减手指）都以“当前实际取景 + 当前指针位置”
//   重新取基准（reseat），因此多指数量改变不会跳视角；
// - 拖动全程以按下时抓取的球面世界方向为锚，每次移动用当前指针位置闭式求解，
//   不累计屏幕角度，跨经线、极点附近、画布被 CSS 缩放都不会漂移；
// - 指针被系统中断（pointercancel / 丢失捕获 / 窗口失焦 / 页面隐藏）时结束同一手势；
// - 惯性是异步运动，任何显式输入（含滑块、快捷缩放、导出）都会通过
//   shared/motion 的纪元号将其打断，最新输入优先。
export function createGestures(target: GestureTarget) {
  const projection = target.projection;
  const pointers = new Map<number, Point>();
  let anchor: Vec3 | null = null; // 被抓取景物（或双指质心）的世界方向
  let frozen: "none" | "yaw" | "pitch" = "none"; // 上一帧求解的奇异冻结状态
  let pinch: { zoom: number; roll: number; dist: number; angle: number } | null =
    null;
  let samples: { t: number; yaw: number; pitch: number }[] = [];
  let inertiaFrame = 0;

  function geometry() {
    const rect = target.rect();
    if (!rect) return null;
    const half = Math.min(rect.width, rect.height) / 2;
    if (!(half > 0)) return null;
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      half,
    };
  }

  const ordered = () => [...pointers.values()];
  const centroidOf = (pts: Point[]): Point => ({
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
  });

  function sample(yaw: number) {
    samples.push({ t: performance.now(), yaw, pitch: projection.pitch });
    if (samples.length > 12) samples.shift();
  }

  // 以当前指针位置与当前取景求解并应用 (yaw, pitch)；
  // 进出奇异区域时用求解后的实际取景重新锚定，吸收冻结期间的残差，避免跳变。
  function solveAndApply(p: Point, g: { cx: number; cy: number; half: number }) {
    const dx = p.x - g.cx;
    const dy = p.y - g.cy;
    const res = solveOrientation(
      rayFromScreen(dx, dy, g.half, projection),
      anchor!,
      projection,
    );
    projection.yaw = wrap(res.yaw, 360);
    projection.pitch = res.pitch;
    if (res.frozen !== frozen) {
      anchor = worldFromScreen(dx, dy, g.half, projection);
      frozen = res.frozen;
    }
    sample(res.yaw);
  }

  // 指针集合变化后重新取基准：记录当前取景与当前指针几何，视角保持不变。
  function reseat() {
    const g = geometry();
    const pts = ordered();
    samples = [];
    pinch = null;
    anchor = null;
    frozen = "none";
    if (!g || pts.length === 0) return;
    const at = pts.length === 1 ? pts[0] : centroidOf(pts);
    const dx = at.x - g.cx;
    const dy = at.y - g.cy;
    anchor = worldFromScreen(dx, dy, g.half, projection);
    frozen = solveOrientation(
      rayFromScreen(dx, dy, g.half, projection),
      anchor,
      projection,
    ).frozen;
    if (pts.length >= 2) {
      const [a, b] = pts;
      pinch = {
        zoom: projection.zoom,
        roll: projection.roll,
        dist: Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
  }

  function apply() {
    const g = geometry();
    if (!g || !anchor) return;
    const pts = ordered();
    if (pts.length === 1) {
      solveAndApply(pts[0], g);
    } else if (pts.length >= 2 && pinch) {
      const [a, b] = pts;
      const dist = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      // 双指：缩放取指距比、画面旋转取指向角差，均以双指开始时的取景为基准
      projection.zoom = clamp(
        (pinch.zoom * dist) / pinch.dist,
        ZOOM_MIN,
        ZOOM_MAX,
      );
      projection.roll = wrap(
        pinch.roll - ((angle - pinch.angle) * 180) / Math.PI,
        360,
      );
      solveAndApply(centroidOf(pts), g);
    }
  }

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    interruptMotion(); // 新手势接管取景，终止未结束的惯性
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture(e.pointerId);
    } catch {
      // 指针已失效等情况下捕获可能失败，手势仍可按未捕获路径工作
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    reseat();
  }

  function move(e: PointerEvent) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    apply();
  }

  function release(e: PointerEvent, inertia: boolean) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) endGesture(inertia);
    else reseat(); // 剩余手指以当前取景继续，不跳视角
  }

  const up = (e: PointerEvent) => release(e, true);
  const cancel = (e: PointerEvent) => release(e, true);

  function lostcapture(e: PointerEvent) {
    // 正常抬起时 capture 随 pointerup 自动释放，此时手势已结束，直接忽略；
    // 仅当系统在手势进行中收回捕获时才按中断处理：结束手势，不补惯性。
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) endGesture(false);
    else reseat();
  }

  // 窗口失焦 / 页面隐藏等系统中断：结束同一手势与惯性，不补滑行
  function interrupt() {
    interruptMotion();
    if (pointers.size === 0) return;
    pointers.clear();
    endGesture(false);
  }
  const onVisibility = () => {
    if (document.hidden) interrupt();
  };
  window.addEventListener("blur", interrupt);
  document.addEventListener("visibilitychange", onVisibility);

  function endGesture(withInertia: boolean) {
    anchor = null;
    pinch = null;
    frozen = "none";
    if (withInertia) startInertia();
    samples = [];
  }

  function startInertia() {
    const now = performance.now();
    const recent = samples.filter((s) => now - s.t <= SAMPLE_WINDOW);
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.02) return;
    let vYaw = (last.yaw - first.yaw) / dt;
    let vPitch = (last.pitch - first.pitch) / dt;
    const speed = Math.hypot(vYaw, vPitch);
    if (speed < INERTIA_MIN_SPEED) return;
    if (speed > INERTIA_MAX_SPEED) {
      vYaw *= INERTIA_MAX_SPEED / speed;
      vPitch *= INERTIA_MAX_SPEED / speed;
    }
    const epoch = motionEpoch();
    let yaw = projection.yaw;
    let pitch = projection.pitch;
    let prev = performance.now();
    const tick = (t: number) => {
      if (epoch !== motionEpoch()) return; // 已有更新的显式输入接管取景
      const dt = Math.min((t - prev) / 1000, 0.05);
      prev = t;
      const k = Math.exp(-dt / INERTIA_DECAY);
      vYaw *= k;
      vPitch *= k;
      yaw = wrap(yaw + vYaw * dt, 360);
      const nextPitch = clamp(pitch + vPitch * dt, -PITCH_LIMIT, PITCH_LIMIT);
      if (nextPitch === PITCH_LIMIT || nextPitch === -PITCH_LIMIT) vPitch = 0;
      pitch = nextPitch;
      projection.yaw = yaw;
      projection.pitch = pitch;
      if (Math.hypot(vYaw, vPitch) < INERTIA_STOP_SPEED) return;
      inertiaFrame = requestAnimationFrame(tick);
    };
    inertiaFrame = requestAnimationFrame(tick);
  }

  function destroy() {
    cancelAnimationFrame(inertiaFrame);
    window.removeEventListener("blur", interrupt);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return { down, move, up, cancel, lostcapture, destroy };
}
