// Поток логов уже ломался дважды: он открывался по кругу («оборвался - открыли
// заново» без конца) и лил двести строк истории на каждую попытку. Оба отказа
// выглядели как живая работа, поэтому здесь проверяется НЕ то, что строки
// приходят, а то, сколько раз мы дёргаем сервер и сколько отметок ставим.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

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

const startMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const bufferedMock = vi.fn<() => Promise<string[] | null>>();
const stopMock = vi.fn<() => Promise<void>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  LogsService: {
    Start: (...a: unknown[]) => startMock(...a),
    Buffered: () => bufferedMock(),
    Stop: () => stopMock(),
  },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { useLogs, kindOf } = await import("./logs");
const { ProjectKind } = await import(
  "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
);

const wrapper = ({ children }: { children: ReactNode }) => <LangProvider>{children}</LangProvider>;

function draw(live = true) {
  return renderHook(({ l }: { l: boolean }) => useLogs("s1", "p1", "docker", l), {
    wrapper,
    initialProps: { l: live },
  });
}

// Хук стартует поток асинхронно: без прокрутки микрозадач первый Start ещё в
// полёте, и любая проверка после него мерила бы не то.
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  localStorage.setItem("veloce.lang", "ru");
  handlers.clear();
  startMock.mockReset().mockResolvedValue(undefined);
  bufferedMock.mockReset().mockResolvedValue([]);
  stopMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("kindOf", () => {
  it("сравнивает, а не приводит: неизвестное не улетает в команду на сервере", () => {
    expect(kindOf("docker")).toBe(ProjectKind.KindDocker);
    expect(kindOf("systemd")).toBe(ProjectKind.KindSystemd);
    expect(kindOf("что-то ещё")).toBe(ProjectKind.KindSystemd);
    expect(kindOf("")).toBe(ProjectKind.KindSystemd);
  });
});

describe("поток логов", () => {
  it("первое открытие просит историю, возобновление НЕ просит", async () => {
    // Та же история, приехавшая второй раз, это лог, заполненный копиями себя.
    const h = draw();
    await settle();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock.mock.calls[0][3]).toBe(200);

    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    await settle();

    expect(startMock.mock.calls[1][3]).toBe(0);
    h.unmount();
  });

  it("строки копятся с постоянными номерами", async () => {
    const h = draw();
    await settle();
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["раз", "два"] });
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["три"] });

    expect(h.result.current.lines.map((l) => l.text)).toEqual(["раз", "два", "три"]);
    // Номера обязаны быть уникальными: на них держится перерисовка списка.
    expect(new Set(h.result.current.lines.map((l) => l.id)).size).toBe(3);
    h.unmount();
  });

  it("чужой сервер и чужой проект не подмешиваются", async () => {
    const h = draw();
    await settle();
    emit("logs:batch", { serverId: "ДРУГОЙ", projectId: "p1", lines: ["чужое"] });
    emit("logs:batch", { serverId: "s1", projectId: "ДРУГОЙ", lines: ["чужое"] });
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["своё"] });

    expect(h.result.current.lines.map((l) => l.text)).toEqual(["своё"]);
    h.unmount();
  });

  it("кольцо режет старое, а не копит до смерти приложения", async () => {
    const h = draw();
    await settle();
    // 5001 строка: одна обязана уехать, и уехать должна ПЕРВАЯ.
    emit("logs:batch", {
      serverId: "s1",
      projectId: "p1",
      lines: Array.from({ length: 5001 }, (_, i) => `строка ${i}`),
    });

    expect(h.result.current.lines).toHaveLength(5000);
    expect(h.result.current.lines[0].text).toBe("строка 1");
    expect(h.result.current.lines[4999].text).toBe("строка 5000");
    h.unmount();
  });

  it("на паузе строки не копятся, а выбрасываются", async () => {
    // Копить значит вывалить тысячу строк одним куском в момент снятия паузы.
    const h = draw();
    await settle();
    act(() => h.result.current.setPaused(true));
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["пропущено"] });
    expect(h.result.current.lines).toHaveLength(0);

    act(() => h.result.current.setPaused(false));
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["после паузы"] });
    expect(h.result.current.lines.map((l) => l.text)).toEqual(["после паузы"]);
    h.unmount();
  });
});

describe("обрыв и возобновление", () => {
  it("отметка об обрыве ставится один раз, а не на каждое событие", async () => {
    const h = draw();
    await settle();
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });

    const marks = h.result.current.lines.filter((l) => l.system);
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toContain("поток прерван");
    expect(h.result.current.waiting).toBe(true);
    h.unmount();
  });

  it("состояние started обрывом не считается", async () => {
    const h = draw();
    await settle();
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "started" });
    expect(h.result.current.waiting).toBe(false);
    expect(h.result.current.lines).toHaveLength(0);
    h.unmount();
  });

  it("кто сказал «замерло», тот говорит и «отмерло»", async () => {
    const h = draw();
    await settle();
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    await settle();

    const texts = h.result.current.lines.filter((l) => l.system).map((l) => l.text);
    expect(texts[0]).toContain("поток прерван");
    expect(texts[1]).toContain("поток возобновлён");
    expect(h.result.current.waiting).toBe(false);
    h.unmount();
  });

  it("на остановленном проекте поток не дёргается вообще", async () => {
    // docker logs -f на мёртвом контейнере не ждёт, а печатает историю и
    // выходит: слепые повторы лили бы двести строк на каждую попытку.
    const h = draw(false);
    await settle();
    startMock.mockClear();

    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();

    expect(startMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it("две попытки подряд быстрее трёх секунд это круг, и он обрывается", async () => {
    const h = draw();
    await settle();
    startMock.mockClear();

    // Подъём проекта сразу после обрыва: ограничитель обязан съесть повтор.
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    await settle();
    expect(startMock).not.toHaveBeenCalled();

    // Ограничитель это 3 секунды, но повтор приезжает интервалом вдвое реже:
    // на 3.1 секунды ещё тихо.
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    await settle();
    expect(startMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(startMock).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

describe("отказы и уборка", () => {
  it("отказ старта показывается человеку", async () => {
    startMock.mockRejectedValueOnce(new Error("нет соединения"));
    const h = draw();
    await settle();
    expect(h.result.current.error).toBe("нет соединения");
    h.unmount();
  });

  it("пока ждём подъёма, отказ ожидаем и молчалив", async () => {
    const h = draw();
    await settle();
    emit("logs:stream", { serverId: "s1", projectId: "p1", state: "ended" });
    startMock.mockRejectedValue(new Error("проект ещё лежит"));

    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    await settle();

    expect(h.result.current.error).toBeNull();
    h.unmount();
  });

  it("накопленное на стороне Go показывается при заходе на пустой экран", async () => {
    bufferedMock.mockResolvedValue(["из буфера 1", "из буфера 2"]);
    const h = draw();
    await settle();
    expect(h.result.current.lines.map((l) => l.text)).toEqual(["из буфера 1", "из буфера 2"]);
    h.unmount();
  });

  it("буфер не затирает уже приехавшие строки", async () => {
    let release: (v: string[]) => void = () => {};
    bufferedMock.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const h = draw();
    await settle();
    emit("logs:batch", { serverId: "s1", projectId: "p1", lines: ["живая строка"] });
    await act(async () => {
      release(["история"]);
      await Promise.resolve();
    });

    expect(h.result.current.lines.map((l) => l.text)).toEqual(["живая строка"]);
    h.unmount();
  });

  it("закрытие экрана гасит поток на сервере", async () => {
    // Иначе docker logs -f копится на той стороне при каждом заходе.
    const h = draw();
    await settle();
    h.unmount();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
