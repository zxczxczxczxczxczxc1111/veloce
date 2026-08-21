// Оболочка держит то, что обязано пережить смену экрана: такты, историю
// метрик, память о падениях и счётчики непрочитанного. Ошибка тут не видна
// глазом, а проявляется тем, что человек возвращается на обзор к пустым
// плиткам с подписью «тактов ещё не было».
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const listMock = vi.fn<() => Promise<unknown[] | null>>();
const unreadMock = vi.fn<() => Promise<number>>();
const metricsStart = vi.fn();
const metricsStop = vi.fn();

vi.mock("../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ServersService: {
    List: () => listMock(),
    State: () => Promise.resolve("idle"),
    Connect: () => Promise.resolve(),
    Save: () => Promise.resolve(),
    Delete: () => Promise.resolve(),
    TrustHost: () => Promise.resolve(),
    ForgetHost: () => Promise.resolve(),
    Fingerprints: () => Promise.resolve([]),
  },
  MetricsService: {
    Start: (id: string) => { metricsStart(id); return Promise.resolve(); },
    Stop: (id: string) => { metricsStop(id); return Promise.resolve(); },
  },
  ProjectsService: {
    Start: () => Promise.resolve(), Stop: () => Promise.resolve(),
    Discover: () => Promise.resolve([]), SaveOverride: () => Promise.resolve(),
    Action: () => Promise.resolve(), Restarts: () => Promise.resolve(0),
  },
  EventsService: {
    Start: () => Promise.resolve(), Stop: () => Promise.resolve(),
    List: () => Promise.resolve([]), MarkRead: () => Promise.resolve(),
    Unread: () => unreadMock(),
  },
  LogsService: {
    Start: () => Promise.resolve(), Buffered: () => Promise.resolve([]),
    Stop: () => Promise.resolve(), StopServer: () => Promise.resolve(),
  },
  HealthService: { Check: () => Promise.resolve({ configured: false }) },
  DiagService: { Log: () => Promise.resolve() },
}));

const { Shell } = await import("./Shell");
const { LangProvider } = await import("../../i18n/LangProvider");

function server(o: Record<string, unknown> = {}) {
  return {
    id: "s1", label: "Прод", host: "203.0.113.10", port: 0, user: "root",
    keyPath: "", useAgent: true, tags: [], jumpVia: "", ...o,
  };
}

function draw() {
  return render(
    <LangProvider>
      <Shell />
    </LangProvider>,
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.setItem("veloce.lang", "ru");
  handlers.clear();
  listMock.mockReset().mockResolvedValue([server()]);
  unreadMock.mockReset().mockResolvedValue(0);
  metricsStart.mockReset();
  metricsStop.mockReset();
  vi.stubGlobal("crypto", { randomUUID: () => "новый-id" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("загрузка списка", () => {
  it("отказ биндинга не оставляет вечный скелет", async () => {
    // Без перехвата список остаётся null навсегда, и человек смотрит на
    // скелет, не понимая, что сломалось.
    listMock.mockRejectedValue(new Error("конфиг не читается"));
    draw();
    expect(await screen.findByText("конфиг не читается")).toBeTruthy();
    // Строка встречается дважды: в рейке и на самом экране.
    expect(screen.getAllByText("Серверов пока нет").length).toBeGreaterThan(0);
  });

  it("null из Go это пустой список, а не отсутствие ответа", async () => {
    listMock.mockResolvedValue(null);
    draw();
    await settle();
    expect(screen.getAllByText("Серверов пока нет").length).toBeGreaterThan(0);
  });
});

describe("навигация", () => {
  it("начинается с экрана серверов", async () => {
    draw();
    await settle();
    // Кнопка есть и в рейке, и на экране серверов: важно, что экран именно тот.
    expect(screen.getAllByRole("button", { name: "Добавить сервер" }).length)
      .toBeGreaterThan(0);
  });

  it("выбор сервера в рейке уводит на обзор", async () => {
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Прод/ }));
    await settle();
    // На обзоре без связи стоит приглашение подключиться.
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeTruthy();
  });

  it("счётчик событий в рейке ведёт прямо в ленту", async () => {
    unreadMock.mockResolvedValue(4);
    draw();
    await waitFor(() => expect(screen.getByText("4")).toBeTruthy());

    fireEvent.click(screen.getByText("4"));
    await settle();
    expect(screen.getByRole("heading", { name: /всего/ })).toBeTruthy();
  });

  it("из ленты возврат ведёт на обзор, а не на список серверов", async () => {
    unreadMock.mockResolvedValue(2);
    draw();
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
    fireEvent.click(screen.getByText("2"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await settle();
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeTruthy();
  });
});

describe("такты и история живут в оболочке", () => {
  it("такты взводятся только по факту соединения", async () => {
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Прод/ }));
    await settle();
    expect(metricsStart).not.toHaveBeenCalled();

    emit("conn:state", { serverId: "s1", state: "connected" });
    await settle();
    expect(metricsStart).toHaveBeenCalledWith("s1");
  });

  it("уход на другой экран того же сервера такты НЕ гасит", async () => {
    // Иначе обзор просит цифры ровно тогда, когда тикеры уже остановлены.
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Прод/ }));
    emit("conn:state", { serverId: "s1", state: "connected" });
    await settle();
    metricsStop.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "События" }));
    await settle();
    expect(metricsStop).not.toHaveBeenCalled();
  });

  it("история метрик переживает уход на другой экран", async () => {
    // Живи она в экране, каждый заход в ленту выбрасывал бы окно спарклайна.
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Прод/ }));
    emit("conn:state", { serverId: "s1", state: "connected" });
    await settle();

    emit("metrics:tick", {
      serverId: "s1", cpuPercent: 42, memUsed: 1, memTotal: 2, disks: null,
      rxPerSec: 0, txPerSec: 0, uptimeSec: 600, valid: true, missing: null,
    });
    await settle();
    expect(screen.getByText("42.0%")).toBeTruthy();

    // Ушли в ленту и вернулись.
    fireEvent.click(screen.getByRole("button", { name: "События" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await settle();

    expect(screen.getByText("42.0%")).toBeTruthy();
    expect(screen.queryByText("тактов ещё не было")).toBeNull();
  });
});
