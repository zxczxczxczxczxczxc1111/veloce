// Панель логов отделена от потока намеренно: её можно прогнать без Go. Здесь
// проверяется то, из-за чего живой лог обычно невозможно читать - автопрокрутка,
// утаскивающая строку из-под курсора, и фильтр, съедающий отметку об обрыве.
//
// jsdom не считает раскладку, поэтому высоты подставляются руками: это честно,
// потому что проверяется РЕШЕНИЕ панели (держаться низа или нет), а не работа
// браузера.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangProvider } from "../i18n/LangProvider";
import { LogPanel } from "./LogView";
import type { LogLine } from "../state/logs";

function lines(n: number, from = 0): LogLine[] {
  return Array.from({ length: n }, (_, i) => ({ id: from + i, text: `строка ${from + i}` }));
}

function draw(props: Partial<Parameters<typeof LogPanel>[0]> = {}) {
  return render(
    <LangProvider>
      <LogPanel
        lines={lines(5)}
        paused={false}
        setPaused={() => {}}
        error={null}
        {...props}
      />
    </LangProvider>,
  );
}

// Прокручиваемый блок логов. Ищем по классу переполнения: он и есть тот
// элемент, на который повешен слушатель.
function box(): HTMLElement {
  return document.querySelector(".overflow-y-auto") as HTMLElement;
}

// jsdom всегда отдаёт нули, поэтому размеры задаём сами и шлём событие
// прокрутки руками: слушатель висит на самом элементе, а не на React.
function scrollTo(el: HTMLElement, opts: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: opts.clientHeight, configurable: true });
  el.scrollTop = opts.scrollTop;
  act(() => {
    el.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  localStorage.setItem("veloce.lang", "ru");
  // requestAnimationFrame в jsdom есть, но прокрутку хочется получить сразу.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("содержимое", () => {
  it("пустой лог говорит об этом, а не показывает пустоту", () => {
    draw({ lines: [] });
    expect(screen.getByText("Логов пока нет")).toBeTruthy();
  });

  it("ошибка вытесняет сообщение о пустоте: причина важнее", () => {
    draw({ lines: [], error: "поток не открылся" });
    expect(screen.getByText("поток не открылся")).toBeTruthy();
    expect(screen.queryByText("Логов пока нет")).toBeNull();
  });

  it("строки показываются как есть", () => {
    draw({ lines: lines(3) });
    expect(screen.getByText("строка 0")).toBeTruthy();
    expect(screen.getByText("строка 2")).toBeTruthy();
  });

  it("служебная строка отличается от строки проекта и цветом", () => {
    // Спутать «панель говорит» с «сервис говорит» нельзя.
    const { container } = draw({
      lines: [{ id: 1, text: "поток прерван", system: true }, { id: 2, text: "обычная" }],
    });
    const mark = screen.getByText("поток прерван").parentElement!;
    expect(mark.className).toContain("text-accent");
    expect(container.querySelector(".text-fg-secondary")?.textContent).toBe("обычная");
  });

  it("ожидание подъёма подписано прямо в шапке", () => {
    draw({ waiting: true });
    expect(screen.getByText("ждём возобновления")).toBeTruthy();
  });
});

describe("фильтр", () => {
  it("считает показанное и общее раздельно", () => {
    draw({ lines: lines(5) });
    expect(screen.getByText("5 из 5")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Фильтр"), { target: { value: "строка 1" } });
    expect(screen.getByText("1 из 5")).toBeTruthy();
  });

  it("отбирает по подстроке без учёта регистра", () => {
    draw({
      lines: [
        { id: 1, text: "ERROR: всё плохо" },
        { id: 2, text: "info: всё хорошо" },
      ],
    });
    const input = screen.getByLabelText("Фильтр");
    fireEvent.change(input, { target: { value: "error" } });

    expect(screen.getByText("ERROR: всё плохо")).toBeTruthy();
    expect(screen.queryByText("info: всё хорошо")).toBeNull();
  });

  it("служебные строки фильтр НЕ прячет: обрыв это часть картины", () => {
    draw({
      lines: [
        { id: 1, text: "поток прерван", system: true },
        { id: 2, text: "обычная строка" },
      ],
    });
    const input = screen.getByLabelText("Фильтр");
    fireEvent.change(input, { target: { value: "ничего-не-найдётся" } });

    expect(screen.getByText("поток прерван")).toBeTruthy();
    expect(screen.queryByText("обычная строка")).toBeNull();
  });

  it("пробелы вокруг запроса не считаются запросом", () => {
    draw({ lines: lines(3) });
    const input = screen.getByLabelText("Фильтр");
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByText("строка 0")).toBeTruthy();
  });
});

describe("пауза", () => {
  it("подпись кнопки говорит, что случится, а не что происходит", () => {
    const setPaused = vi.fn();
    const { rerender } = draw({ paused: false, setPaused });
    expect(screen.getByRole("button", { name: "Пауза" })).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Пауза" }).click());
    expect(setPaused).toHaveBeenCalledWith(true);

    rerender(
      <LangProvider>
        <LogPanel lines={lines(5)} paused setPaused={setPaused} error={null} />
      </LangProvider>,
    );
    expect(screen.getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });
});

describe("автопрокрутка", () => {
  it("пока человек внизу, кнопки возврата нет", () => {
    draw({ lines: lines(5) });
    expect(screen.queryByRole("button", { name: /вниз|нов/i })).toBeNull();
  });

  it("ушёл вверх - автопрокрутка отключилась и появилась кнопка", () => {
    // Без этого прочитать что-либо в живом логе физически невозможно.
    draw({ lines: lines(5) });
    scrollTo(box(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    expect(screen.getByRole("button", { name: /вниз|нов/i })).toBeTruthy();
  });

  it("отставание в пределах допуска всё ещё считается «в конце»", () => {
    // Ноль сюда ставить нельзя: субпиксельные высоты строк отключали бы
    // автопрокрутку сами собой.
    draw({ lines: lines(5) });
    scrollTo(box(), { scrollTop: 780, scrollHeight: 1000, clientHeight: 200 });
    expect(screen.queryByRole("button", { name: /вниз|нов/i })).toBeNull();
  });

  it("новые строки, пришедшие пока человек читал выше, посчитаны", () => {
    const { rerender } = draw({ lines: lines(5) });
    scrollTo(box(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });

    rerender(
      <LangProvider>
        <LogPanel lines={lines(8)} paused={false} setPaused={() => {}} error={null} />
      </LangProvider>,
    );

    // Три новые строки, и число обязано стоять на кнопке: без него непонятно,
    // вернуться сейчас или дочитать.
    expect(screen.getByRole("button", { name: /3 нов/i })).toBeTruthy();
  });

  it("возврат вниз гасит счётчик и убирает кнопку", () => {
    const { rerender } = draw({ lines: lines(5) });
    scrollTo(box(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    rerender(
      <LangProvider>
        <LogPanel lines={lines(9)} paused={false} setPaused={() => {}} error={null} />
      </LangProvider>,
    );
    expect(screen.getByRole("button", { name: /4 нов/i })).toBeTruthy();

    act(() => screen.getByRole("button", { name: /4 нов/i }).click());
    expect(screen.queryByRole("button", { name: /вниз|нов/i })).toBeNull();
  });

  it("вернулся вниз колесом - кнопка уходит сама", () => {
    draw({ lines: lines(5) });
    scrollTo(box(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    expect(screen.getByRole("button", { name: /вниз|нов/i })).toBeTruthy();

    scrollTo(box(), { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    expect(screen.queryByRole("button", { name: /вниз|нов/i })).toBeNull();
  });
});
