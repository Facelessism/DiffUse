import { formatName } from "@app/utils/format";

export const label = (name: string): string => `user:${formatName(name)}`;
