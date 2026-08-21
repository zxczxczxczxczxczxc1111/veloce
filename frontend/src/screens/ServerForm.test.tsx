// Форма сервера. Главное здесь не поля, а два обещания: пароля тут нет и не
// появится, и сам себя бастионом сервер выбрать не может. Плюс порт, который
// обязан стираться: number-состояние превращает пустое поле в NaN, и человек
// не может набрать новое значение.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangProvider } from "../i18n/LangProvider";
import { ServerForm } from "./ServerForm";
import type { Server } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";

function server(o: Partial<Server> = {}): Server {
  return {
    id: "s1",
    label: "Прод",
    host: "203.0.113.10",
    port: 22,
    user: "root",
    keyPath: "C:\\Users\\xd\\.ssh\\id_ed25519",
    useAgent: false,
    tags: ["prod"],
    jumpVia: "",
    ...o,
  } as Server;
}

function draw(props: Partial<Parameters<typeof ServerForm>[0]> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <LangProvider>
      <ServerForm server={null} servers={[]} onSave={onSave} onCancel={onCancel} {...props} />
    </LangProvider>,
  );
  return { onSave, onCancel };
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
}

beforeEach(() => localStorage.setItem("veloce.lang", "ru"));
afterEach(cleanup);

describe("обещания формы", () => {
  it("поля для пароля нет вообще", () => {
    // Публичный инструмент, складывающий чужой приватный ключ себе в
    // настройки, живёт до первого поста на Reddit.
    draw();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("и об этом сказано прямо на экране", () => {
    draw();
    expect(screen.getByText(/парол/i)).toBeTruthy();
  });

  it("поле учётной записи подписано, чтобы не спутать с именем ключа", () => {
    // Сервер на такую путаницу отвечает сухим «ключ не принят».
    draw();
    expect(screen.getByLabelText("Пользователь")).toBeTruthy();
    expect(screen.getByText(/учётная запись/i)).toBeTruthy();
  });
});

describe("проверка обязательных полей", () => {
  it("до первой попытки поля не краснеют", () => {
    draw();
    expect(screen.getByLabelText("Хост").getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByLabelText("Пользователь").getAttribute("aria-invalid")).toBe("false");
  });

  it("пустой хост не сохраняется и подсвечивается", () => {
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    save();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Хост").getAttribute("aria-invalid")).toBe("true");
  });

  it("пустая учётная запись не сохраняется", () => {
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Пользователь").getAttribute("aria-invalid")).toBe("true");
  });

  it("одни пробелы это не значение", () => {
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "  " } });
    save();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("заполненная форма уходит наверх с обрезанными пробелами", () => {
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "  10.0.0.1  " } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: " root " } });
    save();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ host: "10.0.0.1", user: "root" });
  });
});

describe("порт", () => {
  it("принимает только цифры", () => {
    draw();
    const port = screen.getByLabelText("Порт") as HTMLInputElement;
    fireEvent.change(port, { target: { value: "2a2b" } });
    expect(port.value).toBe("22");
  });

  it("стирается полностью: иначе новое значение не набрать", () => {
    draw({ server: server({ port: 2222 }) });
    const port = screen.getByLabelText("Порт") as HTMLInputElement;
    expect(port.value).toBe("2222");

    fireEvent.change(port, { target: { value: "" } });
    expect(port.value).toBe("");
  });

  it("пустой порт уходит нулём: умолчание 22 разбирает Go, а не форма", () => {
    // Два места с одним правилом разъезжаются.
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    save();
    expect(onSave.mock.calls[0][0].port).toBe(0);
  });

  it("нулевой порт из хранилища показывается пустым полем, а не нулём", () => {
    draw({ server: server({ port: 0 }) });
    expect((screen.getByLabelText("Порт") as HTMLInputElement).value).toBe("");
  });
});

describe("теги", () => {
  it("разбираются по запятой без пустышек", () => {
    const { onSave } = draw();
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText("Теги"), { target: { value: " prod , , тест ," } });
    save();
    expect(onSave.mock.calls[0][0].tags).toEqual(["prod", "тест"]);
  });

  it("существующие теги показываются строкой", () => {
    draw({ server: server({ tags: ["prod", "web"] }) });
    expect((screen.getByLabelText("Теги") as HTMLInputElement).value).toBe("prod, web");
  });
});

describe("бастион", () => {
  it("сам себя выбрать нельзя: цепочка сомкнулась бы на себе", () => {
    const me = server({ id: "s1", label: "Я" });
    const other = server({ id: "s2", label: "Другой" });
    draw({ server: me, servers: [me, other] });

    const options = [...screen.getByLabelText("Через бастион").querySelectorAll("option")];
    expect(options.map((o) => o.textContent)).not.toContain("Я");
    expect(options.map((o) => o.textContent)).toContain("Другой");
  });

  it("у нового сервера кандидатами идут все имеющиеся", () => {
    draw({ server: null, servers: [server({ id: "s1", label: "Первый" })] });
    const options = [...screen.getByLabelText("Через бастион").querySelectorAll("option")];
    expect(options.map((o) => o.textContent)).toContain("Первый");
  });

  it("бастион без метки подписан хостом", () => {
    draw({ server: null, servers: [server({ id: "s1", label: "", host: "10.0.0.9" })] });
    const options = [...screen.getByLabelText("Через бастион").querySelectorAll("option")];
    expect(options.map((o) => o.textContent)).toContain("10.0.0.9");
  });

  it("выбранный бастион уезжает вместе с формой", () => {
    const { onSave } = draw({ server: null, servers: [server({ id: "s9", label: "Прыжок" })] });
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText("Через бастион"), { target: { value: "s9" } });
    save();
    expect(onSave.mock.calls[0][0].jumpVia).toBe("s9");
  });
});

describe("создание против правки", () => {
  it("новый сервер уходит с пустым идентификатором", () => {
    // Идентификатор выдаёт вызывающий: форма ничего не знает про хранилище.
    const { onSave } = draw({ server: null });
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    save();
    expect(onSave.mock.calls[0][0].id).toBe("");
  });

  it("правка сохраняет прежний идентификатор", () => {
    const { onSave } = draw({ server: server({ id: "s42" }) });
    save();
    expect(onSave.mock.calls[0][0].id).toBe("s42");
  });

  it("отмена ничего не сохраняет", () => {
    const { onSave, onCancel } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("у нового сервера агент включён по умолчанию", () => {
    // Ключи живут в агенте OpenSSH, и это основной путь.
    draw({ server: null });
    expect((screen.getByLabelText(/агент/i) as HTMLInputElement).checked).toBe(true);
  });
});
