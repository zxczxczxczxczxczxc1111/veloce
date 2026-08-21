import { useCallback, useState, type ReactNode } from "react";
import { LangContext, SetLangContext, detectLang, type Lang } from "./index";

// Выбор языка живёт в localStorage, а не в конфиге Go: это настройка
// интерфейса, а не подключения, и гонять её через биндинги незачем.
const KEY = "veloce.lang";

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem(KEY);
    return saved === "ru" || saved === "en" ? saved : detectLang();
  });

  const set = useCallback((l: Lang) => {
    localStorage.setItem(KEY, l);
    setLang(l);
  }, []);

  return (
    <LangContext.Provider value={lang}>
      <SetLangContext.Provider value={set}>{children}</SetLangContext.Provider>
    </LangContext.Provider>
  );
}
