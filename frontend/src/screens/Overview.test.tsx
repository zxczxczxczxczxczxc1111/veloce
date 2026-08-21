// Обзор это тот экран, ради которого приложение написано, и на нём же живёт
// самый опасный вид отказа: цифры есть, а связи нет. Замершая панель выглядит
// как работающая, поэтому здесь проверяется именно РАЗЛИЧИМОСТЬ живого и
// мёртвого, а не то, что числа отрисовались.
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

const discoverMock = vi.fn<() => Promise<unknown[] | null>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ProjectsService: {
    Discover: () => discoverMock(),
    SaveOverride: () => Promise.resolve(),
    Action: () => Promise.resolve(),
  },
  LogsService: { Start: () => Promise.resolve(), Buffered: () => Promise.resolve([]), Stop: () => Promise.resolve() },
  DiagService: { Log: () => Promise.resolve() },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { Overview } = await import("./Overview");
type ConnState = import("../state/conn").ConnState;
type MetricsHistory = import("../state/metrics").MetricsHistory;

function history(o: Partial<MetricsHistory> = {}): MetricsHistory {
  return {
    last: {
      serverId: "s1",
      cpuPercent: 12.5,
      memUsed: 8 * 1024 ** 3,
      memTotal: 16 * 1024 ** 3,
      disks: [{ mount: "/", used: 50 * 1024 ** 3, size: 100 * 1024 ** 3 }],
      rxPerSec: 1024,
      txPerSec: 2048,
      uptimeSec: 86400,
      valid: true,
      missing: null,
    },
    lastAt: Date.now(),
    cpu: [10, 12],
    memPercent: [50, 50],
    rx: [1000, 1024],
    tx: [2000, 2048],
    ...o,
  } as MetricsHistory;
}

const emptyHistory: MetricsHistory = {
  last: null, lastAt: 0, cpu: [], memPercent: [], rx: [], tx: [],
};

function project(o: Record<string, unknown> = {}) {
  return {
    id: "admin", kind: "docker", name: "admin", state: "running", status: "Up",
    trigger: "", cpuPercent: 0, cpuKnown: true, memBytes: 0, memKnown: true,
    hidden: false, health: "", ...o,
  };
}

