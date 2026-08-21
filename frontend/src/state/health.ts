import { useEffect, useState } from "react";
import { HealthService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { HealthResult } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";

// Такт проверки. Реже, чем метрики хоста: health-check это сетевой запрос на
// той стороне, а не чтение /proc, и долбить им чужое приложение каждые две
// секунды невежливо.
const HEALTH_TICK_MS = 15_000;

export function useHealth(
  serverId: string,
  url: string,
  enabled: boolean,
): HealthResult | null {
  const [result, setResult] = useState<HealthResult | null>(null);

  useEffect(() => {
    if (!enabled || url.trim() === "") {
      setResult(null);
      return;
    }
    let alive = true;

    async function check() {
      try {
        const r = await HealthService.Check(serverId, url);
        if (alive) setResult(r);
      } catch {
        // Отказ самой проверки (нет соединения с сервером) не должен гасить
        // карточку: состояние проекта от Docker или systemd остаётся верным.
        if (alive) setResult(null);
      }
    }

    void check();
    const id = window.setInterval(() => void check(), HEALTH_TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [serverId, url, enabled]);

  return result;
}
