// Здесь живут две ошибки, которые уже случались и обе гасили панель насмерть,
// молча. Первая: такты гасились на degraded, значит события connected больше
// не приходило никогда. Вторая: признак «такты взведены» защёлкивался на
// «подключаемся», старт получал отказ, и такты не шли вообще.
//
// Поэтому тесты считают ВЫЗОВЫ Start и Stop, а не разглядывают состояние.
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

const serverStateMock = vi.fn<() => Promise<string>>();
const metricsStart = vi.fn();
const metricsStop = vi.fn();
const projectsStart = vi.fn();
const projectsStop = vi.fn();
const eventsStart = vi.fn();
const eventsStop = vi.fn();
const logsStopServer = vi.fn();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ServersService: { State: () => serverStateMock() },
  MetricsService: {
    Start: (id: string) => { metricsStart(id); return Promise.resolve(); },
    Stop: (id: string) => { metricsStop(id); return Promise.resolve(); },
  },
  ProjectsService: {
    Start: (id: string) => { projectsStart(id); return Promise.resolve(); },
    Stop: (id: string) => { projectsStop(id); return Promise.resolve(); },
  },
  EventsService: {
    Start: (id: string) => { eventsStart(id); return Promise.resolve(); },
    Stop: (id: string) => { eventsStop(id); return Promise.resolve(); },
  },
  LogsService: { StopServer: (id: string) => { logsStopServer(id); return Promise.resolve(); } },
  // Журнал диагностики не должен ломать то, что диагностирует.
  DiagService: { Log: () => Promise.resolve() },
}));

const { useConnState, useServerTickers } = await import("./conn");
type ConnState = import("./conn").ConnState;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function drawState(id: string | null = "s1") {
  return renderHook(({ s }: { s: string | null }) => useConnState(s), {
    initialProps: { s: id },
  });
}

