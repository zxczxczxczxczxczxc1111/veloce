import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "accent" | "secondary" | "ghost" | "danger";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** Плотный ряд (тулбар, строка списка): 28px вместо 36px. */
  dense?: boolean;
  children: ReactNode;
};

// Фон кнопки классом поверх варианта НЕ переопределять: у варианта остаётся
// собственный hover, и кнопка прыгает при наведении с чужого фона на свой.
// Нужен другой вид - добавляйте вариант сюда.
const variants: Record<Variant, string> = {
  // Наведение на акцентной кнопке ГАСИТ, а не разгоняет: янтарное пятно и так
  // самое яркое на чёрном экране, осветлять некуда.
  accent: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary:
    "bg-fill text-foreground border border-border hover:bg-fill-hover hover:border-border-hover",
  ghost: "bg-transparent text-fg-secondary hover:bg-fill hover:text-foreground",
  danger: "bg-transparent text-down border border-down/25 hover:bg-down/10",
};

// forwardRef нужен диалогу подтверждения: он уводит фокус на «Отмену», а без
// ссылки на узел добраться до неё нечем. React здесь 18, где ref ещё не
// обычный проп.
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", dense = false, className = "", children, ...rest },
  ref,
) {
  const height = dense ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm";
  return (
    <button
      ref={ref}
      // transition-all запрещён: он анимирует размеры и отступы, из-за чего
      // наведение дёргает раскладку. Перечисляем только то, что меняется.
      // Длительность и кривая не пишутся: они заданы токенами в tokens.css.
      className={
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium " +
        "transition-colors cursor-pointer disabled:cursor-not-allowed " +
        "disabled:text-fg-faint disabled:bg-fill-subtle disabled:border-border " +
        height +
        " " +
        variants[variant] +
        " " +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
});
