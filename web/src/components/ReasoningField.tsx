import type { Model } from "../lib/types";
import { SelectField } from "./ui/Select";

export function ReasoningField({
  model,
  effort,
  onChange,
}: {
  model?: Model;
  effort?: string;
  onChange: (value: string) => void;
}) {
  if (
    !model?.effort_parameter ||
    !["effort", "toggle", "budget"].includes(model.reasoning_kind ?? "unknown")
  )
    return null;
  if (model.reasoning_kind === "budget") {
    return (
      <label className="form-field">
        <span>思考预算</span>
        <input
          type="number"
          min={model.reasoning_budget_min ?? 0}
          max={model.reasoning_budget_max ?? 100000}
          step={1}
          required
          value={
            effort?.startsWith("budget:")
              ? effort.slice(7)
              : (model.reasoning_budget_default ?? 2048)
          }
          onChange={(event) => onChange(`budget:${event.target.value}`)}
        />
      </label>
    );
  }
  const values =
    model.reasoning_kind === "toggle" ? ["on", "off"] : (model.efforts ?? []);
  if (!values.length) return null;
  return (
    <label className="form-field">
      <span>思考程度</span>
      <SelectField
        value={effort ?? model.default_effort ?? ""}
        options={[
          { value: "", label: "默认" },
          ...values.map((value) => ({ value, label: value })),
        ]}
        onChange={onChange}
      />
    </label>
  );
}
