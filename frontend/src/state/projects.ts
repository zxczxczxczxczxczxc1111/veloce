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

// Память о падениях. Живёт ВНЕ экранов намеренно: во время падения человек
// обычно смотрит на экран проекта, а обзор в этот момент размонтирован и
// ничего не видит. Экранная память тут бесполезна по определению.
const downAt = new Map<string, number>();

function incidentKey(serverId: string, kind: string, id: string): string {
  return serverId + "\x00" + kind + ":" + id;
}

// useIncidentRecorder слушает такты постоянно, независимо от открытого экрана.
// Вешается один раз в оболочке.
export function useIncidentRecorder(serverId: string | null): void {
  useEffect(() => {
    if (serverId === null) return;
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (e.data.serverId !== serverId) return;
      const now = Date.now();
      for (const p of e.data.projects ?? []) {
        if (p.state === "down") downAt.set(incidentKey(serverId, p.kind, p.id), now);
      }
    });
    return () => {
      off();
    };
  }, [serverId]);
}

// lastDownAt отдаёт время последнего падения. 0 - падений не видели.
export function lastDownAt(serverId: string, kind: string, id: string): number {
  return downAt.get(incidentKey(serverId, kind, id)) ?? 0;
}
