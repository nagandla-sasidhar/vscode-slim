import * as vscode from 'vscode';
import * as slim from './slim-lib';

const PARTICIPANT_ID = 'slim.chat';

const HELP_TEXT = `
**@slim** converts Markdown, YAML, JSON, or plain text to [SLIM format](https://slimformat.org) — saving ~43% of LLM-facing tokens on average.

**Usage:**
- \`@slim [paste your text]\` — auto-detect and convert
- \`@slim /convert [paste your text]\` — explicitly convert
- \`@slim /validate [paste your .slm content]\` — validate SLIM v2 syntax

**Example:**
\`\`\`
@slim
## Instructions
- Always cite data sources
- Never fabricate data points
\`\`\`
`.trim();

function detectInputType(text: string): 'json' | 'yaml' | 'markdown' {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
        return 'json';
    }
    // YAML: root-level key: value lines with no # headings
    const lines = t.split('\n').filter(l => l.trim());
    const hasHeading = lines.some(l => /^#{1,6}\s/.test(l));
    const hasYamlKey = lines.some(l => /^[a-z][a-z0-9_-]*\s*:/i.test(l));
    if (!hasHeading && hasYamlKey) {
        return 'yaml';
    }
    return 'markdown';
}

async function handler(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const text = request.prompt.trim();

    if (!text) {
        stream.markdown(HELP_TEXT);
        return {};
    }

    if (request.command === 'validate') {
        const doc = slim.parse(text);
        const hasSlimHeader = text.trimStart().startsWith('@slim: 2.0');

        if (doc.errors.length === 0 && hasSlimHeader) {
            stream.markdown(`✅ **Valid SLIM v2 document**\n\n`);
            stream.markdown(`- Sections: \`${Object.keys(doc.blocks).join('`, `') || 'none'}\`\n`);
            stream.markdown(`- Headers: \`${Object.keys(doc.headers).join('`, `') || 'none'}\`\n`);
            stream.markdown(`- LLM-visible headers: \`${Object.keys(doc.llmHeaders).join('`, `') || 'none'}\``);
        } else {
            if (!hasSlimHeader) {
                stream.markdown(`⚠️ **Missing \`@slim: 2.0\` on first line**\n\n`);
            }
            if (doc.errors.length > 0) {
                stream.markdown(`❌ **${doc.errors.length} error(s) found:**\n\n`);
                for (const err of doc.errors) {
                    stream.markdown(`- Line ${err.line}: ${err.message}\n`);
                }
            }
            if (doc.warnings.length > 0) {
                stream.markdown(`\n⚠️ **${doc.warnings.length} warning(s):**\n\n`);
                for (const w of doc.warnings) {
                    stream.markdown(`- Line ${w.line}: ${w.message}\n`);
                }
            }
            // Check for v1 syntax
            if (/^===\s+[A-Z]/m.test(text)) {
                stream.markdown(`\n💡 **Tip:** Found \`=== BLOCK\` syntax — this is SLIM v1. Update to \`::SECTION_NAME\` for v2.`);
            }
        }
        return {};
    }

    // Default: convert
    const inputType = detectInputType(text);
    let slmOutput: string;

    try {
        if (inputType === 'json') {
            slmOutput = slim.jsonToSlm(text);
        } else if (inputType === 'yaml') {
            slmOutput = slim.yamlToSlm(text);
        } else {
            slmOutput = slim.mdToSlm(text);
        }
    } catch (e) {
        stream.markdown(`❌ Conversion failed: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }

    const llmText = slim.slimToLlmText(slmOutput);
    const inTokens = slim.estimateTokens(text);
    const outTokens = slim.estimateTokens(llmText);
    const savings = inTokens > 0 ? Math.round((inTokens - outTokens) / inTokens * 100) : 0;

    stream.markdown(`\`\`\`\n${slmOutput.trimEnd()}\n\`\`\`\n\n`);
    stream.markdown(`💾 **Saved ~${savings}% tokens** (${inTokens} → ${outTokens} LLM-facing tokens)`);

    if (savings > 0) {
        stream.markdown(`\n\n_Detected input: ${inputType}. For precise counts use the [playground](https://slimformat.org/playground.html)._`);
    }

    return {};
}

export function activate(context: vscode.ExtensionContext): void {
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    context.subscriptions.push(participant);
}

export function deactivate(): void {}
