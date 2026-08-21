import { Events } from "@wailsio/runtime";
import { useEffect, useRef, useState } from "react";
import {
  LogsService,
  MetricsService,
  ProjectsService,
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

type ConnEvent = {
  serverId: string;
  state: string;
  fingerprint?: string;
  knownFingerprint?: string;
  message?: string;
};

export function useConnState(serverId: string | null): ConnState {
  const [state, setState] = useState<ConnState>({ kind: "idle" });
  const lastOk = useRef(0);

  useEffect(() => {
    if (serverId === null) return;
    // Смена сервера обязана сбрасывать состояние: иначе «на связи» от
    // предыдущего сервера висит на новом до первого его события.
    setState({ kind: "idle" });

    const off = Events.On("conn:state", (e: { data: ConnEvent }) => {
      if (e.data.serverId !== serverId) return;
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
      off();
    };
  }, [serverId]);

  return state;
}

// useServerTickers запускает такты после подключения и гасит их при уходе.
//
// Без этого хука тикеры не запускаются ВООБЩЕ: событий metrics:tick и
// projects:tick не будет, и экран обзора останется пустым навсегда. Обратная
// сторона так же обязательна: не остановив такты, мы продолжаем дёргать
// мёртвое соединение.
export function useServerTickers(serverId: string | null, state: ConnState): void {
  useEffect(() => {
    if (serverId === null || state.kind !== "connected") return;
    void MetricsService.Start(serverId);
    void ProjectsService.Start(serverId);
    return () => {
      void MetricsService.Stop(serverId);
      void ProjectsService.Stop(serverId);
      void LogsService.StopServer(serverId);
    };
  }, [serverId, state.kind]);
}
