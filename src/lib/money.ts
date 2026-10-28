export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
export const sum = (values: number[]) => round2(values.reduce((a, b) => a + b, 0));
