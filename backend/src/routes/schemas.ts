// DECISION: Mutating admin routes declare JSON Schemas instead of trusting the TypeScript cast on
// `request.body`. A cast disappears at runtime, so previously `{"rpm_cap":"abc"}` was accepted and
// the `|| 0` fallback silently turned a typo into "unlimited". Fastify validates (and coerces
// numeric strings) before the handler runs and answers 400 on a type mismatch.

export const nonNegativeInteger = { type: 'integer', minimum: 0 } as const;
export const nonNegativeNumber = { type: 'number', minimum: 0 } as const;
export const trimmedString = (maxLength: number) =>
  ({ type: 'string', minLength: 1, maxLength }) as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: trimmedString(200) },
} as const;

export const keyCapsSchema = {
  rpm_cap: nonNegativeInteger,
  tpm_cap: nonNegativeInteger,
  daily_budget_cap: nonNegativeNumber,
} as const;
