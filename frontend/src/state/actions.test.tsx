// Перезапуск это единственное место, где панель что-то МЕНЯЕТ на сервере.
// Соврать тут дороже всего: «перезапустил» поверх непонявшегося проекта или
// вечное «идёт перезапуск» одинаково заставляют человека лезть в консоль.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const actionMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const logStartMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const bufferedMock = vi.fn<() => Promise<string[] | null>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ProjectsService: { Action: (...a: unknown[]) => actionMock(...a) },
  LogsService: {
    Start: (...a: unknown[]) => logStartMock(...a),
    Buffered: () => bufferedMock(),
    Stop: () => Promise.resolve(),
  },
  DiagService: { Log: () => Promise.resolve() },
}));

const { useRestart } = await import("./actions");
const { ProjectKind } = await import(
  "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
);

const project = { id: "demo-app", kind: "docker", state: "down" } as never;

function draw() {
  return renderHook(() => useRestart("s1", project));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Довести перезапуск до неудачи. Одним прыжком таймеров это не делается:
// таймер чтения лога ставится только ПОСЛЕ того, как отработал таймер
// ожидания, то есть между ними обязана прокрутиться очередь микрозадач.
async function failRestart() {
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await settle();
  await act(async () => {
    vi.advanceTimersByTime(LOG_GRAB_WAIT);
  });
  await settle();
}

const LOG_GRAB_WAIT = 1500;

function tickWith(state: string) {
  return { serverId: "s1", projects: [{ id: "demo-app", kind: "docker", state }] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  handlers.clear();
  actionMock.mockReset().mockResolvedValue(undefined);
  logStartMock.mockReset().mockResolvedValue(undefined);
  bufferedMock.mockReset().mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

describe("перезапуск", () => {
  it("до нажатия ничего не происходит", () => {
    const h = draw();
    expect(h.result.current.pending).toBe(false);
    expect(h.result.current.failed).toBe(false);
    expect(actionMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it("шлёт именно restart и именно этому проекту", async () => {
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    expect(actionMock).toHaveBeenCalledWith("s1", "demo-app", ProjectKind.KindDocker, "restart");
    expect(h.result.current.pending).toBe(true);
    h.unmount();
  });

  it("подъём по такту снимает ожидание, а не таймер", async () => {
    // Такт идёт раз в пять секунд, то есть у нас шесть попыток убедиться.
    const h = draw();
    act(() => h.result.current.run());
    await settle();

    emit("projects:tick", tickWith("running"));
    expect(h.result.current.pending).toBe(false);
    expect(h.result.current.failed).toBe(false);

    // Отведённое время истекло, но проект уже поднялся: «не поднялся» врать нельзя.
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(h.result.current.failed).toBe(false);
    h.unmount();
  });

  it("одноразовая задача, завершившаяся успехом, тоже считается подъёмом", async () => {
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    emit("projects:tick", tickWith("done"));
    expect(h.result.current.pending).toBe(false);
    h.unmount();
  });

  it("такт до нажатия не снимает ожидание, которого нет", async () => {
    const h = draw();
    emit("projects:tick", tickWith("running"));
    expect(h.result.current.pending).toBe(false);
    h.unmount();
  });

  it("чужой сервер и чужой проект ожидание не снимают", async () => {
    const h = draw();
    act(() => h.result.current.run());
    await settle();

    emit("projects:tick", { serverId: "ДРУГОЙ", projects: [{ id: "demo-app", kind: "docker", state: "running" }] });
    emit("projects:tick", { serverId: "s1", projects: [{ id: "другой-проект", kind: "docker", state: "running" }] });
    emit("projects:tick", { serverId: "s1", projects: [{ id: "demo-app", kind: "systemd", state: "running" }] });

    expect(h.result.current.pending).toBe(true);
    h.unmount();
  });

  it("не поднялся за отведённое время: говорим прямо и показываем лог", async () => {
    bufferedMock.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => `строка ${i}`),
    );
    const h = draw();
    act(() => h.result.current.run());
    await settle();

    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    expect(h.result.current.failed).toBe(true);
    expect(h.result.current.pending).toBe(false);

    // Стрим стартует не мгновенно: спросив буфер сразу, покажем пустоту.
    await act(async () => { vi.advanceTimersByTime(LOG_GRAB_WAIT); });
    await settle();

    expect(logStartMock).toHaveBeenCalledWith("s1", "demo-app", ProjectKind.KindDocker, 50);
    // Двадцать последних, а не весь журнал: нужна причина, а не чтение на ночь.
    expect(h.result.current.lines).toHaveLength(20);
    expect(h.result.current.lines[19]).toBe("строка 39");
    h.unmount();
  });

  it("отказ команды остаётся в карточке и не притворяется ожиданием", async () => {
    // Недоступный docker не повод гасить всю панель.
    actionMock.mockRejectedValue(new Error("docker не отвечает"));
    const h = draw();
    act(() => h.result.current.run());
    await settle();

    expect(h.result.current.error).toBe("docker не отвечает");
    expect(h.result.current.pending).toBe(false);
    h.unmount();
  });

  it("после отказа команды лог не запрашивается вовсе", async () => {
    actionMock.mockRejectedValue(new Error("docker не отвечает"));
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    await act(async () => { vi.advanceTimersByTime(40_000); });
    await settle();

    expect(logStartMock).not.toHaveBeenCalled();
    expect(h.result.current.failed).toBe(false);
    h.unmount();
  });

  it("отказ чтения лога не съедает сам факт неудачи", async () => {
    logStartMock.mockRejectedValue(new Error("поток не открылся"));
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    await failRestart();

    expect(h.result.current.failed).toBe(true);
    expect(h.result.current.error).toBe("поток не открылся");
    h.unmount();
  });

  it("закрыть сообщение значит убрать и текст, и строки", async () => {
    bufferedMock.mockResolvedValue(["причина"]);
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    await failRestart();
    expect(h.result.current.failed).toBe(true);

    act(() => h.result.current.dismiss());
    expect(h.result.current.failed).toBe(false);
    expect(h.result.current.lines).toEqual([]);
    expect(h.result.current.error).toBeNull();
    h.unmount();
  });

  it("повторный запуск чистит след прошлой неудачи", async () => {
    bufferedMock.mockResolvedValue(["старая причина"]);
    const h = draw();
    act(() => h.result.current.run());
    await settle();
    await failRestart();
    expect(h.result.current.lines).toEqual(["старая причина"]);

    act(() => h.result.current.run());
    await settle();
    expect(h.result.current.failed).toBe(false);
    expect(h.result.current.lines).toEqual([]);
    expect(h.result.current.pending).toBe(true);
    h.unmount();
  });
});
