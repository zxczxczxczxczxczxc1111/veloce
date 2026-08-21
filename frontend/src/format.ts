import { useT } from "./i18n";

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

export function percentText(v: number): string {
  return v.toFixed(1) + "%";
}

// Единицы живут в словаре, а не в коде: «МБ» и «MB» это перевод, и хардкод
// одного из них ломает второй язык молча.
export function useFormat() {
  const u = useT().units;
  return {
    bytes: (v: number) => bytes(u, v),
    rate: (v: number) => bytes(u, v) + u.perSec,
    uptime: (v: number) => uptime(u, v),
    percent: percentText,
  };
}
