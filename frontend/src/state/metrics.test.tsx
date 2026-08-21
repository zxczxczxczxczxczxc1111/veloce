// Панель наблюдения врёт двумя способами: показывает ноль вместо «не знаем» и
// рисует линию, которой не было. Оба здесь и проверяются. Числа сами по себе
// неинтересны, интересно, ПОЯВИЛАСЬ ли точка на графике.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { data: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(name: string, data: unknown) {
  act(() => {
    for (const h of handlers.get(name) ?? []) h({ data });
  });
}

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, h: Handler) => {
      const set = handlers.get(name) ?? new Set<Handler>();
      handlers.set(name, set);
      set.add(h);
      return () => set.delete(h);
    },
  },
}));

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  DiagService: { Log: () => Promise.resolve() },
}));

const { useMetrics, percent } = await import("./metrics");

type TickOverrides = Partial<{
  serverId: string;
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  rxPerSec: number;
  txPerSec: number;
  uptimeSec: number;
  valid: boolean;
  missing: string[] | null;
}>;

function tick(o: TickOverrides = {}) {
  return {
    serverId: "s1",
    cpuPercent: 10,
    memUsed: 512,
    memTotal: 1024,
    disks: null,
    rxPerSec: 100,
    txPerSec: 200,
    uptimeSec: 3600,
    valid: true,
    missing: null,
    ...o,
  };
}

function draw(id: string | null = "s1") {
  return renderHook(({ s }: { s: string | null }) => useMetrics(s), { initialProps: { s: id } });
}

beforeEach(() => handlers.clear());

describe("percent", () => {
  it("считает долю", () => {
    expect(percent(512, 1024)).toBe(50);
    expect(percent(1024, 1024)).toBe(100);
  });

  it("не делит на ноль и не выдаёт бесконечность на экран", () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(5, -1)).toBe(0);
  });
});

describe("история метрик", () => {
  it("до первого такта истории нет, и это видно по lastAt", () => {
    const h = draw();
    expect(h.result.current.last).toBeNull();
    expect(h.result.current.lastAt).toBe(0);
    expect(h.result.current.cpu).toEqual([]);
    h.unmount();
  });

  it("первый такт с valid=false игнорируется целиком", () => {
    // Дельту не с чем считать, и любое число здесь было бы враньём.
    const h = draw();
    emit("metrics:tick", tick({ valid: false, cpuPercent: 99 }));
    expect(h.result.current.last).toBeNull();
    expect(h.result.current.cpu).toEqual([]);
    h.unmount();
  });

  it("годный такт кладёт по точке в каждый ряд", () => {
    const h = draw();
    emit("metrics:tick", tick({ cpuPercent: 42 }));
    expect(h.result.current.cpu).toEqual([42]);
    expect(h.result.current.memPercent).toEqual([50]);
    expect(h.result.current.rx).toEqual([100]);
    expect(h.result.current.tx).toEqual([200]);
    expect(h.result.current.last?.cpuPercent).toBe(42);
    expect(h.result.current.lastAt).toBeGreaterThan(0);
    h.unmount();
  });

  it("непрочитанная метрика НЕ дорисовывает точку", () => {
    // Ноль значит «нагрузки нет», а у нас «не смогли прочитать»: это
    // противоположные утверждения, и линия провалилась бы в пол.
    const h = draw();
    emit("metrics:tick", tick({ cpuPercent: 40 }));
    emit("metrics:tick", tick({ cpuPercent: 0, missing: ["cpu"] }));

    expect(h.result.current.cpu).toEqual([40]);
    // Остальные ряды при этом продолжают жить.
    expect(h.result.current.memPercent).toHaveLength(2);
    h.unmount();
  });

  it("сеть выпадает обоими рядами сразу", () => {
    const h = draw();
    emit("metrics:tick", tick());
    emit("metrics:tick", tick({ missing: ["net"] }));
    expect(h.result.current.rx).toHaveLength(1);
    expect(h.result.current.tx).toHaveLength(1);
    expect(h.result.current.cpu).toHaveLength(2);
    h.unmount();
  });

  it("последний такт обновляется даже когда точки не легли", () => {
    const h = draw();
    emit("metrics:tick", tick({ uptimeSec: 10 }));
    emit("metrics:tick", tick({ uptimeSec: 20, missing: ["cpu", "memory", "net"] }));
    expect(h.result.current.last?.uptimeSec).toBe(20);
    h.unmount();
  });

  it("окно держится на 150 точках, а не растёт сутками", () => {
    const h = draw();
    for (let i = 0; i < 155; i += 1) {
      emit("metrics:tick", tick({ cpuPercent: i }));
    }
    expect(h.result.current.cpu).toHaveLength(150);
    // Уезжает СТАРОЕ, а не новое.
    expect(h.result.current.cpu[0]).toBe(5);
    expect(h.result.current.cpu[149]).toBe(154);
    h.unmount();
  });

  it("чужой сервер не подмешивается в график", () => {
    const h = draw();
    emit("metrics:tick", tick({ serverId: "ДРУГОЙ", cpuPercent: 99 }));
    expect(h.result.current.cpu).toEqual([]);
    h.unmount();
  });

  it("смена сервера обнуляет историю", () => {
    // Дорисовывать чужие точки к новому серверу значит рисовать график,
    // которого никогда не было.
    const h = draw("s1");
    emit("metrics:tick", tick({ cpuPercent: 40 }));
    expect(h.result.current.cpu).toEqual([40]);

    h.rerender({ s: "s2" });
    expect(h.result.current.cpu).toEqual([]);
    expect(h.result.current.last).toBeNull();
    h.unmount();
  });

  it("простаивающий сервер честно даёт ноль, и это не «не знаем»", () => {
    const h = draw();
    emit("metrics:tick", tick({ cpuPercent: 0, missing: [] }));
    expect(h.result.current.cpu).toEqual([0]);
    h.unmount();
  });
});
