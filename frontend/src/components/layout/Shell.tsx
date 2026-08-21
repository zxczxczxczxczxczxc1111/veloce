import { useCallback, useEffect, useState } from "react";
import { ServersService } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { Server } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";
import { ContentState } from "../ui/ContentState";
import { Card } from "../ui/Card";
import { ServerRail } from "./ServerRail";

// Переключение экранов это состояние, а не роутер. Экранов четыре, ссылками
// они не адресуются, а история браузера в десктопном окне только мешает:
// кнопка «назад» там ведёт себя непредсказуемо. Тянуть react-router незачем.
export type Screen =
  | { name: "servers" }
  | { name: "overview"; serverId: string }
  | { name: "project"; serverId: string; projectId: string; kind: string }
  | { name: "logs"; serverId: string; projectId: string; kind: string };

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

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <ServerRail
        servers={servers ?? []}
        activeId={activeId}
        onSelect={(id) => setScreen({ name: "overview", serverId: id })}
        onAdd={() => setScreen({ name: "servers" })}
      />

      <main className="flex-1 overflow-y-auto p-6">
        <ContentState
          pending={servers === null}
          fetching={fetching}
          skeleton={<div className="h-24 rounded-xl bg-fill-subtle" />}
        >
          {/* Экраны приезжают в фазах 6-8. Каркас нужен раньше них: без него
              открыть готовый экран будет нечем. */}
          <Card title={screen.name}>
            <p className="text-sm text-fg-secondary">{activeId ?? "-"}</p>
            {error !== null && (
              <p className="mt-2 text-sm text-down">{error}</p>
            )}
          </Card>
        </ContentState>
      </main>
    </div>
  );
}
