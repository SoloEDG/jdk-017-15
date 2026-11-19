// 取景运动的互斥协调。
// 惯性滑行是异步的（rAF 逐帧推进），而拖动、滑块、快捷缩放、滚轮、导出等
// 都是显式输入。约定：任何显式输入到来时把纪元号加一，惯性循环每帧核对
// 纪元号，发现变化立刻停止——保证“最新明确输入优先”，且导出时能冻结住
// 用户触发瞬间的实际取景，不带入尚未结束的异步运动。
let epoch = 0;

export function motionEpoch(): number {
  return epoch;
}

export function interruptMotion(): void {
  epoch += 1;
}
