import { useCallback, useEffect, useState } from "react";
import { ServersService } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { Server } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";
import { ContentState } from "../ui/ContentState";
import { ServerRail } from "./ServerRail";
import { Servers } from "../../screens/Servers";
import { Overview } from "../../screens/Overview";
import { Project } from "../../screens/Project";
import { Logs } from "../../screens/Logs";
import type { ProjectDTO } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { useConnState, useServerTickers } from "../../state/conn";

// Переключение экранов это состояние, а не роутер. Экранов четыре, ссылками
// они не адресуются, а история браузера в десктопном окне только мешает:
// кнопка «назад» там ведёт себя непредсказуемо. Тянуть react-router незачем.
export type Screen =
  | { name: "servers" }
  | { name: "overview"; serverId: string }
  // Проект несём целиком, а не по идентификатору: экран обязан нарисоваться
  // сразу, а не ждать первого такта, чтобы узнать имя и состояние.
  | { name: "project"; serverId: string; project: ProjectDTO }
  | { name: "logs"; serverId: string; project: ProjectDTO };

export function Shell() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: "servers" });

  const reload = useCallback(async () => {
    setFetching(true);
    try {
      // Go отдаёт nil-срез как null: пустой список и отсутствие списка здесь
      // одно и то же.
      setServers((await ServersService.List()) ?? []);
      setError(null);
    } catch (e: unknown) {
      // Без этого перехвата отказ биндинга оставляет servers в null навсегда,
      // и человек смотрит на вечный скелет, не понимая, что сломалось.
      setError(e instanceof Error ? e.message : String(e));
      setServers([]);
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeId = screen.name === "servers" ? null : screen.serverId;

  // Такты живут здесь, а не в карточке сервера: карточка исчезает при уходе с
  // экрана подключений, и тикеры остановились бы ровно тогда, когда обзор их
  // и просит. Уход с сервера гасит такты сам, через размонтирование эффекта.
  const activeState = useConnState(activeId);
  useServerTickers(activeId, activeState);

  const openServer = useCallback((id: string) => {
    setScreen({ name: "overview", serverId: id });
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <ServerRail
        servers={servers ?? []}
        activeId={activeId}
        onSelect={openServer}
        onAdd={() => setScreen({ name: "servers" })}
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <ContentState
          pending={servers === null}
          fetching={fetching}
          skeleton={<div className="h-24 rounded-xl bg-fill-subtle" />}
        >
          {error !== null && (
            <p className="mb-4 text-sm text-down">{error}</p>
          )}

          {screen.name === "servers" && (
            <Servers
              servers={servers ?? []}
              onChanged={reload}
              onOpen={openServer}
            />
          )}

          {screen.name === "overview" && (
            <Overview
              serverId={screen.serverId}
              state={activeState}
              onConnect={() => void ServersService.Connect(screen.serverId)}
              onOpenProject={(p) =>
                setScreen({ name: "project", serverId: screen.serverId, project: p })
              }
            />
          )}

          {screen.name === "project" && (
            <Project
              serverId={screen.serverId}
              project={screen.project}
              onBack={() => setScreen({ name: "overview", serverId: screen.serverId })}
              onFullLogs={() =>
                setScreen({
                  name: "logs",
                  serverId: screen.serverId,
                  project: screen.project,
                })
              }
            />
          )}

          {screen.name === "logs" && (
            <Logs
              serverId={screen.serverId}
              projectId={screen.project.id}
              kind={screen.project.kind}
              name={screen.project.name}
              onBack={() =>
                setScreen({
                  name: "project",
                  serverId: screen.serverId,
                  project: screen.project,
                })
              }
            />
          )}
        </ContentState>
      </main>
    </div>
  );
}
