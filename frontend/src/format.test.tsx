// Форматирование это то, во что человек верит без проверки: если панель пишет
// «3.4 ГБ», никто не пойдёт считать байты руками. Поэтому здесь проверяются
// границы, а не середина: 1023 против 1024, 11 против 21, ноль против «не
// знаем».
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { LangProvider } from "./i18n/LangProvider";
import { useFormat, percentText } from "./format";

function withLang(lang: "ru" | "en") {
  localStorage.setItem("veloce.lang", lang);
  return ({ children }: { children: ReactNode }) => <LangProvider>{children}</LangProvider>;
}

function f(lang: "ru" | "en" = "ru") {
  return renderHook(() => useFormat(), { wrapper: withLang(lang) }).result.current;
}

beforeEach(() => localStorage.clear());

describe("байты", () => {
  it("считает по 1024, а не по 1000", () => {
    expect(f().bytes(1023)).toBe("1023 Б");
    expect(f().bytes(1024)).toBe("1 КБ");
    expect(f().bytes(1024 * 1024)).toBe("1.0 МБ");
  });

  it("дробную часть показывает начиная с мегабайт", () => {
    // У байтов и килобайт дробь это шум, у гигабайт 3 против 3.4 разница в треть.
    expect(f().bytes(1536)).toBe("2 КБ");
    expect(f().bytes(1536 * 1024)).toBe("1.5 МБ");
    expect(f().bytes(3.4 * 1024 ** 3)).toBe("3.4 ГБ");
  });

  it("не выдумывает единицу выше последней известной", () => {
    expect(f().bytes(1024 ** 6)).toBe("1024.0 ПБ");
  });

  it("недоступное значение это прочерк, а не ноль", () => {
    // Ноль и «не знаем» обязаны различаться: простаивающий контейнер честно
    // потребляет ноль, и путать это с отказом чтения нельзя.
    expect(f().bytes(-1)).toBe("-");
    expect(f().bytes(Number.NaN)).toBe("-");
    expect(f().bytes(Number.POSITIVE_INFINITY)).toBe("-");
    expect(f().bytes(0)).toBe("0 Б");
  });

  it("единицы берутся из словаря, а не из кода", () => {
    expect(f("en").bytes(1024)).toBe("1 KB");
  });
});

describe("скорость", () => {
  it("это байты плюс подпись в секунду", () => {
    expect(f().rate(2048)).toBe("2 КБ/с");
    expect(f("en").rate(2048)).toBe("2 KB/s");
  });
});

describe("аптайм", () => {
  it("до часа только минуты", () => {
    expect(f().uptime(59)).toBe("0 мин");
    expect(f().uptime(600)).toBe("10 мин");
  });

  it("до суток часы и минуты", () => {
    expect(f().uptime(3600)).toBe("1 ч 0 мин");
    expect(f().uptime(3661)).toBe("1 ч 1 мин");
  });

  it("от суток дни и часы, а не 521 час", () => {
    expect(f().uptime(86400)).toBe("1 д 0 ч");
    expect(f().uptime(21 * 86400 + 5 * 3600)).toBe("21 д 5 ч");
  });

  it("ноль и отрицательное это прочерк", () => {
    expect(f().uptime(0)).toBe("-");
    expect(f().uptime(-5)).toBe("-");
    expect(f().uptime(Number.NaN)).toBe("-");
  });
});

describe("сколько назад", () => {
  const now = 1_700_000_000_000;

  it("до минуты секундами: это важно ровно тогда, когда всё горит", () => {
    expect(f().ago(now, now)).toBe("0 с");
    expect(f().ago(now - 59_000, now)).toBe("59 с");
  });

  it("дальше минуты, часы, дни", () => {
    expect(f().ago(now - 60_000, now)).toBe("1 мин");
    expect(f().ago(now - 59 * 60_000, now)).toBe("59 мин");
    expect(f().ago(now - 3_600_000, now)).toBe("1 ч");
    expect(f().ago(now - 86_400_000, now)).toBe("1 д");
  });

  it("округляет вниз, а не вверх: 90 минут это 1 ч, а не 2", () => {
    expect(f().ago(now - 90 * 60_000, now)).toBe("1 ч");
  });

  it("отметку из будущего не показывает отрицательной", () => {
    // Часы машины и отметка события могут разъехаться. «-3 ч назад» читается
    // как поломка панели, хотя поломки нет.
    expect(f().ago(now + 3_600_000, now)).toBe("0 с");
  });
});

describe("русские числительные", () => {
  const forms = { one: "{n} новая строка", few: "{n} новые строки", many: "{n} новых строк" };

  it("одна, две, пять", () => {
    expect(f().plural(1, forms)).toBe("1 новая строка");
    expect(f().plural(2, forms)).toBe("2 новые строки");
    expect(f().plural(4, forms)).toBe("4 новые строки");
    expect(f().plural(5, forms)).toBe("5 новых строк");
  });

  it("исключение на 11-14, где правило по последней цифре врёт", () => {
    expect(f().plural(11, forms)).toBe("11 новых строк");
    expect(f().plural(12, forms)).toBe("12 новых строк");
    expect(f().plural(14, forms)).toBe("14 новых строк");
    expect(f().plural(15, forms)).toBe("15 новых строк");
  });

  it("во втором десятке и дальше правило снова работает", () => {
    expect(f().plural(21, forms)).toBe("21 новая строка");
    expect(f().plural(22, forms)).toBe("22 новые строки");
    expect(f().plural(25, forms)).toBe("25 новых строк");
    expect(f().plural(111, forms)).toBe("111 новых строк");
    expect(f().plural(121, forms)).toBe("121 новая строка");
  });

  it("ноль это третья форма", () => {
    expect(f().plural(0, forms)).toBe("0 новых строк");
  });

  it("у английского две последние формы совпадают и правило вырождается", () => {
    const en = { one: "{n} new line", few: "{n} new lines", many: "{n} new lines" };
    expect(f("en").plural(1, en)).toBe("1 new line");
    expect(f("en").plural(2, en)).toBe("2 new lines");
    expect(f("en").plural(5, en)).toBe("5 new lines");
  });
});

describe("проценты", () => {
  it("одна цифра после запятой всегда", () => {
    expect(percentText(0)).toBe("0.0%");
    expect(percentText(12.34)).toBe("12.3%");
    expect(percentText(100)).toBe("100.0%");
  });
});
