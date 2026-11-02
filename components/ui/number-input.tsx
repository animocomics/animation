"use client";

import { forwardRef, useEffect, useState, type InputHTMLAttributes } from "react";
import { clamp, formatNumericInput, normalizeNumericInput } from "@/lib/utils";

interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode"> {
  value: number;
  onValueChange: (value: number) => void;
}

/**
 * Text-based numeric entry keeps an empty editing state instead of turning
 * Number("") into zero. Values are committed as numbers, while the visible
 * representation accepts both Persian and Latin digits.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput({
  value,
  onValueChange,
  onBlur,
  onFocus,
  onKeyDown,
  min,
  max,
  ...props
}, ref) {
  const [text, setText] = useState(() => formatNumericInput(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatNumericInput(value));
  }, [focused, value]);

  const parse = (raw: string): number | null => {
    if (!raw.trim()) return null;
    const parsed = Number(normalizeNumericInput(raw));
    return Number.isFinite(parsed) ? parsed : null;
  };

  return (
    <input
      {...props}
      ref={ref}
      type="text"
      inputMode="decimal"
      dir="ltr"
      value={text}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parse(next);
        if (parsed !== null) onValueChange(parsed);
      }}
      onBlur={(event) => {
        setFocused(false);
        const parsed = parse(text);
        if (parsed === null) {
          setText(formatNumericInput(value));
        } else {
          const bounded = clamp(parsed, typeof min === "number" ? min : Number.NEGATIVE_INFINITY, typeof max === "number" ? max : Number.POSITIVE_INFINITY);
          onValueChange(bounded);
          setText(formatNumericInput(bounded));
        }
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        onKeyDown?.(event);
      }}
    />
  );
});
