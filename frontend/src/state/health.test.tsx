// Health-check это сетевой запрос на ЧУЖОЕ приложение, а не чтение /proc.
// Поэтому здесь важнее всего не результат, а частота: долбить чужой сервис
// каждые две секунды невежливо, а проверять выключенную проверку просто глупо.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn<(...a: unknown[]) => Promise<unknown>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  HealthService: { Check: (...a: unknown[]) => checkMock(...a) },
}));

const { useHealth } = await import("./health");

const ok = { ok: true, code: 200 };

type Props = { url: string; enabled: boolean };

function draw(initial: Props = { url: "https://example/health", enabled: true }) {
  return renderHook(({ url, enabled }: Props) => useHealth("s1", url, enabled), {
    initialProps: initial,
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  checkMock.mockReset().mockResolvedValue(ok);
});

afterEach(() => vi.useRealTimers());

describe("проверка доступности", () => {
  it("спрашивает сразу, а не через первый такт", async () => {
    const h = draw();
    await settle();
    expect(checkMock).toHaveBeenCalledWith("s1", "https://example/health");
    expect(h.result.current).toEqual(ok);
    h.unmount();
  });

  it("повторяет раз в пятнадцать секунд, а не по такту метрик", async () => {
    const h = draw();
    await settle();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(14_000); });
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(checkMock).toHaveBeenCalledTimes(2);
    h.unmount();
  });

  it("выключенная проверка не ходит на сервер вообще", async () => {
    const h = draw({ url: "https://example/health", enabled: false });
    await settle();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(checkMock).not.toHaveBeenCalled();
    expect(h.result.current).toBeNull();
    h.unmount();
  });

  it("пустой и пробельный адрес это «не настроено», а не запрос в никуда", async () => {
    const h = draw({ url: "   ", enabled: true });
    await settle();
    expect(checkMock).not.toHaveBeenCalled();
    expect(h.result.current).toBeNull();
    h.unmount();
  });

  it("отказ проверки гасит только её, состояние проекта остаётся верным", async () => {
    // Нет соединения с сервером это не «приложение лежит».
    checkMock.mockRejectedValue(new Error("нет соединения"));
    const h = draw();
    await settle();
    expect(h.result.current).toBeNull();
    h.unmount();
  });

  it("смена адреса перезапускает проверку", async () => {
    const h = draw();
    await settle();
    checkMock.mockClear();

    h.rerender({ url: "https://example/other", enabled: true });
    await settle();
    expect(checkMock).toHaveBeenCalledWith("s1", "https://example/other");
    h.unmount();
  });

  it("выключение останавливает такт, а не оставляет его крутиться", async () => {
    const h = draw();
    await settle();
    h.rerender({ url: "https://example/health", enabled: false });
    await settle();
    checkMock.mockClear();

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(checkMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it("закрытие экрана останавливает такт", async () => {
    const h = draw();
    await settle();
    h.unmount();
    checkMock.mockClear();

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("опоздавший ответ после ухода с экрана никуда не пишется", async () => {
    let release: (v: unknown) => void = () => {};
    checkMock.mockReturnValue(new Promise((r) => { release = r; }));
    const h = draw();
    h.unmount();
    // Если бы hook писал в состояние после размонтирования, React ругнулся бы
    // в консоль, а значение уехало бы в мёртвый экран.
    await act(async () => { release(ok); await Promise.resolve(); });
  });
});
