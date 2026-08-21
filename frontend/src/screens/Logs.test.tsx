// Полноэкранный лог это тонкая обёртка, и проверять в ней надо ровно одно:
// признак «проект работает» обязан считаться по СВЕЖЕМУ состоянию из такта, а
// не по снимку, с которым экран открыли. Ошибись тут, и поток не возобновится
// после подъёма проекта, потому что экран всё ещё думает, что тот лежит.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

const startMock = vi.fn<(...a: unknown[]) => Promise<void>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  LogsService: {
    Start: (...a: unknown[]) => startMock(...a),
    Buffered: () => Promise.resolve([]),
    Stop: () => Promise.resolve(),
  },
  DiagService: { Log: () => Promise.resolve() },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { Logs } = await import("./Logs");

function project(o: Record<string, unknown> = {}) {
  return {
    id: "demo-app", kind: "docker", name: "demo-app",
    state: "down", status: "Exited", trigger: "",
    cpuPercent: 0, cpuKnown: false, memBytes: 0, memKnown: false,
    hidden: false, health: "", ...o,
  } as never;
}

function draw(o: Record<string, unknown> = {}) {
  const onBack = vi.fn();
  render(
    <LangProvider>
      <Logs serverId="s1" project={project(o)} onBack={onBack} />
    </LangProvider>,
  );
  return { onBack };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.setItem("veloce.lang", "ru");
  handlers.clear();
  startMock.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("полноэкранный лог", () => {
  it("рисуется сразу по снимку, не дожидаясь первого такта", async () => {
    draw({ name: "demo-app" });
    await settle();
    expect(screen.getByText("demo-app")).toBeTruthy();
    expect(screen.getByLabelText("Фильтр")).toBeTruthy();
  });

  it("имя обновляется тактом: переименование на сервере доезжает", async () => {
    draw({ name: "старое имя" });
    await settle();
    emit("projects:tick", {
      serverId: "s1",
      projects: [{ id: "demo-app", kind: "docker", name: "новое имя", state: "down" }],
    });
    expect(screen.getByText("новое имя")).toBeTruthy();
  });

  it("возврат работает", async () => {
    const { onBack } = draw();
    await settle();
    act(() => screen.getByRole("button", { name: "Назад" }).click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("поток открывается для того проекта, с которым экран открыли", async () => {
    draw();
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(startMock.mock.calls[0][0]).toBe("s1");
    expect(startMock.mock.calls[0][1]).toBe("demo-app");
  });
});
