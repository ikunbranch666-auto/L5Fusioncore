/**
 * MasterClock —— 单一真实时间源
 * 来源：L5 实施说明书 §7.1 / 附录 B.14（48.2 / 48.3 / 17.2）
 *
 * 硬约束：
 *  - MAX_DELTA = 0.0333s（2.5.1 的 32ms 已按 48.2 裁定不采用）
 *  - K_TIMESCALE = 8.0，平滑插值一律用 1 - e^(-k·Δt)，禁止固定系数帧率耦合形式
 *  - 暂停时冻结积分并返回 0.0；禁止 timeScale < 0（时间倒流）
 */
export const MAX_DELTA = 0.0333;
export const K_TIMESCALE = 8.0;

export class MasterClock {
  constructor() {
    this.realTime = 0;          // 系统绝对时间 (秒)
    this.simTime = 0;           // 积分仿真时间 (秒)
    this.deltaTime = 0;         // 钳制后的单帧增量
    this.targetTimeScale = 1.0;
    this.currentTimeScale = 1.0;
    this.isPaused = false;
    this._initialized = false;
  }

  setPaused(paused) {
    this.isPaused = !!paused;
  }

  setTimeScale(scale) {
    this.targetTimeScale = Math.max(0, scale); // 48.3 禁止 < 0
  }

  /** @param {number} systemTimestampSec RAF 时间戳（秒） */
  update(systemTimestampSec) {
    if (!this._initialized) {
      this.realTime = systemTimestampSec;
      this._initialized = true;
      return 0.0;
    }
    const rawDelta = systemTimestampSec - this.realTime;
    this.realTime = systemTimestampSec;

    if (this.isPaused) return 0.0;

    const clampedDelta = Math.min(Math.max(rawDelta, 0.0), MAX_DELTA);
    const decayFactor = 1.0 - Math.exp(-K_TIMESCALE * clampedDelta);
    this.currentTimeScale += (this.targetTimeScale - this.currentTimeScale) * decayFactor;

    const effectiveDelta = clampedDelta * this.currentTimeScale;
    this.simTime += effectiveDelta;
    this.deltaTime = effectiveDelta;
    return effectiveDelta;
  }
}
