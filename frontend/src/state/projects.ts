import { Events } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectsTick } from "./events";

// useProjectTick держит свежий снимок ОДНОГО проекта по общему такту.
//
// Своего опроса не заводит намеренно: два источника одних и тех же цифр
// разъедутся на глазах у человека. Начальное значение это снимок на момент
// открытия экрана, чтобы не ждать первого такта с пустотой.
export function useProjectTick(serverId: string, initial: ProjectDTO): ProjectDTO {
  const [current, setCurrent] = useState(initial);

  useEffect(() => {
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (e.data.serverId !== serverId) return;
      const fresh = (e.data.projects ?? []).find(
        (p) => p.kind === initial.kind && p.id === initial.id,
      );
      if (fresh !== undefined) setCurrent(fresh);
    });
    return () => {
      off();
    };
  }, [serverId, initial.kind, initial.id]);

  return current;
}
