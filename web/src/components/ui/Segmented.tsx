import type { CSSProperties, ReactNode } from "react";

/** Lab segmented control: `.seg` supplies the track, a sliding thumb follows `--i`. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className={`seg ${className}`.trim()} role="radiogroup" aria-label={label} style={{ "--n": options.length, "--i": index } as CSSProperties}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} title={option.title} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
