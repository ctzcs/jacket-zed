# Jacket for Zed

[![Check extension](https://github.com/ctzcs/jacket-zed/actions/workflows/ci.yml/badge.svg)](https://github.com/ctzcs/jacket-zed/actions/workflows/ci.yml)

[English](README.md)

本扩展尚未上架 Zed 扩展商店。商店已有使用 `jails` 的 Jai 扩展，本项目使用 Jacket 的 `jailsp` 和 CLI。两者都会注册 Jai 语言，请只启用一个；上架审核仍需说明功能区别并满足重复扩展的相关规则。

使用本地 [Jacket](https://github.com/matteopolak/jacket) 工具链的 Jai 语言扩展。首版不自动下载或更新工具链，不依赖 VS Code。

## 功能

- `.jai` 文件识别、Tree-sitter 高亮、括号配对、缩进和函数/类型大纲。
- 可选的明暗图标主题，为文件树里的 `.jai` 文件提供专用 J 字形图标。
- Vim 函数、类型和注释文本对象，以及 `main` 入口旁的运行按钮。
- 启动 `jailsp`，向 Zed 提供补全、悬停、跳转、引用、重命名、诊断、Lint、快速修复、内联提示等标准 LSP 功能；具体展示受 Zed 版本支持情况影响。
- 通过 `jailsp` 调用 `jaifmt`，支持全文和选区格式化。
- Jai 语言任务：运行、构建、检查当前文件或项目，Lint 当前文件，以及运行项目测试；执行前自动保存相关文件。
- 支持自定义服务器路径、参数、环境变量、初始化及工作区配置。

未实现：工具链下载、专用测试浏览器、VS Code 自定义宏展开界面、测试/编译耗时 CodeLens 命令适配、字符串内嵌语言查询。复用的 Jai grammar 不保证覆盖 Jacket 的全部语法扩展。

## 安装开发扩展

1. 从 [Jacket 安装文档](https://github.com/matteopolak/jacket/blob/main/docs/tools/releases.md) 安装工具链，确保 `jailsp`、`jaifmt`、`jacket` 可用。保留安装包的标准库目录结构。
2. 安装 Rust。当前扩展使用 `zed_extension_api 0.7.0`，需要支持该 API 的较新 Zed。
3. 若已安装其他 Jai 语言扩展，先在扩展面板禁用，避免同名语言/grammar 冲突。
4. 在 Zed 扩展面板运行 **Install Dev Extension**，选择此仓库根目录。首次安装需要联网下载 grammar 和 Rust 依赖；Wasm 目标由 Zed 构建流程处理。
5. 打开 Jai 项目目录和 `.jai` 文件。若修改过系统 PATH，请重启 Zed。

没有配置路径时，扩展使用 Zed 工作区的 PATH 查找 `jailsp`。服务器默认使用 stdio，无需添加参数。

### 文件树图标

Zed 的语言识别与文件图标相互独立：右下角显示 **Jai**，不代表文件树已配置 Jai 图标。

安装或重新构建开发扩展后，运行 **icon theme selector: toggle**，选择 **Jacket Icons Dark** 或 **Jacket Icons Light**。也可在 Zed 的全局设置中合并：

```json
{
  "icon_theme": {
    "mode": "system",
    "light": "Jacket Icons Light",
    "dark": "Jacket Icons Dark"
  }
}
```

这两个主题在 Zed 内置默认图标的基础上增加 Jai 图标。选择它们会替换当前图标主题，不会叠加到其他第三方图标主题上；安装本扩展不会自动切换主题。更新后若列表没有这两个选项，请在扩展面板重新构建开发扩展，必要时重启 Zed。

## 设置

在 Zed 的 `settings.json` 中配置，例如 Windows：

```json
{
  "lsp": {
    "jailsp": {
      "binary": {
        "path": "C:/Tools/Jacket/bin/jailsp.exe",
        "arguments": [],
        "env": {
          "JAIC_STDLIB": "C:/Tools/Jacket/stdlib"
        }
      },
      "settings": {
        "jai": {
          "trusted": false,
          "completion": {
            "autoImport": true,
            "callSnippets": "addParentheses"
          },
          "formatter": {
            "path": "C:/Tools/Jacket/bin/jaifmt.exe"
          }
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

- 示例路径需替换为真实安装位置；通过 PATH 找到工具时可以省略 `binary`。标准库可由工具链自动定位时可以省略 `env`。
- `binary.path` 建议使用绝对路径，不展开 `~` 或 `${env:NAME}`。`binary.env` 仅作用于语言服务器，不作用于终端任务。
- `jaifmt` 未指定时，由 `jailsp` 在其相邻目录和 PATH 查找。
- `settings` 需保留外层 `jai`；`initialization_options` 则直接填写 `jai` 内部选项。两者递归合并，同名值以 `settings.jai` 为准。
- 配置必须是 JSON 对象，`trusted` 必须是布尔值；错误配置会在启动服务器前报告，不能写成字符串 `"false"`。
- 修改启动路径、环境变量或配置后，运行 **Restart Language Server**，确保新配置生效。

### 编译期执行与可信项目

扩展默认设置 `trusted: false`，禁用 `#run`、构建元程序和计算式 `#insert`。依赖这些机制的项目可能缺少部分语义结果。

如果出现 `compile-time code is not run in an untrusted workspace`（例如调用 `clamp` 时），这是上述限制产生的语言服务器诊断，不一定是源码错误，也不代表 Zed 将项目判断为不可信。对于你自己可信的项目，将 `lsp.jailsp.settings.jai.trusted` 设为 `true`，然后运行 **Restart Language Server**。这会允许项目代码在编译期间执行。

只在你信任项目代码时，将 `lsp.jailsp.settings.jai.trusted` 改为 `true` 并重启服务器。此设置不是独立的安全沙箱，也没有复刻 VS Code 的工作区信任机制。不要接受不可信项目提供的程序路径、环境变量或 `trusted: true` 配置。

### 项目配置

项目根目录的 `jacket.toml` 由 `jailsp` 读取，例如：

```toml
[project]
entry = ["main.jai"]
import_path = ["vendor/modules"]
```

Lint 与格式化选项也放在 `jacket.toml`，详见 Jacket 文档。保存后由服务器应用配置。

### 构建与运行

打开已保存的 Jai 文件，在 **task: spawn** 中搜索 `Jacket:`。任务从工作区根目录运行，需要终端 PATH 能找到 `jacket`；配置服务器的 `binary.path` 不会改变任务的工具位置。

“当前文件”任务保存当前文件，“项目”任务保存所有已修改文件。项目任务不传文件名，由 Jacket 按 `jacket.toml` 或默认入口名寻找入口。`main` 左侧的运行按钮执行“运行当前文件”。

任务会实际执行项目代码，与语言服务器的 `trusted` 设置独立，仅对可信项目运行。

## 开发验证

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release --target wasm32-wasip2
```

手动构建前用 `rustup target add wasm32-wasip2` 安装目标。[当前 Zed 开发文档](https://zed.dev/docs/extensions/developing-extensions) 使用该目标，产物为 `target/wasm32-wasip2/release/jacket_zed.wasm`；开发安装由 Zed 自行构建和加载，不需要手动复制产物。旧版 Zed 若仍使用 `wasm32-wasip1`，可以按旧目标构建。

`tests/` 包含配置合并和校验、查询编译、基础源代码解析，以及大纲、运行入口和文本对象的实际捕获测试。语法测试辅助 crate 会通过 Git 将固定提交拉取到 Cargo 构建目录，同时编译解析器和外部扫描器，绕过上游 Rust 构建脚本遗漏扫描器的问题；首次测试需要 Git 和网络。缓存标记会核对版本和源码是否存在。

安装本地 Jacket 后，可以通过命令行完成真实 LSP 联调，无需打开编辑器：

```powershell
cargo test --locked --test lsp -- --ignored --nocapture
```

服务器不在 PATH 时，在 PowerShell 中先设置 `$env:JAILSP = 'C:/Tools/Jacket/bin/jailsp.exe'`，其他 shell 使用相应的环境变量语法。该测试使用扩展的初始化配置，通过 stdio 验证补全、悬停、跳转、引用、重命名、格式化和错误诊断；每次响应等待上限为 30 秒，失败时也会清理测试服务器。引用查询会先等待后台编译发布诊断。测试不自动下载工具链、不修改源码，默认 `cargo test` 跳过此项。

GitHub Actions 在 Windows 和 Linux 上执行格式检查、测试、Clippy 和 Wasm 构建，并保存 Wasm 产物。真实 LSP 联调需在有 Jacket 的环境中单独运行。

编辑器手动验收：安装开发扩展，打开 `tests/fixtures/basic.jai`，确认高亮/大纲/补全/诊断/跳转，运行格式化，再查看 `main` 的运行按钮及 Jacket 任务。

## 依赖与许可

本扩展原创代码使用 MIT 许可，不包含或修改 Jacket 源代码。Jacket 工具链独立安装，使用上游 AGPL-3.0-or-later 及其例外条款。

Tree-sitter grammar 来自 [constantitus/tree-sitter-jai](https://github.com/constantitus/tree-sitter-jai)，固定提交 `3f8ee754d6531a1672d9e36cd54e81580fcec02c`，使用 MIT-0 许可。扩展中的查询为针对该 grammar 编写的 Zed 查询。

## 当前验证状态（2026-11-13）

- Windows 本机已通过 11 项配置和语法测试，包含结构体字段及类型标识符高亮回归测试；另外已通过 1 项真实 LSP 集成测试（Jacket 0.35.1）。
- Rust stable 1.90.0 与本机默认 nightly 均通过测试；已通过格式检查、Clippy，以及 `wasm32-wasip2` / `wasm32-wasip1` 发布构建。
- 已用隔离示例验证 Jacket 的检查、构建、运行、Lint 和测试命令；运行输出 `Result: 3`，预期输出测试通过。
- 尚未完成 Zed 界面内的安装验收；LSP 协议联调通过不等同于编辑器 UI 验收。CI 配置已添加，远端执行结果待推送后确认。
