# SLIM Language — VSCode Extension

Syntax highlighting, code folding, and snippets for `.slm` files (Structured LLM Instruction Markup v2.0).

## Install

### From VSIX (local build)
```bash
npm install -g @vscode/vsce
cd vscode-slim
vsce package          # produces slim-language-2.0.0.vsix
code --install-extension slim-language-2.0.0.vsix
```

### From VS Marketplace
Search **"SLIM Language"** in the Extensions panel once published.

## Features

| Construct | Colour |
|---|---|
| `@key: value` | Grey — orchestrator-only, stripped from LLM |
| `@+key: value` | Teal — LLM-visible header |
| `~ comment` | Green italic — stripped from LLM |
| `::SECTION_NAME type` | Purple bold — named section |
| `:::NESTED_NAME type` | Purple — nested section |
| `> CALL args` | Yellow — directive |
| `$var` | Orange — variable reference |
| `:schema_name` | Green — schema definition |
| `# Heading` | White bold — section heading |

## Snippets

| Prefix | Expands to |
|---|---|
| `slim-header` | Basic `@slim: 2.0` header |
| `slim-full` | Full header with model/retry/agent/task |
| `slim-agent` | Complete agent config template |
| `slim-workflow` | Workflow template with directives |
| `::` | Named section |
| `:::` | Nested section |
| `> CALL` | CALL directive |
| `:tool` | Schema definition |

## SLIM Quick Reference

```
@slim: 2.0          ← required first line
@model: claude-...  ← stripped from LLM (orchestrator only)
@+name: Bot         ← LLM-visible header

~ This is a comment (stripped)

::ROLE
You are a helpful assistant.

::INSTRUCTIONS
Follow these rules carefully.

::CODE_1 python
def foo(): pass

::CONTEXT markdown
Background information here.

> CALL analyze(x: $input)
> ASSERT $result.ok == true
> YIELD $result.output

:my_tool
  desc: A tool
  arg!: str
  opt?: int = 0
  -> result: json
```
