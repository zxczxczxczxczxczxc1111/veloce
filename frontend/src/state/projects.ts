import { Events } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectsTick } from "./events";
import { diag } from "./diag";

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

// Предыдущее состояние каждого проекта. Нужно, чтобы писать в журнал ПЕРЕХОДЫ:
// счётчик «лежат: 87» между двумя отметками ничего не говорит, а строка
// «demo-app-test: running -> down» говорит всё.
const seenState = new Map<string, string>();

function incidentKey(serverId: string, kind: string, id: string): string {
  return serverId + "\x00" + kind + ":" + id;
}

// useIncidentRecorder слушает такты постоянно, независимо от открытого экрана.
// Вешается один раз в оболочке.
export function useIncidentRecorder(serverId: string | null): void {
  useEffect(() => {
    diag(`useIncidentRecorder: слушаем сервер ${serverId ?? "нет"}`);
    if (serverId === null) return;
    let got = 0;
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (e.data.serverId !== serverId) {
        diag(`projects:tick чужой сервер: ${e.data.serverId}`);
        return;
      }
      got += 1;
      const down = (e.data.projects ?? []).filter((p) => p.state === "down").length;
      if (got <= 3 || got % 12 === 0) {
        diag(`projects:tick получен #${got} проектов=${(e.data.projects ?? []).length} лежат=${down}`);
      }
      const now = Date.now();
      for (const p of e.data.projects ?? []) {
        const key = incidentKey(serverId, p.kind, p.id);
        const was = seenState.get(key);
        if (was !== undefined && was !== p.state) {
          diag(`переход: ${p.id} ${was} -> ${p.state}`);
        }
        seenState.set(key, p.state);
        if (p.state === "down") downAt.set(key, now);
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
