import { Events } from "@wailsio/runtime";
import { useEffect, useRef, useState } from "react";
import type { ConnEvent } from "./events";
import { diag } from "./diag";
import {
  LogsService,
  MetricsService,
  ProjectsService,
  ServersService,
} from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";

// Видов ровно столько, сколько их в спеке разделе 10, и каждый рисуется
// по-своему. Свалить всё в один "failed" значит показать штатный сбой такта
// так же, как фатальный отказ ключа.
export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "degraded"; message: string; lastOkAt: number }
  | { kind: "disconnected" }
  | { kind: "authFailed" }
  | { kind: "jumpFailed"; message: string }
  | { kind: "hostKeyUnknown"; fingerprint: string }
  // hostKeyChanged отделён от hostKeyUnknown намеренно: у неизвестного хоста
  // уместна кнопка «доверять», а у сменившегося ключа человек обязан сравнить
  // два отпечатка. Одна кнопка на оба случая и есть та самая дыра.
  | { kind: "hostKeyChanged"; fingerprint: string; known: string };

export function useConnState(serverId: string | null): ConnState {
  const [state, setState] = useState<ConnState>({ kind: "idle" });
  const lastOk = useRef(0);

  useEffect(() => {
    if (serverId === null) return;
    // Смена сервера обязана сбрасывать состояние: иначе «на связи» от
    // предыдущего сервера висит на новом до первого его события.
    setState({ kind: "idle" });

    // Спрашиваем текущее состояние СРАЗУ. Подписка ловит только будущее, а
    // «подключились» вполне могло прилететь до того, как экран открылся: тогда
    // живой сервер числился бы отключённым, и такты не запустились бы вообще.
    let alive = true;
    void (async () => {
      try {
        const now = await ServersService.State(serverId);
        diag(`useConnState: спросили состояние сервера ${serverId}: ${now}`);
        // Ответ мог опоздать: событие, пришедшее за это время, свежее.
        setState((prev) =>
          prev.kind === "idle" && now === "connected" ? { kind: "connected" } : prev,
        );
      } catch {
        // Молчим: отсутствие ответа это не состояние соединения, а сбой
        // биндинга, и подменять им реальное состояние нельзя.
      }
      if (!alive) return;
    })();

    const off = Events.On("conn:state", (e: { data: ConnEvent }) => {
      if (e.data.serverId !== serverId) return;
      diag(`conn:state получено: ${e.data.state}`);
      switch (e.data.state) {
        case "connecting":
          setState({ kind: "connecting" });
          break;
        case "connected":
          lastOk.current = Date.now();
          setState({ kind: "connected" });
          break;
        case "degraded":
          // Такт не удался, но соединение может быть живо. Показываем время
          // последнего успешного замера, а не «всё сломалось».
          setState((prev) =>
            // Вопрос про ключ хоста важнее: его нельзя затирать сбоем такта,
            // иначе диалог с отпечатком исчезнет из-под пользователя.
            prev.kind === "hostKeyUnknown" || prev.kind === "hostKeyChanged"
              ? prev
              : {
                  kind: "degraded",
                  message: e.data.message ?? "",
                  lastOkAt: lastOk.current,
                },
          );
          break;
        case "authFailed":
          setState({ kind: "authFailed" });
          break;
        case "jumpFailed":
          setState({ kind: "jumpFailed", message: e.data.message ?? "" });
          break;
        case "hostKeyUnknown":
          setState({ kind: "hostKeyUnknown", fingerprint: e.data.fingerprint ?? "" });
          break;
        case "hostKeyChanged":
          setState({
            kind: "hostKeyChanged",
            fingerprint: e.data.fingerprint ?? "",
            known: e.data.knownFingerprint ?? "",
          });
          break;
        default:
          setState({ kind: "disconnected" });
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [serverId]);

  return state;
}

// Состояния, при которых такты бессмысленны: ключ не станет верным от
// повторной попытки, а неподтверждённый хост ждёт решения человека. Всё
// остальное лечится временем, и такт обязан продолжаться.
function isFatal(kind: ConnState["kind"]): boolean {
  return kind === "authFailed" || kind === "hostKeyUnknown" || kind === "hostKeyChanged";
}

// useServerTickers запускает такты и гасит их при уходе с сервера.
//
// Без этого хука тикеры не запускаются ВООБЩЕ: событий metrics:tick и
// projects:tick не будет, и экран обзора останется пустым навсегда.
//
// Ключевое: НЕ останавливать такты на degraded и disconnected. Раньше в
// зависимостях стоял `state.kind`, и это давало два тупика сразу.
//
// Первый: один неудачный такт шлёт degraded, эффект гасит тикеры, тактов
// больше нет, значит и события connected больше никогда не придёт - панель
// замирает навсегда и молчит об этом.
//
// Второй: переподключение в транспорте запускается ПОПЫТКОЙ выполнить
// команду. Погасив такты при обрыве, мы убираем единственное, что эти попытки
// делает, и соединение не восстановится само никогда.
export function useServerTickers(serverId: string | null, state: ConnState): void {
  // Признак «такты взведены» ЗАЩЁЛКИВАЕТСЯ на подключении и держится дальше.
  //
  // Просто «состояние не idle» тут не годится: оно истинно уже на
  // «подключаемся», такты стартуют до появления соединения, получают отказ, а
  // когда соединение появляется, признак не меняется - и эффект больше не
  // перезапускается. Такты не идут вообще, а экран об этом молчит.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false); // другой сервер - свои такты
  }, [serverId]);

  useEffect(() => {
    // Ключ не примут и хост не подтвердят от повторной попытки: тут такты
    // бессмысленны, и признак снимается.
    if (isFatal(state.kind)) {
      setArmed(false);
      return;
    }
    // Взводим ТОЛЬКО когда соединение точно есть.
    if (state.kind === "connected") setArmed(true);
    // degraded и disconnected признак НЕ снимают: первый значит «такт не
    // удался», второй лечится переподключением, которое запускается как раз
    // попыткой выполнить команду, то есть тактом.
  }, [state.kind]);

  const run = serverId !== null && armed;

  useEffect(() => {
    diag(`useServerTickers: сервер=${serverId ?? "нет"} такты нужны=${run}`);
    if (serverId === null || !run) return;
    void MetricsService.Start(serverId).catch((e) =>
      diag(`MetricsService.Start отказ: ${String(e)}`),
    );
    void ProjectsService.Start(serverId).catch((e) =>
      diag(`ProjectsService.Start отказ: ${String(e)}`),
    );
    return () => {
      diag(`useServerTickers: гасим такты сервера ${serverId}`);
      void MetricsService.Stop(serverId);
      void ProjectsService.Stop(serverId);
      void LogsService.StopServer(serverId);
    };
    // В зависимостях булево, а не вид состояния: смена degraded на connected и
    // обратно не должна дёргать такты вовсе.
  }, [serverId, run]);
}
