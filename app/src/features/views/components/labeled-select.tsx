import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";

export interface SelectOption {
  value: string;
  label: string;
  /** A heading to list the option under ("Datasets", "Views"); options without one come first. */
  group?: string;
}

/** The options in display order: ungrouped first, then each group in order of first appearance. */
function sections(
  options: SelectOption[],
): { heading: string | undefined; items: SelectOption[] }[] {
  const result: { heading: string | undefined; items: SelectOption[] }[] = [];
  for (const option of options) {
    const found = result.find((section) => section.heading === option.group);
    if (found === undefined) {
      result.push({ heading: option.group, items: [option] });
    } else {
      found.items.push(option);
    }
  }
  return result.toSorted(
    (a, b) => Number(a.heading !== undefined) - Number(b.heading !== undefined),
  );
}

function Item({ option }: { option: SelectOption }) {
  return <SelectItem value={option.value}>{option.label}</SelectItem>;
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
        {sections(options).map((section) =>
          section.heading === undefined ? (
            section.items.map((option) => <Item key={option.value} option={option} />)
          ) : (
            <SelectGroup key={section.heading}>
              <SelectLabel>{section.heading}</SelectLabel>
              {section.items.map((option) => (
                <Item key={option.value} option={option} />
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}
