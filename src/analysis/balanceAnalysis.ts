import type { ProjectData } from '../validation/references.js';
import { evaluateFormula, REFERENCE_CONTEXT } from './formulaEval.js';

export interface Sample {
  id: number;
  name: string;
  value: number;
}
export interface Outlier extends Sample {
  deviations: number | null;
  direction: 'high' | 'low';
  message: string;
}
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sd = (values: number[], average: number) =>
  values.length < 2
    ? 0
    : Math.sqrt(
        values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
      );
function categoryReport(
  category: string,
  metric: string,
  samples: Sample[],
  skipped: number,
  threshold: number,
) {
  const values = samples.map((sample) => sample.value);
  const outliers: Outlier[] = [];
  if (samples.length >= 4)
    for (const sample of samples) {
      const peers = samples.filter((other) => other !== sample).map((other) => other.value);
      const average = mean(peers);
      const deviation = sd(peers, average);
      if (sample.value === average) continue;
      const z = deviation === 0 ? null : (sample.value - average) / deviation;
      if (z !== null && Math.abs(z) < threshold) continue;
      const direction = sample.value > average ? 'high' : 'low';
      outliers.push({
        ...sample,
        deviations: z,
        direction,
        message: `${sample.name} is ${direction} on ${metric} relative to its peers. Review progression tier and mechanics before changing it.${z === null ? ' All other peers are identical, so a standard-deviation score is undefined.' : ''}`,
      });
    }
  outliers.sort(
    (a, b) =>
      (b.deviations === null ? Number.MAX_VALUE : Math.abs(b.deviations)) -
      (a.deviations === null ? Number.MAX_VALUE : Math.abs(a.deviations)),
  );
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  return {
    category,
    metric,
    sampled: samples.length,
    skipped,
    stats: values.length
      ? {
          mean: mean(values),
          sd: sd(values, mean(values)),
          min: sorted[0].value,
          max: sorted.at(-1)!.value,
        }
      : null,
    insufficientSample: samples.length < 4,
    outlierCount: outliers.length,
    outliers: outliers.slice(0, 100),
    lowest: sorted.slice(0, 3),
    highest: sorted.slice(-3).reverse(),
  };
}

/** Comparison heuristics, not a battle simulation or an automatic rebalance. */
export function analyzeBalance(data: ProjectData, category = 'all', thresholdSd = 2) {
  const categories: ReturnType<typeof categoryReport>[] = [];
  const unreadableFormulas: { id: number; name: string; formula: string; reason: string }[] = [];
  for (const key of ['skills', 'weapons', 'armors', 'enemies'] as const) {
    if (category !== 'all' && category !== key) continue;
    const samples: Sample[] = [];
    let skipped = 0;
    for (const entry of data[key]) {
      if (!entry) continue;
      const record = entry as unknown as Record<string, unknown>;
      let value: number;
      if (key === 'skills') {
        const damage = record.damage as Record<string, unknown> | undefined;
        const mp = finite(record.mpCost);
        if (!damage || ![1, 5].includes(finite(damage.type)) || mp <= 0) {
          skipped++;
          continue;
        }
        const formula = String(damage.formula ?? '');
        const evaluated = evaluateFormula(formula, REFERENCE_CONTEXT);
        if (!evaluated.ok) {
          unreadableFormulas.push({
            id: entry.id,
            name: entry.name,
            formula,
            reason: evaluated.reason,
          });
          skipped++;
          continue;
        }
        value = Math.max(0, evaluated.value) / mp;
      } else {
        const params = Array.isArray(record.params) ? record.params.map(finite) : [];
        const divisor =
          key === 'weapons'
            ? (params[2] ?? 0) + (params[4] ?? 0)
            : key === 'armors'
              ? (params[3] ?? 0) + (params[5] ?? 0)
              : finite(record.exp);
        if (divisor <= 0) {
          skipped++;
          continue;
        }
        value = (key === 'enemies' ? (params[0] ?? 0) : finite(record.price)) / divisor;
      }
      if (!Number.isFinite(value) || value < 0) {
        skipped++;
        continue;
      }
      samples.push({ id: entry.id, name: entry.name, value });
    }
    const metric = {
      skills: 'reference damage per MP',
      weapons: 'gold per ATK+MAT',
      armors: 'gold per DEF+MDF',
      enemies: 'HP per EXP',
    }[key];
    categories.push(categoryReport(key, metric, samples, skipped, thresholdSd));
  }
  return {
    thresholdSd,
    categories,
    outlierCount: categories.reduce((sum, item) => sum + item.outlierCount, 0),
    unreadableFormulas,
    referenceContext: REFERENCE_CONTEXT,
    coverage:
      'Advisory static comparisons using a fixed reference stat line and leave-one-out peer statistics (minimum four samples). Formulas are parsed, never executed. Unsupported formulas are excluded and reported. Tiers, scope, repeats, hit rates, TP, traits, elements, states, variance and plugin mechanics are not modeled; review before tuning. Each category returns at most 100 outliers.',
  };
}
