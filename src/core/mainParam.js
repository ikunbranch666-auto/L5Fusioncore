/**
 * MainParamSource —— 主参数插值器
 * 来源：L5 实施说明书 §5 / §6.1 / 附录 B.12（44.4 / 22.1 / 14.2 / 60.2）
 *
 * 三级钳制中的第 1 层（输入层）与第 2 层（物理层）在此落地；
 * 第 3 层（GPU Guard）在 Prog_HDRCore 着色器内 clamp(u_main_param, 0.0, 1.0)。
 *
 * 迁移规则（14.2 / 附录 B.11）：
 *  - 严格按目标状态的过渡时长与贝塞尔曲线平滑插值，禁止瞬态阶跃
 *  - 过渡中途收到新指令，立即以「当前即时值」为起点重新规划插值曲线
 *  - 过渡时长取「目标状态」表内的时长（进入该目标状态所需耗时）
 */
import { makeCubicBezier } from './bezier.js';

export class MainParamSource {
  constructor(initial = 0.0) {
    this._value = Math.min(1.0, Math.max(0.0, initial));
    this._from = this._value;
    this._to = this._value;
    this._elapsed = 0;
    this._duration = 0;
    this._ease = makeCubicBezier(0.7, 0, 0.84, 0);
    this.transitioning = false;
    /** 越界注入测试用的审计日志 */
    this.lastClampAudit = null;
  }

  get value() { return this._value; }

  /** 输入层钳制入口（44.4 第 1 层 + 22.1 类型净化） */
  setTelemetryValue(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.lastClampAudit = { input: v, rejected: 'typeof !== number / 非有限数', output: this._value };
      return false;
    }
    const clamped = Math.min(1.0, Math.max(0.0, v));
    this.lastClampAudit = { input: v, inputLayer: clamped, output: clamped };
    this.setTarget(clamped, 600, [0.16, 1, 0.3, 1]);
    return true;
  }

  setTarget(target, durationMs, bezier) {
    const t = Math.min(1.0, Math.max(0.0, target));
    this._from = this._value;          // 14.2：以当前即时值为起点
    this._to = t;
    this._elapsed = 0;
    this._duration = Math.max(1, durationMs) / 1000;
    this._ease = makeCubicBezier(bezier[0], bezier[1], bezier[2], bezier[3]);
    this.transitioning = Math.abs(this._to - this._from) > 1e-6;
  }

  update(dt) {
    if (!this.transitioning) return this._value;
    this._elapsed += dt;
    const raw = Math.min(1.0, this._elapsed / this._duration);
    const eased = this._ease(raw);
    const next = this._from + (this._to - this._from) * eased;
    // 物理层钳制（44.4 第 2 层）
    this._value = Math.min(1.0, Math.max(0.0, next));
    if (raw >= 1.0) {
      this._value = this._to;
      this.transitioning = false;
    }
    return this._value;
  }
}
