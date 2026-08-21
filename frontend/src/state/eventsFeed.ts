import { Events as WailsEvents } from "@wailsio/runtime";
import { useCallback, useEffect, useState } from "react";
import { EventsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { Server } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";

// Как часто пересчитываем счётчики. Редко намеренно: события приходят
// событием, а этот такт нужен лишь чтобы подхватить чужие изменения (лента
// отмечена прочитанной на другом экране).
const REFRESH_MS = 20_000;

// useUnreadEvents считает непрочитанное по всем серверам сразу: рейка видна на
// каждом экране, и счётчик обязан быть верным независимо от того, куда человек
// смотрит.
export function useUnreadEvents(servers: Server[]): Record<string, number> {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const ids = servers.map((s) => s.id).join(",");

  const refresh = useCallback(async () => {
    const next: Record<string, number> = {};
    for (const id of ids === "" ? [] : ids.split(",")) {
      try {
        next[id] = await EventsService.Unread(id);
      } catch {
        // Счётчик это подсказка, а не данные: молчим и оставляем ноль.
        next[id] = 0;
      }
    }
    setUnread(next);
  }, [ids]);

  useEffect(() => {
    void refresh();
    const off = WailsEvents.On("events:new", () => void refresh());
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return unread;
}
