import { useEffect, useState } from "react";
import type { AiModel } from "@remote-ide/protocol";

import { ModelPicker } from "./ModelPicker";

/**
 * Optional model and reasoning override for a prompt that runs later (schedules, triggers).
 * Empty values mean "use whatever the target session is configured with when it fires".
 */
export function ActionModelFields({ provider, model, reasoning, onLoadModels, onChange }: {
  provider: string; model: string; reasoning: string;
  onLoadModels(provider: string): Promise<AiModel[]>;
  onChange(value: { model: string; reasoning: string }): void;
}) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true); setError(""); setModels([]);
    void onLoadModels(provider).then((items) => { if (current) setModels(items); }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Could not load models"); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [provider, onLoadModels]);
  // A model that does not belong to the newly chosen provider must not be sent along.
  useEffect(() => { if (!loading && model && !models.some((item) => item.id === model)) onChange({ model: "", reasoning: "" }); }, [loading, models]);
  const selected = models.find((item) => item.id === model);
  const levels = selected?.reasoningLevels ?? [];
  return <div className="action-model-fields">
    <ModelPicker models={models} value={model} label={`${provider} model`} disabled={loading} onChange={(id) => { const next = models.find((item) => item.id === id); onChange({ model: id, reasoning: next?.reasoningLevels.includes(reasoning) ? reasoning : "" }); }} />
    <label>Reasoning effort<select aria-label="Reasoning effort" value={reasoning} disabled={loading || levels.length === 0} onChange={(event) => onChange({ model, reasoning: event.target.value })}><option value="">Session default</option>{levels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
    {model && <button type="button" onClick={() => onChange({ model: "", reasoning: "" })}>Use session default</button>}
    {!model && !loading && <p className="timers-help">No model chosen: the target session's current model is used.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
