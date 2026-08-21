// Что здесь проверяется: экран ленты соврал один раз, и врал убедительно.
// При фильтре без совпадений он писал «Событий нет, и это хорошая новость»
// поверх непустой ленты. Для панели наблюдения это худший сорт отказа: человек
// уходит спокойным, пока на сервере идёт подбор пароля. Тесты держат ту границу
// и заодно счётчик, который раньше не замечал фильтра.
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";

const listMock = vi.fn<() => Promise<Incident[] | null>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  EventsService: {
    List: () => listMock(),
    MarkRead: () => Promise.resolve(),
    Start: () => Promise.resolve(),
    Stop: () => Promise.resolve(),
    Unread: () => Promise.resolve(0),
  },
}));

// Рантайм Wails в jsdom не поднимется: подписка нужна только чтобы экран не
// падал, отписка обязана быть функцией.
vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { EventsScreen } = await import("./Events");

function incident(severity: string, title: string): Incident {
  return {
    serverId: "s1",
    at: Date.now() - 60_000,
    source: "fail2ban",
    severity,
    title,
    detail: "jail sshd",
    read: false,
  };
}

function draw() {
  return render(
    <LangProvider>
      <EventsScreen serverId="s1" onBack={() => {}} />
    </LangProvider>,
  );
}

async function clickFilter(name: string) {
  const btn = await screen.findByRole("button", { name });
  btn.click();
}

beforeEach(() => {
  // Язык закрепляем: тексты сверяются дословно, и системная локаль не должна
  // решать, пройдёт тест или нет.
  localStorage.setItem("veloce.lang", "ru");
  listMock.mockReset();
});

afterEach(cleanup);

describe("экран ленты событий", () => {
  it("на пустой ленте говорит, что это хорошая новость", async () => {
    listMock.mockResolvedValue([]);
    draw();
    expect(await screen.findByText("Событий нет, и это хорошая новость")).toBeTruthy();
    expect(screen.getByText("всего 0")).toBeTruthy();
  });

  it("пустая ВЫБОРКА не выдаётся за пустую ленту", async () => {
    listMock.mockResolvedValue([incident("info", "Отказов входа: 4 за полминуты")]);
    draw();
    await screen.findByText("Отказов входа: 4 за полминуты");

    await clickFilter("Критично");

    await waitFor(() => {
      expect(screen.getByText("В этой важности событий нет, всего в ленте 1")).toBeTruthy();
    });
    // Главное утверждение теста: обнадёживающей формулировки быть не должно.
    expect(screen.queryByText("Событий нет, и это хорошая новость")).toBeNull();
  });

  it("счётчик замечает фильтр", async () => {
    listMock.mockResolvedValue([
      incident("critical", "Ошибок 5xx: 143 за полминуты"),
      incident("info", "Отказов входа: 4 за полминуты"),
      incident("info", "Отказов входа: 9 за полминуты"),
    ]);
    draw();
    expect(await screen.findByText("всего 3")).toBeTruthy();

    await clickFilter("Справка");

    await waitFor(() => {
      expect(screen.getByText("показано 2 из 3")).toBeTruthy();
    });
    expect(screen.queryByText("всего 3")).toBeNull();
  });

  it("название экрана печатается один раз, а не дважды подряд", async () => {
    listMock.mockResolvedValue([]);
    draw();
    await screen.findByText("всего 0");
    expect(screen.queryAllByText("События")).toHaveLength(1);
  });

  it("отказ вызова показывается, а не проглатывается", async () => {
    listMock.mockRejectedValue(new Error("нет соединения"));
    draw();
    expect(await screen.findByText("нет соединения")).toBeTruthy();
  });
});
