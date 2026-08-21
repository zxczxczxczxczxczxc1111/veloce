// Экран серверов держит единственную по-настоящему опасную развилку в панели:
// ключ хоста. Неизвестный хост и СМЕНИВШИЙСЯ ключ обязаны выглядеть и вести
// себя по-разному, иначе «доверять» одним нажатием превращает защиту в театр.
// Здесь же проверяется, что доверие уходит именно с ТЕМ отпечатком, который
// человек видел на экране.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const saveMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const deleteMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const connectMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const trustMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const forgetMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const fingerprintsMock = vi.fn<() => Promise<unknown[] | null>>();
const stateMock = vi.fn<() => Promise<string>>();

vi.mock("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service", () => ({
  ServersService: {
    Save: (...a: unknown[]) => saveMock(...a),
    Delete: (...a: unknown[]) => deleteMock(...a),
    Connect: (...a: unknown[]) => connectMock(...a),
    TrustHost: (...a: unknown[]) => trustMock(...a),
    ForgetHost: (...a: unknown[]) => forgetMock(...a),
    Fingerprints: () => fingerprintsMock(),
    State: () => stateMock(),
  },
  DiagService: { Log: () => Promise.resolve() },
}));

const { LangProvider } = await import("../i18n/LangProvider");
const { Servers } = await import("./Servers");
type Server = import("../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store").Server;

function server(o: Partial<Server> = {}): Server {
  return {
    id: "s1",
    label: "Прод",
    host: "203.0.113.10",
    port: 0,
    user: "root",
    keyPath: "",
    useAgent: true,
    tags: [],
    jumpVia: "",
    ...o,
  } as Server;
}

