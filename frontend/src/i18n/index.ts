import { createContext, useContext } from "react";
import { ru, type Dict } from "./ru";
import { en } from "./en";

export type Lang = "ru" | "en";

const dicts: Record<Lang, Dict> = { ru, en };

// Язык по умолчанию берётся из локали системы: русская даёт русский, любая
// другая английский.
export function detectLang(): Lang {
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const LangContext = createContext<Lang>("en");

// Ставить язык умеет только провайдер. Пустая заглушка по умолчанию нужна,
// чтобы компонент вне провайдера не падал, а просто ничего не делал.
export const SetLangContext = createContext<(l: Lang) => void>(() => {});

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useSetLang(): (l: Lang) => void {
  return useContext(SetLangContext);
}

export function useT(): Dict & {
  fmt: (s: string, v: Record<string, string>) => string;
} {
  const lang = useContext(LangContext);
  return {
    ...dicts[lang],
    fmt: (s, v) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? `{${k}}`),
  };
}
