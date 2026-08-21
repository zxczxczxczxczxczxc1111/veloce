// Мелкие детали, на которых держится честность экрана: прочерк вместо нуля,
// возраст данных, фокус на «Отмене», линия, которая не дорисовывается по
// непрочитанной метрике. Каждая из них уже названа в спеке как то, что
// отличает панель наблюдения от красивой картинки.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LangProvider } from "../i18n/LangProvider";
import { ContentState } from "./ui/ContentState";
import { TickAge } from "./TickAge";
import { ConfirmDialog } from "./ConfirmDialog";
import { MetricTile, Meter } from "./MetricTile";
import { Sparkline } from "./Sparkline";

function draw(node: ReactNode) {
  return render(<LangProvider>{node}</LangProvider>);
}

beforeEach(() => localStorage.setItem("veloce.lang", "ru"));
afterEach(cleanup);

describe("ContentState", () => {
  it("скелет честен ровно один раз: когда показывать нечего", () => {
    draw(
      <ContentState pending fetching={false} skeleton={<i>скелет</i>}>
        <b>данные</b>
      </ContentState>,
    );
    expect(screen.getByText("скелет")).toBeTruthy();
    expect(screen.queryByText("данные")).toBeNull();
  });

  it("при обновлении данные остаются на месте, а не подменяются плашками", () => {
    // Подменять уже показанное серым значит выбрасывать информацию.
    const { container } = draw(
      <ContentState pending={false} fetching skeleton={<i>скелет</i>}>
        <b>данные</b>
      </ContentState>,
    );
    expect(screen.getByText("данные")).toBeTruthy();
    expect(screen.queryByText("скелет")).toBeNull();
    // Приглушение, а не исчезновение.
    expect((container.firstChild as HTMLElement).style.opacity).toBe("0.4");
  });

  it("спокойное состояние показывает данные в полную силу", () => {
    const { container } = draw(
      <ContentState pending={false} fetching={false} skeleton={<i>скелет</i>}>
        <b>данные</b>
      </ContentState>,
    );
    expect((container.firstChild as HTMLElement).style.opacity).toBe("1");
  });
});

describe("возраст данных", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("без тактов говорит об этом прямо, а не показывает ноль секунд", () => {
    draw(<TickAge at={0} />);
    expect(screen.getByText("тактов ещё не было")).toBeTruthy();
  });

  it("свежие данные подписаны спокойно", () => {
    draw(<TickAge at={1_700_000_000_000 - 2_000} />);
    const el = screen.getByText("обновлено 2 с назад");
    expect(el.className).toContain("text-fg-muted");
    expect(el.className).not.toContain("text-accent");
  });

  it("после десяти секунд молчания подпись становится тревожной", () => {
    // Застывшие цифры, выглядящие живыми, это худший из отказов.
    draw(<TickAge at={1_700_000_000_000 - 11_000} />);
    expect(screen.getByText("обновлено 11 с назад").className).toContain("text-accent");
  });

  it("считает своё время: когда такты прекратились, перерисовывать некому", () => {
    draw(<TickAge at={1_700_000_000_000} />);
    expect(screen.getByText("обновлено 0 с назад")).toBeTruthy();

    // Часы переводим на 15 секунд вперёд, и прокрутка таймера добавляет свою
    // секунду сверху: тик обязан случиться, иначе подпись не пересчитается.
    act(() => {
      vi.setSystemTime(1_700_000_015_000);
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText("обновлено 16 с назад").className).toContain("text-accent");
  });
});

