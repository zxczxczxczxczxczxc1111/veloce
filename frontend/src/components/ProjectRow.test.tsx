// Строка проекта несёт самый плотный набор утверждений в панели: живёт ли
// процесс, сколько ест, падал ли недавно. Каждое из них уже имело шанс соврать,
// поэтому проверяются именно границы: ноль против «не знаем», зелёный против
// серого, «ждёт» против «ждёт ЧЕГО».
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
}));

const saveOverrideMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const actionMock = vi.fn<(...a: unknown[]) => Promise<void>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ProjectsService: {
    SaveOverride: (...a: unknown[]) => saveOverrideMock(...a),
    Action: (...a: unknown[]) => actionMock(...a),
  },
  LogsService: { Start: () => Promise.resolve(), Buffered: () => Promise.resolve([]), Stop: () => Promise.resolve() },
  DiagService: { Log: () => Promise.resolve() },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { ProjectRow, StatusDot, detail } = await import("./ProjectRow");
const { useT } = await import("../i18n");

type P = Record<string, unknown>;

function project(o: P = {}) {
  return {
    id: "demo-app",
    kind: "docker",
    name: "demo-app",
    state: "running",
    status: "Up 3 days",
    trigger: "",
    cpuPercent: 0,
    cpuKnown: true,
    memBytes: 0,
    memKnown: true,
    hidden: false,
    health: "",
    ...o,
  } as never;
}

function draw(node: ReactNode) {
  return render(<LangProvider>{node}</LangProvider>);
}

function row(o: P = {}, downAt = 0) {
  return draw(
    <ProjectRow
      serverId="s1"
      project={project(o)}
      downAt={downAt}
      onChanged={() => {}}
      onOpen={() => {}}
    />,
  );
}

