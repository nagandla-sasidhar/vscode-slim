# SLIM Language — VSCode Extension

Syntax highlighting, code folding, and snippets for `.slm` files (Structured LLM Instruction Markup).

## Install

### From VSIX (local build)
```bash
npm install -g @vscode/vsce
cd vscode-slim
vsce package          # produces slim-language-1.0.0.vsix
code --install-extension slim-language-1.0.0.vsix
```

### From VS Marketplace
Search **"SLIM Language"** in the Extensions panel once published.

## Features

| Construct | Colour |
|---|---|
| `@key: value` | Grey — orchestrator-only, stripped from LLM |
| `@+key: value` | Teal — LLM-visible header |
| `~ comment` | Green italic — stripped from LLM |
| `=== BLOCK [type]` | Purple bold — block boundary |
| `> CALL args` | Yellow — directive |
| `$var` | Orange — variable reference |
| `:schema_name` | Green — schema definition |
| `# Heading` | White bold — section heading |

## Snippets

| Prefix | Expands to |
|---|---|
| `slim-header` | Basic `@slim: 1.0` header |
| `slim-full` | Full header with model/retry/agent/task |
| `slim-agent` | Complete agent config template |
| `slim-workflow` | Workflow template with directives |
| `===` | Named block |
| `> CALL` | CALL directive |
| `:tool` | Schema definition |

## SLIM Quick Reference

```
@slim: 1.0          ← required first header
@model: claude-...  ← stripped from LLM (orchestrator only)
@+agent: Bot        ← sent to LLM + available as $agent

~ This is a comment (stripped)

# Section Heading

=== CODE [python]
def foo(): pass
=== /CODE

> CALL analyze(x: $input)
> ASSERT $result.ok == true
> YIELD $result.output

:my_tool
  desc: A tool
  arg!: str
  opt?: int = 0
  -> result: json
```
