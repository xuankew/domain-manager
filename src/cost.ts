/** 成本是手填字段：接受数字或数字字符串，空值表示「未填写」。 */
export interface CostInput {
  value: number | null;
  error: string | null;
}

export function parseCostInput(raw: unknown): CostInput {
  if (raw === null || raw === undefined) return { value: null, error: null };

  const text = String(raw).trim();
  if (!text) return { value: null, error: null };

  const value = Number(text);
  if (!Number.isFinite(value)) return { value: null, error: '成本必须是数字' };
  if (value < 0) return { value: null, error: '成本不能为负数' };
  if (value > 1_000_000) return { value: null, error: '成本过大，请确认单位是否为「元/年」' };

  return { value: Math.round(value * 100) / 100, error: null };
}

export interface CostSummary {
  total: number;
  filled: number;
  missing: number;
}

export function summarizeCost(views: { cost: number | null }[]): CostSummary {
  let total = 0;
  let filled = 0;
  for (const v of views) {
    if (v.cost === null) continue;
    total += v.cost;
    filled++;
  }
  return { total: Math.round(total * 100) / 100, filled, missing: views.length - filled };
}