beforeEach(() => {
  localStorage.setItem("veloce.lang", "ru");
  saveOverrideMock.mockReset().mockResolvedValue(undefined);
  actionMock.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("состояние проекта", () => {
  it("состояние всегда идёт словом, а не одним цветом", () => {
    // Зелёное и красное неразличимы у части читателей, а точка без подписи
    // это единственный носитель самого важного факта.
    for (const [state, word] of [
      ["running", "Работает"],
      ["down", "Лежит"],
    ] as const) {
      cleanup();
      draw(<StatusDot state={state} />);
      expect(screen.getByText(word)).toBeTruthy();
    }
  });

  it("зелёный значит «есть живой процесс», и только это", () => {
    const { container } = draw(<StatusDot state="running" />);
    expect(container.querySelector(".bg-up")).toBeTruthy();
  });

  it("отработавший юнит серый, а не зелёный: он сделал дело, но не крутится", () => {
    const { container } = draw(<StatusDot state="done" />);
    expect(container.querySelector(".bg-up")).toBeNull();
    expect(container.querySelector(".bg-fg-faint")).toBeTruthy();
  });

  it("ожидание тоже серое, а не тревожное", () => {
    const { container } = draw(<StatusDot state="waiting" />);
    expect(container.querySelector(".bg-down")).toBeNull();
    expect(container.querySelector(".bg-fg-faint")).toBeTruthy();
  });

  it("подъём отмечен янтарным и пульсирует", () => {
    const { container } = draw(<StatusDot state="starting" />);
    expect(container.querySelector(".bg-accent")).toBeTruthy();
  });

  it("незнакомое состояние не красится ни зелёным, ни красным", () => {
    // Оба были бы утверждением, которого мы не делали.
    const { container } = draw(<StatusDot state="нечто-из-будущего" />);
    expect(container.querySelector(".bg-up")).toBeNull();
    expect(container.querySelector(".bg-down")).toBeNull();
    expect(screen.getByText("Неизвестно")).toBeTruthy();
  });
});

describe("подпись состояния", () => {
  function t() {
    let dict!: ReturnType<typeof useT>;
    function Probe() {
      dict = useT();
      return null;
    }
    draw(<Probe />);
    return dict;
  }

  it("обычное состояние показывает статус как есть", () => {
    expect(detail(t(), project({ state: "running", status: "Up 3 days" }))).toBe("Up 3 days");
  });

  it("«ждёт» без ответа на вопрос «чего» это загадка, а не сообщение", () => {
    const byTimer = detail(t(), project({ state: "waiting", trigger: "certbot.timer" }));
    expect(byTimer).toContain("certbot.timer");
    expect(byTimer).not.toBe("Up 3 days");

    const bySocket = detail(t(), project({ state: "waiting", trigger: "docker.socket" }));
    expect(bySocket).toContain("docker.socket");
    // Таймер и сокет это разные причины ждать, и подписи у них разные.
    expect(bySocket).not.toBe(byTimer.replace("certbot.timer", "docker.socket"));
  });

  it("ожидание без известного повода откатывается на обычный статус", () => {
    expect(detail(t(), project({ state: "waiting", trigger: "", status: "inactive (dead)" })))
      .toBe("inactive (dead)");
  });
});

describe("потребление", () => {
  it("простаивающий контейнер честно показывает ноль", () => {
    // 0.00% это ответ, а не отсутствие ответа.
    row({ cpuPercent: 0, cpuKnown: true, memBytes: 0, memKnown: true });
    expect(screen.getByText("0.0%")).toBeTruthy();
    expect(screen.getByText("0 Б")).toBeTruthy();
  });

  it("прочерк ставится по флагу, а не по нулю", () => {
    row({ cpuPercent: 0, cpuKnown: false, memBytes: 0, memKnown: false });
    expect(screen.getAllByText("-")).toHaveLength(2);
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("одна метрика может быть известна, а вторая нет", () => {
    row({ cpuPercent: 12.5, cpuKnown: true, memBytes: 1024, memKnown: false });
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getAllByText("-")).toHaveLength(1);
  });
});

describe("след падения", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("свежий след виден у поднявшегося проекта", () => {
    row({ state: "running" }, 1_700_000_000_000 - 60_000);
    expect(screen.getByText(/недавно лежал|1 мин/i)).toBeTruthy();
  });

  it("у лежащего след не дублирует слово «Лежит»", () => {
    row({ state: "down" }, 1_700_000_000_000 - 60_000);
    expect(screen.queryByText(/недавно лежал/i)).toBeNull();
  });

  it("след старше пяти минут это уже шум, и его нет", () => {
    row({ state: "running" }, 1_700_000_000_000 - 6 * 60_000);
    expect(screen.queryByText(/недавно лежал/i)).toBeNull();
  });

  it("без падений следа нет вовсе", () => {
    row({ state: "running" }, 0);
    expect(screen.queryByText(/недавно лежал/i)).toBeNull();
  });
});

describe("перезапуск из строки", () => {
  it("кнопка не действует сразу: сперва подтверждение с ИМЕНЕМ", () => {
    row({ name: "demo-worker" });
    act(() => screen.getByRole("button", { name: "Перезапустить" }).click());

    expect(actionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("demo-worker");
  });

  it("отмена не трогает сервер", () => {
    row();
    act(() => screen.getByRole("button", { name: "Перезапустить" }).click());
    act(() => screen.getByRole("button", { name: "Отмена" }).click());
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("подтверждение отправляет команду", async () => {
    row();
    act(() => screen.getByRole("button", { name: "Перезапустить" }).click());
    const confirmBtn = screen.getAllByRole("button", { name: "Перезапустить" }).pop()!;
    act(() => confirmBtn.click());

    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
    expect(actionMock.mock.calls[0][3]).toBe("restart");
  });
});

describe("настройка проекта", () => {
  it("живёт внутри строки, отдельного экрана ради трёх полей нет", () => {
    row();
    expect(screen.queryByLabelText(/Имя/i)).toBeNull();
    act(() => screen.getByRole("button", { name: "Настройка" }).click());
    expect(screen.getByDisplayValue("demo-app")).toBeTruthy();
  });

  it("имя, совпадающее с обнаруженным, не сохраняется как подмена", async () => {
    // Иначе переименование на сервере больше никогда не доедет до экрана.
    row({ name: "demo-app" });
    act(() => screen.getByRole("button", { name: "Настройка" }).click());
    act(() => screen.getByRole("button", { name: "Сохранить" }).click());

    await waitFor(() => expect(saveOverrideMock).toHaveBeenCalledTimes(1));
    expect((saveOverrideMock.mock.calls[0][0] as { label: string }).label).toBe("");
  });

  it("отказ сохранения остаётся в карточке", async () => {
    saveOverrideMock.mockRejectedValue(new Error("конфиг только для чтения"));
    row();
    act(() => screen.getByRole("button", { name: "Настройка" }).click());
    act(() => screen.getByRole("button", { name: "Сохранить" }).click());

    expect(await screen.findByText("конфиг только для чтения")).toBeTruthy();
  });

  it("отмена закрывает настройку, ничего не сохраняя", () => {
    row();
    act(() => screen.getByRole("button", { name: "Настройка" }).click());
    act(() => screen.getAllByRole("button", { name: "Отмена" })[0].click());

    expect(saveOverrideMock).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("demo-app")).toBeNull();
  });
});
