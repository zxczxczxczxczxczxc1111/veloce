import { useT } from "./i18n";
import type { Dict } from "./i18n/ru";

type Units = {
  bytes: string[];
  perSec: string;
  day: string;
  hour: string;
  minute: string;
};

// Единицы считаем по 1024 и подписываем так же, как их показывают free, df и
// docker stats на той стороне. Числа на экране обязаны сходиться с числами в
// консоли, иначе панели не верят.
function bytes(u: Units, v: number): string {
  if (!Number.isFinite(v) || v < 0) return "-";
  let n = v;
  let i = 0;
  while (n >= 1024 && i < u.bytes.length - 1) {
    n /= 1024;
    i += 1;
  }
  // Одна цифра после запятой начиная с мегабайт: у байтов и килобайт дробная
  // часть это шум, а у гигабайт 3 против 3.4 разница в треть.
  return (i >= 2 ? n.toFixed(1) : Math.round(n).toString()) + " " + u.bytes[i];
}

// Аптайм словами, а не 521 часом: «3 недели» человек читает мгновенно, а часы
// с четырьмя цифрами приходится делить в уме.
function uptime(u: Units, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${u.day} ${h} ${u.hour}`;
  if (h > 0) return `${h} ${u.hour} ${m} ${u.minute}`;
  return `${m} ${u.minute}`;
}

// ago переводит отметку времени в «сколько назад». Отдельно от uptime:
// у аптайма единицы крупные, а последний успешный ответ измеряется секундами
// ровно в тот момент, когда это важнее всего.
function ago(d: Dict["health"]["ago"], ms: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return fill(d.seconds, sec);
  if (sec < 3600) return fill(d.minutes, Math.floor(sec / 60));
  if (sec < 86400) return fill(d.hours, Math.floor(sec / 3600));
  return fill(d.days, Math.floor(sec / 86400));
}

function fill(tpl: string, n: number): string {
  return tpl.replace("{n}", String(n));
}

export function percentText(v: number): string {
  return v.toFixed(1) + "%";
}

// Единицы живут в словаре, а не в коде: «МБ» и «MB» это перевод, и хардкод
// одного из них ломает второй язык молча.
export function useFormat() {
  const t = useT();
  const u = t.units;
  const agoDict = t.health.ago;
  return {
    bytes: (v: number) => bytes(u, v),
    rate: (v: number) => bytes(u, v) + u.perSec,
    uptime: (v: number) => uptime(u, v),
    percent: percentText,
    // now передаётся снаружи, чтобы значение можно было пересчитать по такту,
    // а не только при перерисовке по другой причине.
    ago: (ms: number, now: number = Date.now()) => ago(agoDict, ms, now),
  };
}
