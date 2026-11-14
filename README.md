# Jacket for Zed

[![Check extension](https://github.com/ctzcs/jacket-zed/actions/workflows/ci.yml/badge.svg)](https://github.com/ctzcs/jacket-zed/actions/workflows/ci.yml)

[中文说明](README.zh-CN.md)

Jai language support using the locally installed [Jacket](https://github.com/matteopolak/jacket) toolchain, an independent, unofficial Jai implementation. No VS Code dependency or automatic toolchain downloads.

## Features

- `.jai` detection, Tree-sitter highlighting, brackets, indentation, and function/type outlines.
- Optional light/dark icon themes with a dedicated J monogram for `.jai` files.
- Vim function/type/comment text objects and a run button beside `main`.
- Paired `//@region Title` / `//@endregion` comments for nested outline groups and editor folds.
- Standard LSP completion, hover, definitions, references, rename, diagnostics, and other features through `jailsp`, subject to Zed's support.
- Document and selection formatting through `jailsp` and `jaifmt`.
- Run/build/check current-file and project tasks, project tests, and current-file linting. Tasks save relevant buffers before execution.
- Custom server paths, arguments, environment variables, and configuration.

Not implemented: automatic toolchain installation, dedicated test explorer, VS Code macro expansion views, test/compiler timing CodeLens commands, and string language injections. The pinned grammar may not cover all Jacket syntax extensions.

## Development installation

This extension is not yet published in the Zed extension registry.

The registry already has a [Jai extension](https://github.com/seg4lt/zed-jai) using `jails`. This extension uses Jacket's `jailsp` and CLI tools. Both register the Jai language; use one at a time. A new registry submission must explain this distinction and address the publishing rules on overlapping extensions.

1. Install [Jacket](https://github.com/matteopolak/jacket/blob/main/docs/tools/releases.md). Put `jailsp`, `jaifmt`, and `jacket` on PATH, preserving the standard library layout.
2. Install Rust through rustup and a recent Zed supporting `zed_extension_api 0.7.0`.
3. Disable other Jai language extensions to avoid duplicate language/grammar registrations.
4. Clone this repository. Run **Install Dev Extension** in Zed and select the repository root. The first build needs network access for dependencies and the grammar.
5. Open a Jai project and a `.jai` file. Restart Zed if you changed PATH.

The extension finds `jailsp` on the worktree's PATH. A small stdio proxy adds region support using Zed's managed Node.js runtime; no npm packages are needed. Server arguments, environment and other LSP features pass through.

### Region groups and folding

```jai
//@region UI
//@region Types
Gallery :: struct {
    ready: bool;
}
//@endregion

draw :: () {
}
//@endregion
```

Enable these two [Zed language settings](https://zed.dev/docs/reference/all-settings#lsp-folding-ranges) in user or project settings:

```json
{
  "languages": {
    "Jai": {
      "document_symbols": "on",
      "document_folding_ranges": "on"
    }
  }
}
```

Rebuild the development extension after updating. The Outline Panel groups functions, types, fields and nested regions beneath the region title; its arrows expand/collapse the tree. The outline popup is an indented list. In the editor, a region folds through its matching closing marker. Native `jailsp` folds remain available.

Markers are case-sensitive standalone line comments. `// @region 中文标题` is also supported; starts require a nonempty title, and ends must have no title. Unmatched starts remain single-line outline entries without folding the rest of the file; unmatched ends are ignored. Regions pair within the same brace/bracket/parenthesis scope. Markers in strings (including Jai `#string` bodies) and nested block comments are ignored. With `document_symbols` off, Tree-sitter provides opening-comment navigation only, without region hierarchy.

The proxy caches analysis per document version and does not scan on hover requests. Bounded lifecycle logs are stored in the extension work directory as `region-proxy.log`; LSP document text and parameters are not logged. A runnable example is in `tests/fixtures/paired_regions.jai`.

### File icons

Language detection and file icons are separate in Zed. A file can correctly show **Jai** in the status bar while still having a generic icon in the project tree.

After installing or rebuilding this development extension, run **icon theme selector: toggle** and select **Jacket Icons Dark** or **Jacket Icons Light**. Alternatively, merge this into your global Zed settings:

```json
{
  "icon_theme": {
    "mode": "system",
    "light": "Jacket Icons Light",
    "dark": "Jacket Icons Dark"
  }
}
```

These themes add the Jai icon to Zed's built-in icon defaults. Selecting one replaces your current icon theme; it does not overlay another third-party icon theme. Installation alone does not change your selected theme. If the choices are missing after updating, rebuild the development extension from the Extensions page and restart Zed if needed.

## Configuration

Example Zed `settings.json` (replace Windows paths with your installation):

```json
{
  "lsp": {
    "jailsp": {
      "binary": {
        "path": "C:/Tools/Jacket/bin/jailsp.exe",
        "arguments": [],
        "env": { "JAIC_STDLIB": "C:/Tools/Jacket/stdlib" }
      },
      "settings": {
        "jai": {
          "trusted": false,
          "completion": {
            "autoImport": true,
            "callSnippets": "addParentheses"
          },
          "formatter": { "path": "C:/Tools/Jacket/bin/jaifmt.exe" }
        }
      }
    }
  },
  "languages": {
    "Jai": {
      "language_servers": ["jailsp"],
      "format_on_save": "on",
      "semantic_tokens": "combined"
    }
  }
}
```

Omit `binary` when the server is on PATH, and `env` when Jacket can locate its standard library. Use an absolute `binary.path`; `~` and `${env:NAME}` are not expanded. `binary.env` affects only the server, not terminal tasks. Without a formatter path, `jailsp` looks beside itself and on PATH for `jaifmt`.

Keep the outer `jai` object in `settings`. `initialization_options` takes its contents directly. They merge recursively, with `settings.jai` taking precedence. Configuration must be an object and `trusted` a boolean. Run **Restart Language Server** after changes.

### Compile-time execution and trust diagnostics

The extension defaults to `trusted: false`, disabling `#run`, build metaprograms, and computed `#insert`. This can prevent complete analysis of otherwise valid Jai code.

If a call such as `clamp` reports **`compile-time code is not run in an untrusted workspace`**, the configured execution restriction may be responsible. This is a Jacket diagnostic, not necessarily a source error or a Zed workspace-trust decision.

For a project whose code you trust, set `lsp.jailsp.settings.jai.trusted` to `true` and restart the language server. This permits the project's compile-time code to execute. It is not a security sandbox or an implementation of VS Code's workspace trust system.

### Project settings and tasks

`jailsp` reads `jacket.toml` from the project root:

```toml
[project]
entry = ["main.jai"]
import_path = ["vendor/modules"]
```

Lint and formatter settings also belong there; see Jacket's documentation.

Search for `Jacket:` in **task: spawn** with a saved Jai file open. Tasks run from the worktree root and need `jacket` on the terminal's PATH; the server's `binary.path` does not configure task executables. Current-file tasks save the active buffer; project tasks save all modified buffers and use Jacket's configured or inferred entry. The `main` run button runs the current file.

Tasks execute project code independently of the server's `trusted` setting. Run them only for trusted projects.

## Development checks

```sh
rustup target add wasm32-wasip2
cargo fmt --all --check
node --test tests/regions.test.cjs tests/region-proxy.test.cjs
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release --target wasm32-wasip2
```

[Current Zed versions](https://zed.dev/docs/extensions/developing-extensions) use `wasm32-wasip2`. The output is `target/wasm32-wasip2/release/jacket_zed.wasm`. Development installation builds and loads it automatically. Older Zed versions using `wasm32-wasip1` can build that target instead.

Tests cover configuration validation/merging, query compilation, parsing, outline names, runnable detection, text objects, and identifier-level highlighting for fields and types (including qualified, pointer, array, and parameterized types). The grammar helper fetches a pinned Git revision and compiles its parser and external scanner; the first run needs Git, network access, and a C compiler.

With local Jacket installed, run the real stdio LSP integration test:

```sh
cargo test --locked --test lsp -- --ignored --nocapture
```

Set `JAILSP` to an executable path if it is not on PATH (PowerShell: `$env:JAILSP = 'C:/Tools/Jacket/bin/jailsp.exe'`). These tests launch the region proxy and real server, checking nested outline groups, folds, edits, completion, hover, definitions, references, rename, formatting, and diagnostics with the extension's initialization configuration. Node.js 22+ is needed on PATH, or set `NODE` to its executable. Tests wait for background diagnostics before references and limit response waits to 30 seconds. They do not download tools or change source files. Normal `cargo test` skips these optional tests.

GitHub Actions checks formatting, tests, Clippy, and Wasm builds on Windows and Linux. Both platforms passed the initial run. Local tests passed with Rust stable 1.90.0 and nightly, including real LSP integration with Jacket 0.35.1. Both Wasm targets and isolated Jacket check/build/run/lint/test commands passed.

Manual Zed validation of the submitted commit is still required before registry submission. Install the development extension and open `tests/fixtures/basic.jai`. Check highlighting, outline, completion, hover, definitions, formatting, the `main` button, and a task. Temporarily introduce a type error to verify diagnostics, then undo it. Protocol tests do not verify the editor UI.

## Licensing

Original extension code is MIT licensed. Jacket is installed separately and uses AGPL-3.0-or-later with its upstream exceptions; its source is not bundled or modified here.

The region proxy and tests are adapted from [ctzcs/zed_odin](https://github.com/ctzcs/zed_odin), with Jai-specific scanning and native folding integration. Its MIT notice is retained in `licenses/odin-extension-MIT.txt`.

The [Tree-sitter Jai grammar](https://github.com/constantitus/tree-sitter-jai) is pinned to `3f8ee754d6531a1672d9e36cd54e81580fcec02c` under MIT-0. This extension's queries were written for that grammar.