beforeEach(() => {
  handlers.clear();
  serverStateMock.mockReset().mockResolvedValue("disconnected");
  for (const m of [metricsStart, metricsStop, projectsStart, projectsStop, eventsStart, eventsStop, logsStopServer]) {
    m.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("состояние соединения", () => {
  it("начинает с idle и ничего не выдумывает", async () => {
    const h = drawState();
    expect(h.result.current.kind).toBe("idle");
    await settle();
    h.unmount();
  });

  it("спрашивает текущее состояние сразу: подписка ловит только будущее", async () => {
    // Живой сервер, подключившийся до открытия экрана, иначе числился бы
    // отключённым, и такты не запустились бы вообще.
    serverStateMock.mockResolvedValue("connected");
    const h = drawState();
    await settle();
    expect(h.result.current.kind).toBe("connected");
    h.unmount();
  });

  it("опоздавший ответ не затирает уже пришедшее событие", async () => {
    let release: (v: string) => void = () => {};
    serverStateMock.mockReturnValue(new Promise((r) => { release = r; }));
    const h = drawState();

    emit("conn:state", { serverId: "s1", state: "hostKeyUnknown", fingerprint: "SHA256:aa" });
    await act(async () => { release("connected"); await Promise.resolve(); });

    // Вопрос про ключ хоста не должен исчезнуть из-под человека.
    expect(h.result.current.kind).toBe("hostKeyUnknown");
    h.unmount();
  });

  it("каждый вид отказа остаётся собой, а не сваливается в один failed", async () => {
    const h = drawState();
    await settle();

    emit("conn:state", { serverId: "s1", state: "connecting" });
    expect(h.result.current.kind).toBe("connecting");

    emit("conn:state", { serverId: "s1", state: "authFailed" });
    expect(h.result.current.kind).toBe("authFailed");

    emit("conn:state", { serverId: "s1", state: "jumpFailed", message: "бастион молчит" });
    expect(h.result.current).toEqual({ kind: "jumpFailed", message: "бастион молчит" });

    h.unmount();
  });

  it("неизвестный хост и сменившийся ключ это РАЗНЫЕ состояния", async () => {
    // У неизвестного уместна кнопка «доверять», у сменившегося человек обязан
    // сравнить два отпечатка. Одна кнопка на оба случая и есть дыра.
    const h = drawState();
    await settle();

    emit("conn:state", { serverId: "s1", state: "hostKeyUnknown", fingerprint: "SHA256:новый" });
    expect(h.result.current).toEqual({ kind: "hostKeyUnknown", fingerprint: "SHA256:новый" });

    emit("conn:state", {
      serverId: "s1", state: "hostKeyChanged",
      fingerprint: "SHA256:новый", knownFingerprint: "SHA256:старый",
    });
    expect(h.result.current).toEqual({
      kind: "hostKeyChanged", fingerprint: "SHA256:новый", known: "SHA256:старый",
    });
    h.unmount();
  });

  it("сбой такта не затирает вопрос про ключ хоста", async () => {
    const h = drawState();
    await settle();
    emit("conn:state", { serverId: "s1", state: "hostKeyUnknown", fingerprint: "SHA256:aa" });
    emit("conn:state", { serverId: "s1", state: "degraded", message: "такт не удался" });
    expect(h.result.current.kind).toBe("hostKeyUnknown");
    h.unmount();
  });

  it("degraded помнит время последнего успешного замера", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const h = drawState();
    await settle();
    emit("conn:state", { serverId: "s1", state: "connected" });
    vi.setSystemTime(1_700_000_030_000);
    emit("conn:state", { serverId: "s1", state: "degraded", message: "команда не прошла" });

    expect(h.result.current).toEqual({
      kind: "degraded", message: "команда не прошла", lastOkAt: 1_700_000_000_000,
    });
    h.unmount();
  });

  it("незнакомое состояние трактуется как отключено, а не игнорируется", async () => {
    const h = drawState();
    await settle();
    emit("conn:state", { serverId: "s1", state: "нечто-новое-из-go" });
    expect(h.result.current.kind).toBe("disconnected");
    h.unmount();
  });

  it("чужой сервер не подмешивается", async () => {
    const h = drawState();
    await settle();
    emit("conn:state", { serverId: "ДРУГОЙ", state: "connected" });
    expect(h.result.current.kind).toBe("idle");
    h.unmount();
  });

  it("смена сервера сбрасывает состояние", async () => {
    // Иначе «на связи» от предыдущего висит на новом до первого его события.
    const h = drawState("s1");
    await settle();
    emit("conn:state", { serverId: "s1", state: "connected" });
    expect(h.result.current.kind).toBe("connected");

    h.rerender({ s: "s2" });
    await settle();
    expect(h.result.current.kind).toBe("idle");
    h.unmount();
  });

  it("отказ биндинга не подменяет собой состояние соединения", async () => {
    serverStateMock.mockRejectedValue(new Error("биндинг умер"));
    const h = drawState();
    await settle();
    expect(h.result.current.kind).toBe("idle");
    h.unmount();
  });
});

describe("такты", () => {
  function drawTickers(initial: ConnState) {
    return renderHook(({ st }: { st: ConnState }) => useServerTickers("s1", st), {
      initialProps: { st: initial },
    });
  }

  it("на «подключаемся» не взводятся: старт получил бы отказ и признак застрял", async () => {
    const h = drawTickers({ kind: "connecting" });
    await settle();
    expect(metricsStart).not.toHaveBeenCalled();
    h.unmount();
  });

  it("взводятся по факту соединения", async () => {
    const h = drawTickers({ kind: "idle" });
    h.rerender({ st: { kind: "connected" } });
    await settle();
    expect(metricsStart).toHaveBeenCalledWith("s1");
    expect(projectsStart).toHaveBeenCalledWith("s1");
    expect(eventsStart).toHaveBeenCalledWith("s1");
    h.unmount();
  });

  it("НЕ гаснут на degraded: иначе connected больше никогда не придёт", async () => {
    const h = drawTickers({ kind: "connected" });
    await settle();
    metricsStart.mockClear();

    h.rerender({ st: { kind: "degraded", message: "такт не удался", lastOkAt: 0 } });
    await settle();

    expect(metricsStop).not.toHaveBeenCalled();
    // И перезапускать их тоже незачем: в зависимостях булево, а не вид.
    expect(metricsStart).not.toHaveBeenCalled();
    h.unmount();
  });

  it("НЕ гаснут на disconnected: переподключение запускается попыткой команды", async () => {
    const h = drawTickers({ kind: "connected" });
    await settle();
    h.rerender({ st: { kind: "disconnected" } });
    await settle();
    expect(metricsStop).not.toHaveBeenCalled();
    h.unmount();
  });

  it("гаснут на отказе ключа: он не станет верным от повторной попытки", async () => {
    const h = drawTickers({ kind: "connected" });
    await settle();
    h.rerender({ st: { kind: "authFailed" } });
    await settle();
    expect(metricsStop).toHaveBeenCalledWith("s1");
    expect(projectsStop).toHaveBeenCalledWith("s1");
    expect(eventsStop).toHaveBeenCalledWith("s1");
    h.unmount();
  });

  it("гаснут, пока неподтверждённый хост ждёт решения человека", async () => {
    const h = drawTickers({ kind: "connected" });
    await settle();
    h.rerender({ st: { kind: "hostKeyUnknown", fingerprint: "SHA256:aa" } });
    await settle();
    expect(metricsStop).toHaveBeenCalledWith("s1");
    h.unmount();
  });

  it("после подтверждения хоста такты взводятся снова", async () => {
    const h = drawTickers({ kind: "hostKeyUnknown", fingerprint: "SHA256:aa" });
    await settle();
    expect(metricsStart).not.toHaveBeenCalled();

    h.rerender({ st: { kind: "connected" } });
    await settle();
    expect(metricsStart).toHaveBeenCalledWith("s1");
    h.unmount();
  });

  it("уход с экрана гасит и такты, и потоки логов сервера", async () => {
    const h = drawTickers({ kind: "connected" });
    await settle();
    h.unmount();
    expect(metricsStop).toHaveBeenCalledWith("s1");
    expect(projectsStop).toHaveBeenCalledWith("s1");
    expect(eventsStop).toHaveBeenCalledWith("s1");
    expect(logsStopServer).toHaveBeenCalledWith("s1");
  });

  it("без сервера такты не запускаются вовсе", async () => {
    const h = renderHook(() => useServerTickers(null, { kind: "connected" }));
    await settle();
    expect(metricsStart).not.toHaveBeenCalled();
    h.unmount();
  });
});
