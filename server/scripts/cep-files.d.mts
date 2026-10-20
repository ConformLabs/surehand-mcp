export const CEP_ROOT: string;
export const SIGNATURE_FILES: string[];
export const BINARY_FILE: RegExp;
/** Text files as strings (version stamped), binary files (fonts) as Buffers. */
export function readCepFiles(version: string): Record<string, string | Buffer>;