describe("подтверждение действия", () => {
  it("заголовок несёт имя проекта, своего текста у диалога нет", () => {
    draw(
      <ConfirmDialog
        title="Перезапустить demo-worker?"
        confirmLabel="Перезапустить"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Перезапустить demo-worker?",
    );
    expect(screen.getByText("Перезапустить demo-worker?")).toBeTruthy();
  });

  it("фокус стоит на отмене, а не на подтверждении", () => {
    // Пробел или Enter по привычке не должны перезапускать чужой прод.
    draw(
      <ConfirmDialog title="Перезапустить прод?" confirmLabel="Перезапустить"
        onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(document.activeElement?.textContent).toBe("Отмена");
  });

  it("Escape отменяет", () => {
    const onCancel = vi.fn();
    draw(
      <ConfirmDialog title="Перезапустить прод?" confirmLabel="Перезапустить"
        onConfirm={() => {}} onCancel={onCancel} />,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("другая клавиша ничего не отменяет", () => {
    const onCancel = vi.fn();
    draw(
      <ConfirmDialog title="Перезапустить прод?" confirmLabel="Перезапустить"
        onConfirm={() => {}} onCancel={onCancel} />,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("клик по подложке это отмена, клик по самому окну нет", () => {
    const onCancel = vi.fn();
    const { container } = draw(
      <ConfirmDialog title="Перезапустить прод?" confirmLabel="Перезапустить"
        onConfirm={() => {}} onCancel={onCancel} />,
    );
    act(() => {
      screen.getByRole("dialog").click();
    });
    expect(onCancel).not.toHaveBeenCalled();

    act(() => {
      (container.firstChild as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("подтверждение зовёт подтверждение, и только его", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    draw(
      <ConfirmDialog title="Перезапустить прод?" confirmLabel="Перезапустить"
        onConfirm={onConfirm} onCancel={onCancel} />,
    );
    act(() => {
      screen.getByRole("button", { name: "Перезапустить" }).click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("плитка метрики", () => {
  it("непрочитанная метрика это прочерк, а не ноль", () => {
    draw(<MetricTile label="Процессор" value={null} points={[1, 2, 3]} />);
    expect(screen.getByText("-")).toBeTruthy();
  });

  it("у непрочитанной метрики линия не дорисовывается", () => {
    // Последняя точка осталась бы висеть как «всё по-прежнему».
    const { container } = draw(<MetricTile label="Процессор" value={null} points={[1, 2, 3]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("приписка прячется вместе с недоступным значением", () => {
    draw(<MetricTile label="Память" value={null} note="из 16 ГБ" />);
    expect(screen.queryByText("из 16 ГБ")).toBeNull();
  });

  it("прочитанная метрика показывает и число, и линию, и приписку", () => {
    const { container } = draw(
      <MetricTile label="Память" value="8.0 ГБ" note="из 16 ГБ" points={[1, 2, 3]} />,
    );
    expect(screen.getByText("8.0 ГБ")).toBeTruthy();
    expect(screen.getByText("из 16 ГБ")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("честный ноль это ноль, а не прочерк", () => {
    draw(<MetricTile label="Процессор" value="0.0%" points={[0, 0]} />);
    expect(screen.getByText("0.0%")).toBeTruthy();
    expect(screen.queryByText("-")).toBeNull();
  });
});

describe("уровень", () => {
  it("не вылезает за края ни вверх, ни вниз", () => {
    // Сравниваем число, а не строку: jsdom нормализует «100.0%» в «100%», и
    // проверка строки ловила бы форматирование браузера, а не обрезку.
    const fill = (c: HTMLElement) =>
      parseFloat((c.firstElementChild!.firstElementChild as HTMLElement).style.width);

    expect(fill(draw(<Meter percent={140} />).container)).toBe(100);
    expect(fill(draw(<Meter percent={-20} />).container)).toBe(0);
    expect(fill(draw(<Meter percent={37.25} />).container)).toBeCloseTo(37.3, 1);
  });
});

describe("спарклайн", () => {
  it("одной точкой линию не строит: плитка не должна прыгать на втором такте", () => {
    const { container } = draw(<Sparkline points={[5]} max={100} label="Процессор" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("линия немая без подписи, и подпись обязана быть", () => {
    draw(<Sparkline points={[1, 2]} max={100} label="Процессор" />);
    expect(screen.getByRole("img", { name: "Процессор" })).toBeTruthy();
  });

  it("фиксированная ось не рисует панику на спокойном сервере", () => {
    // Два значения по полпроцента при оси 0-100 обязаны лежать у самого низа.
    const { container } = draw(<Sparkline points={[0.4, 0.6]} max={100} label="Процессор" />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThan(37);
  });

  it("плавающая ось растягивает окно по своему максимуму", () => {
    const { container } = draw(<Sparkline points={[0, 1000]} max={null} label="Сеть" />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBe(38);
    expect(Math.min(...ys)).toBe(2);
  });

  it("значение выше потолка обрезается, а не улетает за рамку", () => {
    const { container } = draw(<Sparkline points={[0, 250]} max={100} label="Процессор" />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(2);
  });
});
