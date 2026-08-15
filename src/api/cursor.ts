export function encodeCursor(ts: Date, id: number): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(raw: string): { ts: Date; id: number } {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [tsPart, idPart] = decoded.split('|');
  const ts = new Date(tsPart ?? '');
  const id = Number(idPart);
  if (Number.isNaN(ts.getTime()) || !Number.isInteger(id)) {
    throw new Error('malformed cursor');
  }
  return { ts, id };
}
