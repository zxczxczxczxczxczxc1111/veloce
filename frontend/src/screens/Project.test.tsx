// Экран проекта отвечает на вопрос, который статус контейнера не покрывает:
// «процесс запущен» и «приложение работает» это разные утверждения, контейнер
// бывает up и мёртв внутри. Плюс два счётчика с ловушками: перезапуски, где -1
// значит «счётчика нет», и health-check, у которого целых ТРИ состояния вместо
// ожидаемых двух.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
}));

const restartsMock = vi.fn<() => Promise<number>>();
const healthCheckMock = vi.fn<() => Promise<unknown>>();
const actionMock = vi.fn<(...a: unknown[]) => Promise<void>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ProjectsService: {
    Restarts: () => restartsMock(),
    Action: (...a: unknown[]) => actionMock(...a),
    SaveOverride: () => Promise.resolve(),
  },
  HealthService: { Check: () => healthCheckMock() },
  LogsService: {
    Start: () => Promise.resolve(),
    Buffered: () => Promise.resolve([]),
    Stop: () => Promise.resolve(),
  },
  DiagService: { Log: () => Promise.resolve() },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { Project } = await import("./Project");

function project(o: Record<string, unknown> = {}) {
  return {
    id: "demo-app", kind: "docker", name: "demo-app",
    state: "running", status: "Up 3 days", trigger: "",
    cpuPercent: 12.5, cpuKnown: true, memBytes: 1024 * 1024, memKnown: true,
    hidden: false, health: "", ...o,
  } as never;
}

function draw(o: Record<string, unknown> = {}) {
  const onBack = vi.fn();
  const onFullLogs = vi.fn();
  render(
    <LangProvider>
      <Project serverId="s1" project={project(o)} onBack={onBack} onFullLogs={onFullLogs} />
    </LangProvider>,
  );
  return { onBack, onFullLogs };
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
  restartsMock.mockReset().mockResolvedValue(0);
  healthCheckMock.mockReset().mockResolvedValue({ configured: false, ok: false, code: 0, lastOkAt: 0 });
  actionMock.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("шапка и потребление", () => {
  it("имя, вид и статус стоят рядом", async () => {
    draw();
    await settle();
    expect(screen.getByText("demo-app")).toBeTruthy();
    expect(screen.getByText(/docker · Up 3 days/)).toBeTruthy();
  });

  it("честный ноль это ноль", async () => {
    draw({ cpuPercent: 0, cpuKnown: true, memBytes: 0, memKnown: true });
    await settle();
    expect(screen.getByText("0.0%")).toBeTruthy();
    expect(screen.getByText("0 Б")).toBeTruthy();
  });

  it("прочерк ставится по флагу, а не по сравнению с нулём", async () => {
    draw({ cpuKnown: false, memKnown: false });
    await settle();
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2);
  });

  it("возврат назад работает", async () => {
    const { onBack } = draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("полноэкранный лог открывается отдельно", async () => {
    const { onFullLogs } = draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Во весь экран" }));
    expect(onFullLogs).toHaveBeenCalledTimes(1);
  });
});

describe("счётчик перезапусков", () => {
  it("ноль показывается числом: «ни разу не падал» это факт", async () => {
    restartsMock.mockResolvedValue(0);
    draw();
    await waitFor(() => expect(screen.getByText("0")).toBeTruthy());
    expect(screen.getByText("с последнего запуска")).toBeTruthy();
  });

  it("минус один значит «счётчика нет», и это прочерк, а не ноль", async () => {
    // У контейнеров такого счётчика нет, и ноль читался бы как «не падал».
    restartsMock.mockResolvedValue(-1);
    draw();
    await settle();
    expect(screen.queryByText("с последнего запуска")).toBeNull();
  });

  it("отказ чтения счётчика не гасит карточку", async () => {
    // Число перезапусков это справка, а не основа экрана.
    restartsMock.mockRejectedValue(new Error("systemctl недоступен"));
    draw();
    await settle();
    expect(screen.getByText("demo-app")).toBeTruthy();
    expect(screen.queryByText("systemctl недоступен")).toBeNull();
  });

  it("подпись стоит только там, где есть число", async () => {
    restartsMock.mockResolvedValue(-1);
    draw();
    await settle();
    // Под прочерком «с последнего запуска» читалось бы как пояснение к пустоте.
    expect(screen.queryByText("с последнего запуска")).toBeNull();
  });
});

describe("health-check: три состояния, а не два", () => {
  it("не настроен это не отказ", async () => {
    // У большинства проектов проверки нет, и красное на них было бы враньём.
    draw({ health: "" });
    await settle();
    expect(screen.getByText("Не настроен")).toBeTruthy();
  });

  it("настроен, но проект лежит: это отдельный случай", async () => {
    // Написать «не настроен» значит соврать про настройку, сделанную руками.
    draw({ health: "http://127.0.0.1:8080/health", state: "down" });
    await settle();
    expect(screen.getByText("Проверка идёт только у работающего")).toBeTruthy();
    expect(healthCheckMock).not.toHaveBeenCalled();
  });

  it("отвечает: зелёное слово плюс код", async () => {
    healthCheckMock.mockResolvedValue({
      configured: true, ok: true, code: 200, lastOkAt: Date.now() - 5000,
    });
    draw({ health: "http://127.0.0.1:8080/health", state: "running" });
    await waitFor(() => expect(screen.getByText("Отвечает")).toBeTruthy());
    expect(screen.getByText("код 200")).toBeTruthy();
  });

  it("код ноль это НЕ ответ сервера, а его отсутствие", async () => {
    // Так curl сообщает про таймаут и отказ соединения.
    healthCheckMock.mockResolvedValue({
      configured: true, ok: false, code: 0, lastOkAt: 0,
    });
    draw({ health: "http://127.0.0.1:8080/health", state: "running" });
    await waitFor(() => expect(screen.getByText("Не отвечает")).toBeTruthy());
    expect(screen.getByText("ответа нет")).toBeTruthy();
    expect(screen.queryByText("код 0")).toBeNull();
  });

  it("показывается время последнего УСПЕШНОГО ответа, а не последней проверки", async () => {
    // «Проверено 5 секунд назад» у лежащего сервиса бесполезно.
    healthCheckMock.mockResolvedValue({
      configured: true, ok: false, code: 502, lastOkAt: Date.now() - 3 * 60_000,
    });
    draw({ health: "http://127.0.0.1:8080/health", state: "running" });
    await waitFor(() => expect(screen.getByText("Не отвечает")).toBeTruthy());
    expect(screen.getByText(/последний ответ 3 мин назад/)).toBeTruthy();
  });

  it("если успешных ответов не было, так и написано", async () => {
    healthCheckMock.mockResolvedValue({
      configured: true, ok: false, code: 502, lastOkAt: 0,
    });
    draw({ health: "http://127.0.0.1:8080/health", state: "running" });
    await waitFor(() => expect(screen.getByText("успешных ответов не было")).toBeTruthy());
  });
});

describe("перезапуск", () => {
  it("сперва подтверждение с именем, и только потом команда", async () => {
    draw({ name: "demo-worker" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));

    expect(actionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("demo-worker");
  });

  it("подтверждение отправляет restart", async () => {
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Перезапустить" }).pop()!);

    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
    expect(actionMock.mock.calls[0][3]).toBe("restart");
  });

  it("отмена не трогает сервер", async () => {
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(actionMock).not.toHaveBeenCalled();
  });
});
