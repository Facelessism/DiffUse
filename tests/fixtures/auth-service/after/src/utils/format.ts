export function formatName(name: string): string {
  return name.normalize().trim().toLowerCase();
}

export function formatId(id: string): string {
  return id.toUpperCase();
}
