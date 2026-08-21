// Счётчик непрочитанного это подсказка, а не данные: он зовёт человека в ленту
// и не имеет права ни падать, ни врать. Отдельный такт тут редкий намеренно,
// потому что настоящее обновление приезжает событием.
import { act, renderHook, waitFor } from "@testing-library/react";
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

const unreadMock = vi.fn<(id?: string) => Promise<number>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  EventsService: { Unread: (id: string) => unreadMock(id) },
}));

const { useUnreadEvents } = await import("./eventsFeed");
type Server = import("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store").Server;

function servers(...ids: string[]): Server[] {
  return ids.map((id) => ({ id }) as Server);
}

beforeEach(() => {
  handlers.clear();
  unreadMock.mockReset().mockResolvedValue(0);
});

afterEach(() => vi.useRealTimers());

describe("счётчик непрочитанного", () => {
  it("считает по ВСЕМ серверам, а не только по открытому", async () => {
    // Рейка видна на каждом экране, и счётчик обязан быть верным независимо
    // от того, куда человек смотрит.
    unreadMock.mockImplementation((id) => Promise.resolve(id === "s1" ? 3 : 7));
    const h = renderHook(() => useUnreadEvents(servers("s1", "s2")));

    await waitFor(() => expect(h.result.current).toEqual({ s1: 3, s2: 7 }));
    h.unmount();
  });

  it("без серверов не ходит на ту сторону вовсе", async () => {
    const h = renderHook(() => useUnreadEvents([]));
    await waitFor(() => expect(h.result.current).toEqual({}));
    expect(unreadMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it("отказ по одному серверу не роняет счётчики остальных", async () => {
    // Счётчик это подсказка: молчим и оставляем ноль.
    unreadMock.mockImplementation((id) =>
      id === "s1" ? Promise.reject(new Error("нет ленты")) : Promise.resolve(5),
    );
    const h = renderHook(() => useUnreadEvents(servers("s1", "s2")));

    await waitFor(() => expect(h.result.current).toEqual({ s1: 0, s2: 5 }));
    h.unmount();
  });

  it("новое событие пересчитывает счётчики сразу, не дожидаясь такта", async () => {
    unreadMock.mockResolvedValue(1);
    const h = renderHook(() => useUnreadEvents(servers("s1")));
    await waitFor(() => expect(h.result.current).toEqual({ s1: 1 }));

    unreadMock.mockResolvedValue(9);
    emit("events:new", { serverId: "s1" });
    await waitFor(() => expect(h.result.current).toEqual({ s1: 9 }));
    h.unmount();
  });

  it("смена состава серверов пересчитывает счётчики", async () => {
    unreadMock.mockImplementation((id) => Promise.resolve(id === "s2" ? 4 : 1));
    const h = renderHook(({ list }: { list: Server[] }) => useUnreadEvents(list), {
      initialProps: { list: servers("s1") },
    });
    await waitFor(() => expect(h.result.current).toEqual({ s1: 1 }));

    h.rerender({ list: servers("s1", "s2") });
    await waitFor(() => expect(h.result.current).toEqual({ s1: 1, s2: 4 }));
    h.unmount();
  });

  it("после ухода экрана такт не крутится", async () => {
    vi.useFakeTimers();
    const h = renderHook(() => useUnreadEvents(servers("s1")));
    h.unmount();
    unreadMock.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(unreadMock).not.toHaveBeenCalled();
  });
});
