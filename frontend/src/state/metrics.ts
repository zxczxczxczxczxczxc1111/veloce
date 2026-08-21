import { Events } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import type { MetricsTick } from "./events";

// Окно 5 минут при такте 2 секунды это 150 точек, больше не храним. Спарклайн
// шире экрана не станет, а память утечёт за сутки наблюдения.
const WINDOW_POINTS = 150;

export type MetricsHistory = {
  /** Последний такт целиком. null - тактов ещё не было. */
  last: MetricsTick | null;
  /** Когда пришёл последний такт, мс. 0 - тактов не было. */
  lastAt: number;
  cpu: number[];
  memPercent: number[];
  rx: number[];
  tx: number[];
};

const empty: MetricsHistory = {
  last: null,
  lastAt: 0,
  cpu: [],
  memPercent: [],
  rx: [],
  tx: [],
};

function push(series: number[], v: number): number[] {
  const next = series.length >= WINDOW_POINTS ? series.slice(1) : series.slice();
  next.push(v);
  return next;
}

export function useMetrics(serverId: string | null): MetricsHistory {
  const [history, setHistory] = useState<MetricsHistory>(empty);

  useEffect(() => {
    if (serverId === null) return;
    // Смена сервера обнуляет историю: дорисовывать чужие точки к новому
    // серверу значит рисовать график, которого никогда не было.
    setHistory(empty);

    const off = Events.On("metrics:tick", (e: { data: MetricsTick }) => {
      const t = e.data;
      if (t.serverId !== serverId) return;
      // Такт с valid=false игнорируется целиком. Это первый замер, дельту не с
      // чем считать, и любое число здесь было бы враньём.
      if (!t.valid) return;

      setHistory((prev) => {
        const missing = t.missing ?? [];
        return {
          last: t,
          lastAt: Date.now(),
          // Не прочитанная метрика не дорисовывает точку. Ноль тут значит
          // «нагрузки нет», а у нас «не смогли прочитать»: это
          // противоположные утверждения, и линия провалилась бы в пол.
          cpu: missing.includes("cpu") ? prev.cpu : push(prev.cpu, t.cpuPercent),
          memPercent: missing.includes("memory")
            ? prev.memPercent
            : push(prev.memPercent, percent(t.memUsed, t.memTotal)),
          rx: missing.includes("net") ? prev.rx : push(prev.rx, t.rxPerSec),
          tx: missing.includes("net") ? prev.tx : push(prev.tx, t.txPerSec),
        };
      });
    });
    return () => {
      off();
    };
  }, [serverId]);

  return history;
}

export function percent(used: number, total: number): number {
  if (total <= 0) return 0;
  return (used / total) * 100;
}
