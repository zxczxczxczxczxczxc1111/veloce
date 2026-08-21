import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { ProjectKind } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/collect";
import type { LogBatch } from "./events";

// Буфер на стороне интерфейса ограничен так же, как кольцо на стороне Go.
// Держать десятки тысяч строк в состоянии React это способ убить приложение
// своими руками: каждая перерисовка копирует весь массив.
const MAX_LINES = 5000;

// LogLine несёт постоянный номер. Без него срез кольца сдвигает все индексы,
// React считает изменившейся КАЖДУЮ из пяти тысяч строк и переписывает весь
// список на каждой пачке. Замерено: пик кадра падает со 150 мс до 20.
export type LogLine = {
  id: number;
  text: string;
};

export type Logs = {
  lines: LogLine[];
  paused: boolean;
  setPaused: (v: boolean) => void;
  error: string | null;
};

export function kindOf(kind: string): ProjectKind {
  // Сравнение, а не приведение: неизвестное значение обязано упереться здесь,
  // а не улететь в подстановку команды на сервере.
  return kind === "docker" ? ProjectKind.KindDocker : ProjectKind.KindSystemd;
}

export function useLogs(serverId: string, projectId: string, kind: string): Logs {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Пауза держится в ref, потому что подписка на событие живёт весь срок
  // экрана: читай она состояние напрямую, обработчик остался бы с тем
  // значением, которое было на момент подписки.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Сквозной счётчик строк на весь экран: номер обязан оставаться уникальным
  // и после того, как строка уехала из кольца.
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    setLines([]);
    setError(null);
    seq.current = 0;

    // Сначала подписка, потом Start: между этими двумя вызовами уже летят
    // строки, и подписавшись вторым, мы теряли бы начало потока.
    const off = Events.On("logs:batch", (e: { data: LogBatch }) => {
      if (e.data.serverId !== serverId || e.data.projectId !== projectId) return;
      // На паузе строки не копятся вообще. Копить их значит вывалить на
      // человека тысячу строк одним куском в момент снятия паузы.
      if (pausedRef.current) return;
      setLines((prev) => {
        const next = prev.concat(
          (e.data.lines ?? []).map((text) => {
            seq.current += 1;
            return { id: seq.current, text };
          }),
        );
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });

    void (async () => {
      try {
        await LogsService.Start(serverId, projectId, kindOf(kind));
        // Уже накопленное на стороне Go: при возврате на экран человек должен
        // увидеть контекст, а не пустоту в ожидании новой строки.
        const buffered = (await LogsService.Buffered(serverId, projectId)) ?? [];
        if (!alive) return;
        setLines((prev) =>
          prev.length === 0
            ? buffered.map((text) => {
                seq.current += 1;
                return { id: seq.current, text };
              })
            : prev,
        );
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      alive = false;
      off();
      // Стрим на сервере закрывается вместе с экраном, иначе `docker logs -f`
      // копится на той стороне при каждом заходе.
      void LogsService.Stop(serverId, projectId);
    };
  }, [serverId, projectId, kind]);

  const setPausedStable = useCallback((v: boolean) => setPaused(v), []);

  return { lines, paused, setPaused: setPausedStable, error };
}
