// Рейка серверов это единственное место, откуда беда зовёт к себе: счётчик
// непрочитанных событий должен быть виден с любого экрана и вести в ленту, а
// не выделять сервер. Плюс поиск, который на двух десятках машин уже быстрее
// глаз, и переключатель языка, живущий тут же вместо отдельного экрана.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangProvider } from "../../i18n/LangProvider";
import { ServerRail } from "./ServerRail";
import type { Server } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";

function server(o: Partial<Server> = {}): Server {
  return {
    id: "s1",
    label: "Прод",
    host: "203.0.113.10",
    user: "root",
    tags: [],
    ...o,
  } as Server;
}

function draw(props: Partial<Parameters<typeof ServerRail>[0]> = {}) {
  const onSelect = vi.fn();
  const onAdd = vi.fn();
  const onEvents = vi.fn();
  render(
    <LangProvider>
      <ServerRail
        servers={[server()]}
        activeId={null}
        onSelect={onSelect}
        onAdd={onAdd}
        unread={{}}
        onEvents={onEvents}
        {...props}
      />
    </LangProvider>,
  );
  return { onSelect, onAdd, onEvents };
}

beforeEach(() => localStorage.setItem("veloce.lang", "ru"));
afterEach(cleanup);

describe("список серверов", () => {
  it("без серверов говорит об этом, а не показывает пустоту", () => {
    draw({ servers: [] });
    expect(screen.getByText("Серверов пока нет")).toBeTruthy();
  });

  it("показывает метку, а хост подписью", () => {
    draw({ servers: [server({ label: "Прод", host: "203.0.113.10", user: "root" })] });
    expect(screen.getByText("Прод")).toBeTruthy();
    expect(screen.getByText("root@203.0.113.10")).toBeTruthy();
  });

  it("без метки главной строкой становится хост", () => {
    // Пустая строка вместо имени сервера это худшее, что тут может быть.
    draw({ servers: [server({ label: "", host: "10.0.0.5" })] });
    expect(screen.getAllByText("10.0.0.5").length).toBeGreaterThan(0);
  });

  it("без учётной записи собачка не печатается", () => {
    draw({ servers: [server({ user: "", host: "10.0.0.5" })] });
    expect(screen.queryByText("@10.0.0.5")).toBeNull();
    expect(screen.getByText("10.0.0.5")).toBeTruthy();
  });

  it("выбранный сервер помечен для читателя, а не только цветом", () => {
    draw({ servers: [server({ id: "s1" })], activeId: "s1" });
    expect(screen.getByRole("button", { name: /Прод/ }).getAttribute("aria-current")).toBe("true");
  });

  it("выбор сообщает наверх идентификатор", () => {
    const { onSelect } = draw({ servers: [server({ id: "s7" })] });
    fireEvent.click(screen.getByRole("button", { name: /Прод/ }));
    expect(onSelect).toHaveBeenCalledWith("s7");
  });

  it("кнопка добавления подписана для диктора, а не только плюсом", () => {
    const { onAdd } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Добавить сервер" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("поиск", () => {
  const many = [
    server({ id: "a", label: "Прод", host: "203.0.113.10", tags: ["prod"] }),
    server({ id: "b", label: "Стенд", host: "test.local", tags: ["staging", "тест"] }),
  ];

  it("ищет по метке", () => {
    draw({ servers: many });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "стенд" } });
    expect(screen.getByText("Стенд")).toBeTruthy();
    expect(screen.queryByText("Прод")).toBeNull();
  });

  it("ищет по хосту", () => {
    draw({ servers: many });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "89.125" } });
    expect(screen.getByText("Прод")).toBeTruthy();
    expect(screen.queryByText("Стенд")).toBeNull();
  });

  it("ищет по тегам", () => {
    draw({ servers: many });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "staging" } });
    expect(screen.getByText("Стенд")).toBeTruthy();
    expect(screen.queryByText("Прод")).toBeNull();
  });

  it("не различает регистр", () => {
    draw({ servers: many });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "ПРОД" } });
    expect(screen.getByText("Прод")).toBeTruthy();
  });

  it("ничего не найдено это тоже сообщение", () => {
    draw({ servers: many });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "марс" } });
    expect(screen.getByText("Серверов пока нет")).toBeTruthy();
  });

  it("сервер без тегов не роняет поиск", () => {
    draw({ servers: [server({ tags: null as never })] });
    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "прод" } });
    expect(screen.getByText("Прод")).toBeTruthy();
  });
});

describe("счётчик событий", () => {
  it("нуля не показывает: пустой значок это шум", () => {
    draw({ servers: [server({ id: "s1" })], unread: { s1: 0 } });
    expect(screen.queryByText("0")).toBeNull();
  });

  it("непрочитанное видно числом", () => {
    draw({ servers: [server({ id: "s1" })], unread: { s1: 7 } });
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("клик по счётчику ведёт в ленту, а НЕ выделяет сервер", () => {
    // Иначе беда зовёт к себе и промахивается.
    const { onEvents, onSelect } = draw({ servers: [server({ id: "s1" })], unread: { s1: 3 } });
    fireEvent.click(screen.getByText("3"));
    expect(onEvents).toHaveBeenCalledWith("s1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("до счётчика можно добраться с клавиатуры", () => {
    const { onEvents, onSelect } = draw({ servers: [server({ id: "s1" })], unread: { s1: 3 } });
    fireEvent.keyDown(screen.getByText("3"), { key: "Enter" });
    expect(onEvents).toHaveBeenCalledWith("s1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("посторонняя клавиша на счётчике никуда не ведёт", () => {
    const { onEvents } = draw({ servers: [server({ id: "s1" })], unread: { s1: 3 } });
    fireEvent.keyDown(screen.getByText("3"), { key: "a" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("счётчик чужого сервера на этот не попадает", () => {
    draw({ servers: [server({ id: "s1" })], unread: { s2: 9 } });
    expect(screen.queryByText("9")).toBeNull();
  });
});

describe("язык", () => {
  it("текущий язык отмечен нажатым, а не только цветом", () => {
    draw();
    expect(screen.getByRole("button", { name: "ru" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "en" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("переключение меняет язык интерфейса на месте", () => {
    draw({ servers: [] });
    expect(screen.getByText("Серверов пока нет")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "en" }));
    expect(screen.getByText("No servers yet")).toBeTruthy();
  });

  it("выбор языка переживает перезапуск: он лежит в localStorage", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: "en" }));
    expect(localStorage.getItem("veloce.lang")).toBe("en");
  });
});
