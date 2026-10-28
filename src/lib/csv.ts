import type { FastifyReply } from 'fastify';

export interface CsvColumn<T> {
  key: keyof T | ((row: T) => unknown);
  label: string;
}

const escape = (value: unknown) => {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escape(typeof c.key === 'function' ? c.key(row) : row[c.key])).join(','),
  );
  return '﻿' + [header, ...body].join('\r\n');
}

export function sendCsv<T>(reply: FastifyReply, filename: string, columns: CsvColumn<T>[], rows: T[]) {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`);
  return toCsv(columns, rows);
}