function draw(state: ConnState, hist: MetricsHistory = history()) {
  const onConnect = vi.fn();
  const onFixConnection = vi.fn();
  const onOpenProject = vi.fn();
  const onOpenEvents = vi.fn();
  render(
    <LangProvider>
      <Overview
        serverId="s1"
        state={state}
        onConnect={onConnect}
        onFixConnection={onFixConnection}
        onOpenProject={onOpenProject}
        onOpenEvents={onOpenEvents}
        history={hist}
      />
    </LangProvider>,
  );
  return { onConnect, onFixConnection, onOpenProject, onOpenEvents };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Плитки приглушаются целиком: ищем сетку, а не отдельную плитку.
function tiles(): HTMLElement {
  return document.querySelector(".grid.grid-cols-4") as HTMLElement;
}

beforeEach(() => {
  localStorage.setItem("veloce.lang", "ru");
  handlers.clear();
  discoverMock.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe("когда показывать нечего", () => {
  it("без связи и без цифр зовёт подключиться, а не рисует прочерки", async () => {
    // Сервер не «показывает ноль», с ним просто нет связи.
    const { onConnect } = draw({ kind: "idle" }, emptyHistory);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("отказ ключа ведёт в настройку, а не предлагает подключиться снова", async () => {
    // Ключ не станет верным от повторной попытки, и кнопка тут только злит.
    const { onFixConnection } = draw({ kind: "authFailed" }, emptyHistory);
    await settle();
    expect(screen.queryByRole("button", { name: "Подключиться" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Настройка подключения" }));
    expect(onFixConnection).toHaveBeenCalledTimes(1);
  });

  it("неподтверждённый хост тоже ведёт в настройку", async () => {
    const { onFixConnection } = draw(
      { kind: "hostKeyUnknown", fingerprint: "SHA256:aa" },
      history(),
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Настройка подключения" }));
    expect(onFixConnection).toHaveBeenCalledTimes(1);
  });

  it("сменившийся ключ важнее уже показанных цифр", async () => {
    // Даже когда история есть, экран обязан уйти в развилку с ключом.
    draw({ kind: "hostKeyChanged", fingerprint: "новый", known: "старый" }, history());
    await settle();
    expect(screen.queryByText("12.5%")).toBeNull();
  });
});

describe("живые против замерших цифр", () => {
  it("на связи плитки в полную силу", async () => {
    draw({ kind: "connected" });
    await settle();
    expect(tiles().style.opacity).toBe("1");
  });

  it("потеря связи приглушает цифры: иначе панель врёт молча", async () => {
    draw({ kind: "disconnected" });
    await settle();
    expect(tiles().style.opacity).toBe("0.45");
  });

  it("сбой такта тоже считается замиранием и называет время последнего замера", async () => {
    draw({ kind: "degraded", message: "такт не удался", lastOkAt: 1_700_000_000_000 });
    await settle();
    expect(tiles().style.opacity).toBe("0.45");
    expect(screen.getByText(/Данные от/)).toBeTruthy();
  });

  it("без известного времени замера пишем, что переподключаемся", async () => {
    draw({ kind: "connecting" });
    await settle();
    expect(screen.getByText("Переподключаемся")).toBeTruthy();
  });

  it("возраст данных стоит ВСЕГДА, а не только при отказе", async () => {
    draw({ kind: "connected" });
    await settle();
    expect(screen.getByText(/обновлено/)).toBeTruthy();
  });
});

describe("плитки", () => {
  it("непрочитанная метрика это прочерк, а не ноль", async () => {
    draw({ kind: "connected" }, history({
      last: { ...history().last!, missing: ["cpu"] },
    }));
    await settle();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
    expect(screen.queryByText("12.5%")).toBeNull();
  });

  it("память подписана обоими числами, а не одной долей", async () => {
    draw({ kind: "connected" });
    await settle();
    expect(screen.getByText("8.0 ГБ / 16.0 ГБ")).toBeTruthy();
  });

  it("аптайм словами, а не тысячей часов", async () => {
    draw({ kind: "connected" });
    await settle();
    expect(screen.getByText("1 д 0 ч")).toBeTruthy();
  });

  it("без диска плитка честно пустая", async () => {
    draw({ kind: "connected" }, history({ last: { ...history().last!, disks: null } }));
    await settle();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("точка монтирования показывается только при нескольких разделах", async () => {
    // На сервере с одним разделом вечная косая черта не отвечает ни на что.
    draw({ kind: "connected" });
    await settle();
    expect(screen.queryByText("/")).toBeNull();

    cleanup();
    draw({ kind: "connected" }, history({
      last: {
        ...history().last!,
        disks: [
          { mount: "/", used: 1, size: 2 },
          { mount: "/data", used: 1, size: 2 },
        ],
      },
    }));
    await settle();
    expect(screen.getByText("/")).toBeTruthy();
  });
});

describe("список проектов", () => {
  it("первый список запрашивается сам, а не ждёт такта пять секунд", async () => {
    draw({ kind: "connected" });
    await waitFor(() => expect(discoverMock).toHaveBeenCalledTimes(1));
  });

  it("без связи список не запрашивается вовсе", async () => {
    draw({ kind: "disconnected" });
    await settle();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("проблемные проекты идут наверх", async () => {
    // На двух сотнях проектов это единственный способ увидеть беду не листая.
    discoverMock.mockResolvedValue([
      project({ id: "живой", name: "живой", state: "running" }),
      project({ id: "упавший", name: "упавший", state: "down" }),
      project({ id: "встающий", name: "встающий", state: "starting" }),
    ]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("упавший")).toBeTruthy());

    const names = [...document.querySelectorAll("li")].map(
      (li) => li.querySelector("button span.block")?.textContent,
    );
    expect(names.slice(0, 3)).toEqual(["упавший", "встающий", "живой"]);
  });

  it("внутри группы порядок не прыгает на каждом такте", async () => {
    // Сортировка устойчивая: пришедшие в одном состоянии остаются как были.
    discoverMock.mockResolvedValue([
      project({ id: "б", name: "б", state: "running" }),
      project({ id: "а", name: "а", state: "running" }),
    ]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("б")).toBeTruthy());

    const names = [...document.querySelectorAll("li")].map(
      (li) => li.querySelector("button span.block")?.textContent,
    );
    expect(names.slice(0, 2)).toEqual(["б", "а"]);
  });

  it("скрытые проекты по умолчанию не показываются, но посчитаны", async () => {
    discoverMock.mockResolvedValue([
      project({ id: "видимый", name: "видимый" }),
      project({ id: "скрытый", name: "скрытый", hidden: true }),
    ]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("видимый")).toBeTruthy());

    expect(screen.queryByText("скрытый")).toBeNull();
    expect(screen.getByText("скрыто 1")).toBeTruthy();
  });

  it("скрытые можно показать", async () => {
    discoverMock.mockResolvedValue([project({ id: "скрытый", name: "скрытый", hidden: true })]);
    draw({ kind: "connected" });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Показать системные" }));
    expect(screen.getByText("скрытый")).toBeTruthy();
  });

  it("счётчик лежащих виден в шапке, независимо от прокрутки", async () => {
    // Беда не должна зависеть от того, докрутил ли человек до строки.
    discoverMock.mockResolvedValue([
      project({ id: "а", name: "а", state: "down" }),
      project({ id: "б", name: "б", state: "down" }),
    ]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("а")).toBeTruthy());
    expect(screen.getByText("лежат: 2")).toBeTruthy();
  });

  it("скрытый лежащий проект в счётчик беды не попадает", async () => {
    discoverMock.mockResolvedValue([
      project({ id: "скрытый", name: "скрытый", state: "down", hidden: true }),
    ]);
    draw({ kind: "connected" });
    await settle();
    expect(screen.getByText("Проектов не найдено")).toBeTruthy();
  });

  it("такт заменяет список целиком", async () => {
    discoverMock.mockResolvedValue([project({ id: "старый", name: "старый" })]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("старый")).toBeTruthy());

    emit("projects:tick", { serverId: "s1", projects: [project({ id: "новый", name: "новый" })] });
    expect(screen.getByText("новый")).toBeTruthy();
    expect(screen.queryByText("старый")).toBeNull();
  });

  it("такт чужого сервера список не трогает", async () => {
    discoverMock.mockResolvedValue([project({ id: "свой", name: "свой" })]);
    draw({ kind: "connected" });
    await waitFor(() => expect(screen.getByText("свой")).toBeTruthy());

    emit("projects:tick", { serverId: "ДРУГОЙ", projects: [] });
    expect(screen.getByText("свой")).toBeTruthy();
  });

  it("отказ обнаружения виден, а не выдаётся за пустой список", async () => {
    discoverMock.mockRejectedValue(new Error("docker не установлен"));
    draw({ kind: "connected" });
    expect(await screen.findByText("docker не установлен")).toBeTruthy();
  });

  it("лента событий открывается из шапки", async () => {
    const { onOpenEvents } = draw({ kind: "connected" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "События" }));
    expect(onOpenEvents).toHaveBeenCalledTimes(1);
  });
});
