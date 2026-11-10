import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A single-value picker that shows the option's LABEL (base-ui's Select.Value
 * renders the raw value, which for a dataset would be its uuid: pickers show
 * titles, never ids).
 */
export function LabeledSelect({
  ariaLabel,
  className,
  disabled,
  onChange,
  options,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder: string;
  value: string;
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder}>
          {chosen === undefined ? (value === "" ? undefined : value) : chosen.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
