import type { VariantCombination, VariantTarget } from './types';

export type CombinationEntry = [targetId: string, variantId: string];

export function parseCombinationKey(
  combinationKey: string
): CombinationEntry[] | null {
  try {
    const entries: unknown = JSON.parse(combinationKey);
    if (
      !Array.isArray(entries) ||
      entries.some(
        entry =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          typeof entry[1] !== 'string'
      )
    ) {
      return null;
    }
    return entries as CombinationEntry[];
  } catch {
    return null;
  }
}

export function combinationForTargets(
  targets: VariantTarget[],
  useOriginalVariants = false
): VariantCombination {
  const entries = targets.map(target => {
    const variant =
      (useOriginalVariants
        ? target.variants[0]
        : target.variants.find(
            candidate => candidate.id === target.activeVariantId
          )) ?? target.variants[0];
    return {
      targetId: target.id,
      variantId: variant?.id ?? '',
      label: variant?.label ?? 'Original',
      isOriginal: variant === target.variants[0]
    };
  });
  return {
    key: JSON.stringify(
      entries.map(entry => [entry.targetId, entry.variantId] as const)
    ),
    label:
      entries
        .filter(entry => !entry.isOriginal)
        .map(entry => entry.label)
        .join(' + ') || 'Original'
  };
}

export function matchingPrefixLength(
  left: CombinationEntry[],
  right: CombinationEntry[]
): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    left[index][0] === right[index][0] &&
    left[index][1] === right[index][1]
  ) {
    index++;
  }
  return index;
}
