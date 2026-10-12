export function compute(input: number): number {
  const doubled = input * 2;
  const shifted = doubled + 1;
  const squared = shifted * shifted;
  return squared - input;
}

export const LIMIT = 100;