function draw(servers: Server[] = [server()]) {
  const onChanged = vi.fn();
  const onOpen = vi.fn();
  render(
    <LangProvider>
      <Servers servers={servers} onChanged={onChanged} onOpen={onOpen} />
    </LangProvider>,
  );
  return { onChanged, onOpen };
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
  handlers.clear();
  for (const m of [saveMock, deleteMock, connectMock, trustMock, forgetMock]) {
    m.mockReset().mockResolvedValue(undefined);
  }
  fingerprintsMock.mockReset().mockResolvedValue([]);
  stateMock.mockReset().mockResolvedValue("idle");
  vi.stubGlobal("crypto", { randomUUID: () => "новый-id" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("список", () => {
  it("без серверов говорит об этом", async () => {
    draw([]);
    await settle();
    expect(screen.getByText("Серверов пока нет")).toBeTruthy();
  });

  it("нулевой порт показывается как 22, а не как ноль", async () => {
    // Умолчание разбирает Go, но человеку надо видеть настоящее число.
    draw([server({ port: 0 })]);
    await settle();
    expect(screen.getByText("root@203.0.113.10:22")).toBeTruthy();
  });

  it("заданный порт показывается свой", async () => {
    draw([server({ port: 2222 })]);
    await settle();
    expect(screen.getByText("root@203.0.113.10:2222")).toBeTruthy();
  });

  it("бастион подписан именем того сервера, через который идём", async () => {
    draw([server({ id: "s1", jumpVia: "s2" }), server({ id: "s2", label: "Прыжок" })]);
    await settle();
    expect(screen.getAllByText("Прыжок").length).toBeGreaterThan(0);
  });

  it("новый сервер получает идентификатор здесь, а не в форме", async () => {
    const { onChanged } = draw([]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Добавить сервер" }));
    fireEvent.change(screen.getByLabelText("Хост"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Пользователь"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect((saveMock.mock.calls[0][0] as Server).id).toBe("новый-id");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("удаление", () => {
  it("первое нажатие не удаляет, а спрашивает с именем", async () => {
    draw([server({ label: "Прод" })]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));

    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Прод/ })).toBeTruthy();
  });

  it("подтверждение удаляет", async () => {
    draw([server({ id: "s7", label: "Прод" })]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить Прод?" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("s7"));
  });

  it("отказ удаления виден, а не проглатывается", async () => {
    deleteMock.mockRejectedValue(new Error("конфиг только для чтения"));
    draw([server({ label: "Прод" })]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить Прод?" }));

    expect(await screen.findByText("конфиг только для чтения")).toBeTruthy();
  });
});

describe("отпечатки ключей", () => {
  it("неподтверждённый хост подписан прямо, а не пустым местом", async () => {
    fingerprintsMock.mockResolvedValue([]);
    draw();
    await settle();
    expect(screen.getByText("Хост не подтверждён")).toBeTruthy();
  });

  it("у хоста бывает несколько ключей, и показываются ВСЕ", async () => {
    // У прода их три. Показать один значит однажды напугать ложной подменой.
    fingerprintsMock.mockResolvedValue([
      { type: "ssh-ed25519", fingerprint: "SHA256:aaa" },
      { type: "ecdsa-sha2-nistp256", fingerprint: "SHA256:bbb" },
      { type: "ssh-rsa", fingerprint: "SHA256:ccc" },
    ]);
    draw();
    await settle();

    expect(screen.getByText("SHA256:aaa")).toBeTruthy();
    expect(screen.getByText("SHA256:bbb")).toBeTruthy();
    expect(screen.getByText("SHA256:ccc")).toBeTruthy();
  });

  it("алгоритм печатается рядом с отпечатком", async () => {
    // Иначе человек сравнивает ed25519 из файла с ecdsa из диалога и делает
    // вывод о подмене там, где ничего не менялось.
    fingerprintsMock.mockResolvedValue([{ type: "ssh-ed25519", fingerprint: "SHA256:aaa" }]);
    draw();
    await settle();
    expect(screen.getByText(/ssh-ed25519/)).toBeTruthy();
  });

  it("сбой чтения отпечатков не выдаётся за «хост не подтверждён»", async () => {
    // Пустой список и отказ чтения это разные утверждения.
    fingerprintsMock.mockRejectedValue(new Error("known_hosts не читается"));
    draw();
    await settle();
    expect(await screen.findByText("known_hosts не читается")).toBeTruthy();
  });
});

describe("развилка с ключом хоста", () => {
  it("неизвестный хост даёт кнопку «доверять» с показанным отпечатком", async () => {
    draw();
    await settle();
    emit("conn:state", { serverId: "s1", state: "hostKeyUnknown", fingerprint: "SHA256:новый" });

    expect(screen.getByText(/SHA256:новый/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Доверять" }));

    // Отпечаток идёт ИМЕННО тот, что на экране: запросить его заново перед
    // вызовом значит сверять на стороне Go не с чем.
    await waitFor(() => expect(trustMock).toHaveBeenCalledWith("s1", "SHA256:новый"));
  });

  it("у СМЕНИВШЕГОСЯ ключа кнопки «доверять» нет вовсе", async () => {
    // Разницу между пересборкой сервера и подменой видит только человек.
    draw();
    await settle();
    emit("conn:state", {
      serverId: "s1", state: "hostKeyChanged",
      fingerprint: "SHA256:новый", knownFingerprint: "SHA256:старый",
    });

    expect(screen.queryByRole("button", { name: "Доверять" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Забыть ключ" }).length).toBeGreaterThan(0);
  });

  it("при смене ключа показаны ОБА отпечатка, чтобы было что сравнивать", async () => {
    draw();
    await settle();
    emit("conn:state", {
      serverId: "s1", state: "hostKeyChanged",
      fingerprint: "SHA256:новый", knownFingerprint: "SHA256:старый",
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("SHA256:новый");
    expect(text).toContain("SHA256:старый");
  });

  it("забыть старый ключ это отдельное осознанное действие", async () => {
    draw();
    await settle();
    emit("conn:state", {
      serverId: "s1", state: "hostKeyChanged",
      fingerprint: "SHA256:новый", knownFingerprint: "SHA256:старый",
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Забыть ключ" })[0]);

    await waitFor(() => expect(forgetMock).toHaveBeenCalledWith("s1"));
    expect(trustMock).not.toHaveBeenCalled();
  });

  it("в спокойном состоянии диалога про ключ нет", async () => {
    draw();
    await settle();
    expect(screen.queryByRole("button", { name: "Доверять" })).toBeNull();
  });
});

describe("состояния соединения", () => {
  it("каждый отказ подписан по-своему, общего серого «ошибка» нет", async () => {
    draw();
    await settle();

    emit("conn:state", { serverId: "s1", state: "authFailed" });
    const auth = document.body.textContent ?? "";
    expect(auth).toMatch(/ключ/i);

    emit("conn:state", { serverId: "s1", state: "jumpFailed", message: "бастион молчит" });
    expect(document.body.textContent).not.toBe(auth);
  });

  it("подключение подписано и точкой, и словом", async () => {
    draw();
    await settle();
    emit("conn:state", { serverId: "s1", state: "connecting" });
    expect(screen.getByLabelText("Подключение")).toBeTruthy();
  });

  it("кнопка подключения на время подключения выключена", async () => {
    draw();
    await settle();
    emit("conn:state", { serverId: "s1", state: "connecting" });
    expect((screen.getByRole("button", { name: "Подключиться" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("успешное подключение уводит на обзор сервера", async () => {
    const { onOpen } = draw();
    await settle();
    emit("conn:state", { serverId: "s1", state: "connected" });
    await settle();
    expect(onOpen).toHaveBeenCalledWith("s1");
  });

  it("подключение перечитывает отпечатки: known_hosts мог измениться", async () => {
    draw();
    await settle();
    fingerprintsMock.mockClear();

    emit("conn:state", { serverId: "s1", state: "connected" });
    await settle();
    expect(fingerprintsMock).toHaveBeenCalled();
  });

  it("отказ подключения виден в карточке", async () => {
    connectMock.mockRejectedValue(new Error("сеть недоступна"));
    draw();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(await screen.findByText("сеть недоступна")).toBeTruthy();
  });
});
