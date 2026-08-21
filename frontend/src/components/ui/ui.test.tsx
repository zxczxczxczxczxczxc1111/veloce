// Базовые кирпичи. Проверяется не внешность, а то, из-за чего они вообще
// написаны своими руками: метка, связанная с полем через id (обёртка ломает
// клик в webview), и ошибка, видимая не только красной рамкой.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangProvider } from "../../i18n/LangProvider";
import { Field } from "./Field";
import { Button } from "./Button";
import { Card } from "./Card";

function draw(node: React.ReactNode) {
  return render(<LangProvider>{node}</LangProvider>);
}

beforeEach(() => localStorage.setItem("veloce.lang", "ru"));
afterEach(cleanup);

describe("поле ввода", () => {
  it("метка связана с полем, а не обёрнута вокруг", () => {
    // Обёртка ломает клик по подписи в webview и не читается диктором.
    draw(<Field label="Хост" value="" onChange={() => {}} />);
    const input = screen.getByLabelText("Хост");
    expect(input.tagName).toBe("INPUT");
  });

  it("два поля на экране не делят один идентификатор", () => {
    draw(
      <>
        <Field label="Хост" value="" onChange={() => {}} />
        <Field label="Порт" value="" onChange={() => {}} />
      </>,
    );
    const a = screen.getByLabelText("Хост").id;
    const b = screen.getByLabelText("Порт").id;
    expect(a).not.toBe(b);
    expect(a).not.toBe("");
  });

  it("подсказка видна под полем", () => {
    draw(<Field label="Health-check" hint="пусто - проверки нет" value="" onChange={() => {}} />);
    expect(screen.getByText("пусто - проверки нет")).toBeTruthy();
  });

  it("ошибка помечена не только рамкой, но и для диктора", () => {
    draw(<Field label="Хост" invalid hint="хост обязателен" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Хост").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("хост обязателен").className).toContain("text-down");
  });

  it("спокойное поле не притворяется ошибочным", () => {
    draw(<Field label="Хост" hint="адрес или имя" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Хост").getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByText("адрес или имя").className).not.toContain("text-down");
  });

  it("остальные свойства доезжают до самого поля", () => {
    draw(<Field label="Хост" placeholder="example.com" value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText("example.com")).toBeTruthy();
  });

  it("ввод доходит до обработчика", () => {
    const onChange = vi.fn();
    draw(<Field label="Хост" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    expect(onChange).toHaveBeenCalled();
  });
});

describe("кнопка", () => {
  it("нажатие доходит", () => {
    const onClick = vi.fn();
    draw(<Button onClick={onClick}>Перезапустить</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("отключённая кнопка не срабатывает", () => {
    const onClick = vi.fn();
    draw(<Button disabled onClick={onClick}>Перезапускаю</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Перезапускаю" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("ссылку на узел можно получить снаружи: на этом держится фокус в диалоге", () => {
    let node: HTMLButtonElement | null = null;
    draw(<Button ref={(el) => { node = el; }}>Отмена</Button>);
    expect(node).not.toBeNull();
    expect((node as unknown as HTMLButtonElement).tagName).toBe("BUTTON");
  });
});

describe("карточка", () => {
  it("без заголовка это просто тело: лишней шапки не рисуется", () => {
    const { container } = draw(<Card>содержимое</Card>);
    expect(container.querySelector("header")).toBeNull();
    expect(screen.getByText("содержимое")).toBeTruthy();
  });

  it("заголовок и действия живут в шапке", () => {
    draw(
      <Card title="События" actions={<button>Все</button>}>
        содержимое
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "События" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Все" })).toBeTruthy();
  });

  it("действия без заголовка не показываются вовсе", () => {
    // Шапки нет, значит и класть их некуда: молча терять лучше, чем ронять.
    draw(<Card actions={<button>Все</button>}>содержимое</Card>);
    expect(screen.queryByRole("button", { name: "Все" })).toBeNull();
  });
});
