// Типы полезной нагрузки событий. Wails генерирует модели только для того, что
// стоит в сигнатурах методов, а события идут мимо: `metrics:tick`,
// `projects:tick` и `conn:state` описаны в Go структурами, которых в биндингах
// нет вообще. Поэтому они описаны здесь руками.
//
// Имена полей обязаны совпадать с json-тегами Go (internal/service). Разъедься
// они, компилятор промолчит, а на экране появятся undefined: сверять при любой
// правке структур на той стороне.

export type ConnEvent = {
  serverId: string;
  state: string;
  fingerprint?: string;
  knownFingerprint?: string;
  message?: string;
};

export type DiskDTO = {
  mount: string;
  used: number;
  size: number;
};

export type MetricsTick = {
  serverId: string;
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  disks: DiskDTO[] | null;
  rxPerSec: number;
  txPerSec: number;
  uptimeSec: number;
  /** false у первого такта: дельту не с чем считать. */
  valid: boolean;
  /** Метрики, которые не удалось прочитать на этом такте. */
  missing: string[] | null;
};

export type LogBatch = {
  serverId: string;
  projectId: string;
  lines: string[] | null;
};

export type LogStreamEvent = {
  serverId: string;
  projectId: string;
  /** started - поток открыт, ended - поток кончился сам. */
  state: string;
};

export type ProjectsTick = {
  serverId: string;
  projects: import("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service").ProjectDTO[] | null;
};
