/**
 * 节点有限状态机（三态）
 * 来源：L5 实施说明书 §4.3 / 14.1 / 45.1 / 附录 B.15
 *
 * 说明：
 *  - SLEEP_DORMANT 不实现（附录 B.15：进入条件需 900s 无交互，独立项目无交互系统）
 *  - ACTIVE_ENGAGE 呼吸周期取 45.1 的 3.2s（v1 误填 4.0s 已更正）
 *  - 「过渡时长」语义 = 进入该目标状态所需耗时（60.2 / 附录 B.11）
 */
export const NodeState = {
  STABLE_IDLE: 'STABLE_IDLE',
  ACTIVE_ENGAGE: 'ACTIVE_ENGAGE',
  OVERDRIVE: 'OVERDRIVE'
};

export const STATE_TABLE = {
  STABLE_IDLE: {
    id: 'STABLE_IDLE',
    label: '稳定基准态',
    code: '01',
    mainParam: 0.0,
    colorTempK: 6500,
    breathPeriod: 4.0,
    enterDurationMs: 1200,
    bezier: [0.7, 0, 0.84, 0],
    hotkey: 'Digit1'
  },
  ACTIVE_ENGAGE: {
    id: 'ACTIVE_ENGAGE',
    label: '激活巡检态',
    code: '02',
    mainParam: 0.5,
    colorTempK: 8000,
    breathPeriod: 3.2,
    enterDurationMs: 600,
    bezier: [0.16, 1, 0.3, 1],
    hotkey: 'Digit2'
  },
  OVERDRIVE: {
    id: 'OVERDRIVE',
    label: '超临界释能态',
    code: '03',
    mainParam: 1.0,
    colorTempK: 3200,
    breathPeriod: 1.6,
    enterDurationMs: 900,
    bezier: [0.25, 1, 0.5, 1],
    hotkey: 'Digit3'
  }
};

export class StateSource {
  constructor(mainParamSource, initial = NodeState.STABLE_IDLE) {
    this.source = mainParamSource;
    this.current = initial;
    this.history = [];
  }

  enter(stateId) {
    const s = STATE_TABLE[stateId];
    if (!s || s.id === this.current) return;
    this.current = s.id;
    // 60.2：插值器以「目标状态」的时长与曲线收敛
    this.source.setTarget(s.mainParam, s.enterDurationMs, s.bezier);
  }

  get spec() { return STATE_TABLE[this.current]; }
}
