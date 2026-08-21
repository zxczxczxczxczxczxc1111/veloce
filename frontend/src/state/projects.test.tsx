// Снимок проекта и память о падениях. Память живёт ВНЕ экранов намеренно: во
// время падения человек смотрит на экран проекта, а обзор размонтирован и
// ничего не видит. Поэтому здесь проверяется, что она переживает уход с экрана.
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

const { useProjectTick, useIncidentRecorder, lastDownAt } = await import("./projects");

function proj(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "docker", state, ...extra } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  handlers.clear();
});

describe("снимок одного проекта", () => {
  it("до первого такта показывает то, с чем открыли экран", () => {
    // Иначе человек смотрит на пустоту, пока идёт такт.
    const initial = proj("admin", "running");
    const h = renderHook(() => useProjectTick("s1", initial));
    expect(h.result.current).toBe(initial);
    h.unmount();
  });

  it("подхватывает свежее состояние из общего такта", () => {
    // Своего опроса нет намеренно: два источника одних цифр разъедутся на
    // глазах у человека.
    const h = renderHook(() => useProjectTick("s1", proj("admin", "running")));
    emit("projects:tick", { serverId: "s1", projects: [proj("admin", "down")] });
    expect((h.result.current as { state: string }).state).toBe("down");
    h.unmount();
  });

  it("такт без нашего проекта не обнуляет снимок", () => {
    const h = renderHook(() => useProjectTick("s1", proj("admin", "running")));
    emit("projects:tick", { serverId: "s1", projects: [proj("другой", "down")] });
    expect((h.result.current as { state: string }).state).toBe("running");
    h.unmount();
  });

  it("совпадение по имени без совпадения по виду не считается", () => {
    // Одноимённые docker-контейнер и systemd-юнит на одной машине бывают.
    const h = renderHook(() => useProjectTick("s1", proj("admin", "running")));
    emit("projects:tick", {
      serverId: "s1",
      projects: [{ id: "admin", kind: "systemd", state: "down" }],
    });
    expect((h.result.current as { state: string }).state).toBe("running");
    h.unmount();
  });

  it("чужой сервер не подмешивается", () => {
    const h = renderHook(() => useProjectTick("s1", proj("admin", "running")));
    emit("projects:tick", { serverId: "ДРУГОЙ", projects: [proj("admin", "down")] });
    expect((h.result.current as { state: string }).state).toBe("running");
    h.unmount();
  });

  it("пустой список проектов не роняет обработчик", () => {
    const h = renderHook(() => useProjectTick("s1", proj("admin", "running")));
    emit("projects:tick", { serverId: "s1", projects: null });
    expect((h.result.current as { state: string }).state).toBe("running");
    h.unmount();
  });
});

describe("память о падениях", () => {
  it("до первого падения ноль, а не выдуманное время", () => {
    expect(lastDownAt("s-нетронутый", "docker", "admin")).toBe(0);
  });

  it("запоминает время падения", () => {
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "s1", projects: [proj("упал", "down")] });
    expect(lastDownAt("s1", "docker", "упал")).toBe(1_700_000_000_000);
    h.unmount();
  });

  it("след переживает уход с экрана", () => {
    // Ради этого память и вынесена из компонента.
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "s1", projects: [proj("живучий", "down")] });
    h.unmount();
    expect(lastDownAt("s1", "docker", "живучий")).toBe(1_700_000_000_000);
  });

  it("след одного сервера не виден на другом", () => {
    // Одноимённые проекты на двух машинах это норма, а не редкость.
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "s1", projects: [proj("общий", "down")] });
    h.unmount();
    expect(lastDownAt("s2", "docker", "общий")).toBe(0);
  });

  it("подъём не стирает след прошлого падения", () => {
    // «Когда последний раз падал» это история, а не текущее состояние.
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "s1", projects: [proj("качели", "down")] });
    vi.setSystemTime(1_700_000_060_000);
    emit("projects:tick", { serverId: "s1", projects: [proj("качели", "running")] });

    expect(lastDownAt("s1", "docker", "качели")).toBe(1_700_000_000_000);
    h.unmount();
  });

  it("повторное падение обновляет время", () => {
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "s1", projects: [proj("рецидив", "down")] });
    vi.setSystemTime(1_700_000_120_000);
    emit("projects:tick", { serverId: "s1", projects: [proj("рецидив", "down")] });

    expect(lastDownAt("s1", "docker", "рецидив")).toBe(1_700_000_120_000);
    h.unmount();
  });

  it("чужой сервер в след не пишется", () => {
    const h = renderHook(() => useIncidentRecorder("s1"));
    emit("projects:tick", { serverId: "ДРУГОЙ", projects: [proj("чужой-упал", "down")] });
    expect(lastDownAt("ДРУГОЙ", "docker", "чужой-упал")).toBe(0);
    h.unmount();
  });

  it("без сервера ничего не слушает", () => {
    const h = renderHook(() => useIncidentRecorder(null));
    emit("projects:tick", { serverId: "s1", projects: [proj("мимо", "down")] });
    expect(lastDownAt("s1", "docker", "мимо")).toBe(0);
    h.unmount();
  });
});
