import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LogsService,
  ProjectsService,
} from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectsTick } from "./events";
import { kindOf } from "./logs";

// Спека раздела 10: перезапуск считается несработавшим, если проект не поднялся
// за 30 секунд. Такт проектов идёт раз в пять секунд, то есть у нас шесть
// попыток убедиться - опрашивать сервер отдельно не нужно.
const WAIT_MS = 30_000;
// Сколько ждать первых строк лога, когда подъём не удался. Стрим стартует не
// мгновенно: спросив буфер сразу, мы покажем пустоту вместо причины.
const LOG_GRAB_MS = 1200;

export type RestartState = {
  /** Идёт перезапуск или ожидание подъёма. */
  pending: boolean;
  /** Не поднялся за отведённое время. */
  failed: boolean;
  /** Последние строки лога: показываем прямо в карточке, а не отправляем искать. */
  lines: string[];
  error: string | null;
  run: () => void;
  dismiss: () => void;
};

export function useRestart(serverId: string, project: ProjectDTO): RestartState {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Ждём в подписке на такт, поэтому окончание ожидания живёт в ref: замыкание
  // обработчика создаётся один раз и состояние из него не видно.
  const deadline = useRef(0);
  const timer = useRef<number | null>(null);

  const finish = useCallback(() => {
    deadline.current = 0;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setPending(false);
  }, []);

  // Подписка живёт всё время жизни карточки, а не только во время ожидания:
  // подписаться в момент перезапуска значит пропустить такт, который прилетел
  // на миллисекунду раньше.
  useEffect(() => {
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (deadline.current === 0) return;
      if (e.data.serverId !== serverId) return;
      const fresh = (e.data.projects ?? []).find(
        (p) => p.kind === project.kind && p.id === project.id,
      );
      if (fresh === undefined) return;
      if (fresh.state === "running" || fresh.state === "done") {
        finish();
        setFailed(false);
      }
    });
    return () => {
      off();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [serverId, project.kind, project.id, finish]);

  const run = useCallback(() => {
    setError(null);
    setFailed(false);
    setLines([]);
    setPending(true);
    deadline.current = Date.now() + WAIT_MS;

    void (async () => {
      try {
        await ProjectsService.Action(serverId, project.id, kindOf(project.kind), "restart");
      } catch (e: unknown) {
        // Ошибка живёт в карточке проекта, остальной экран продолжает
        // работать: недоступный docker не повод гасить всю панель.
        setError(e instanceof Error ? e.message : String(e));
        finish();
        return;
      }

      timer.current = window.setTimeout(() => {
        if (deadline.current === 0) return; // успел подняться
        finish();
        setFailed(true);
        // Последние строки лога прямо здесь. Отправлять человека искать их
        // самому в момент, когда прод не поднялся, это издевательство.
        void (async () => {
          try {
            await LogsService.Start(serverId, project.id, kindOf(project.kind));
            await new Promise((r) => window.setTimeout(r, LOG_GRAB_MS));
            const buffered = (await LogsService.Buffered(serverId, project.id)) ?? [];
            setLines(buffered.slice(-20));
          } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
          }
        })();
      }, WAIT_MS);
    })();
  }, [serverId, project.id, project.kind, finish]);

  const dismiss = useCallback(() => {
    setFailed(false);
    setLines([]);
    setError(null);
  }, []);

  return { pending, failed, lines, error, run, dismiss };
}
