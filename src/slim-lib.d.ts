export function mdToSlm(markdown: string): string;
export function jsonToSlm(json: string): string;
export function yamlToSlm(yaml: string): string;
export function parse(text: string): {
    version: string;
    headers: Record<string, unknown>;
    llmHeaders: Record<string, unknown>;
    blocks: Record<string, { name: string; type: string | null; content: string }>;
    errors: Array<{ line: number; message: string }>;
    warnings: Array<{ line: number; message: string }>;
};
export function slimToLlmText(slm: string): string;
export function estimateTokens(text: string): number;
