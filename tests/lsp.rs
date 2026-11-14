//! Opt-in checks against a real local Jacket installation (no downloads).
use jacket_zed::server_options;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};
use zed_extension_api::{
    serde_json::{self, json, Value},
    settings::LspSettings,
};

struct Server {
    child: Child,
    input: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
    notifications: Vec<Value>,
}

impl Server {
    fn start() -> Self {
        let binary = std::env::var_os("JAILSP").unwrap_or_else(|| "jailsp".into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let work = root.join("target/region-lsp-test");
        std::fs::create_dir_all(&work).unwrap();
        let mut child = Command::new(std::env::var_os("NODE").unwrap_or_else(|| "node".into()))
            .arg(root.join("resources/jai-region-proxy.cjs"))
            .arg(work)
            .arg(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("install Jacket or set JAILSP to the jailsp executable");
        let input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let (sender, messages) = mpsc::channel();
        std::thread::spawn(move || loop {
            let mut length = None;
            loop {
                let mut header = String::new();
                if output.read_line(&mut header).unwrap_or(0) == 0 {
                    return;
                }
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.strip_prefix("Content-Length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.expect("missing Content-Length")];
            if output.read_exact(&mut body).is_err() {
                return;
            }
            let message = serde_json::from_slice(&body).expect("invalid JSON-RPC response");
            if sender.send(message).is_err() {
                return;
            }
        });
        Self {
            child,
            input,
            messages,
            next_id: 0,
            notifications: Vec::new(),
        }
    }

    fn send(&mut self, message: Value) {
        let body = serde_json::to_vec(&message).unwrap();
        write!(self.input, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.input.write_all(&body).unwrap();
        self.input.flush().unwrap();
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc":"2.0", "method":method, "params":params}));
    }

    fn receive(&mut self, deadline: Instant) -> Value {
        self.messages
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("jailsp exited or did not respond within 30 seconds")
    }

    fn handle_message(&mut self, message: Value) {
        if message.get("id").is_some() && message.get("method").is_some() {
            let result = match message["method"].as_str().unwrap() {
                "workspace/configuration" => Value::Array(
                    message["params"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| match item["section"].as_str() {
                            Some("jai") => server_options(&LspSettings::default()).unwrap(),
                            _ => Value::Null,
                        })
                        .collect(),
                ),
                "client/registerCapability" | "window/workDoneProgress/create" => Value::Null,
                method => panic!("unexpected server request: {method}"),
            };
            self.send(json!({"jsonrpc":"2.0", "id":message["id"], "result":result}));
        } else {
            self.notifications.push(message);
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}));
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let message = self.receive(deadline);
            if message.get("method").is_none() && message["id"] == id {
                assert!(message.get("error").is_none(), "{method}: {message}");
                return message["result"].clone();
            }
            self.handle_message(message);
        }
    }

    fn wait_for_diagnostic(&mut self, uri: &str, require_error: bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if self.notifications.iter().any(|message| {
                message["method"] == "textDocument/publishDiagnostics"
                    && message["params"]["uri"] == uri
                    && message["params"]["diagnostics"]
                        .as_array()
                        .is_some_and(|items| {
                            !require_error || items.iter().any(|item| item["severity"] == 1)
                        })
            }) {
                return;
            }
            let message = self.receive(deadline);
            self.handle_message(message);
        }
    }
}

#[test]
#[ignore = "requires local Jacket and Node; run cargo test --test lsp -- --ignored --nocapture"]
fn local_jacket_region_tree_and_folds() {
    let mut server = Server::start();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let uri = url::Url::from_file_path(root.join("paired_regions.jai"))
        .unwrap()
        .to_string();
    server.request(
        "initialize",
        json!({
            "processId":std::process::id(), "rootUri":url::Url::from_directory_path(root).unwrap().to_string(),
            "capabilities":{"workspace":{"configuration":true}, "textDocument":{
                "documentSymbol":{"hierarchicalDocumentSymbolSupport":true}
            }},
            "initializationOptions":server_options(&LspSettings::default()).unwrap()
        }),
    );
    server.notify("initialized", json!({}));
    server.notify(
        "textDocument/didOpen",
        json!({"textDocument":{
            "uri":uri,"languageId":"jai","version":1,
            "text":include_str!("fixtures/paired_regions.jai")
        }}),
    );
    let params = json!({"textDocument":{"uri":uri}});
    let symbols = server.request("textDocument/documentSymbol", params.clone());
    assert_eq!(symbols[0]["name"], "UI", "{symbols}");
    let types = &symbols[0]["children"][0];
    assert_eq!(types["name"], "Types");
    assert_eq!(types["children"][0]["name"], "Gallery");
    assert_eq!(types["children"][0]["children"][0]["name"], "ready");
    let draw = &symbols[0]["children"][1]["children"][0];
    assert_eq!(draw["name"], "draw");
    assert_eq!(draw["children"][0]["name"], "State");
    assert_eq!(draw["children"][0]["children"][0]["name"], "value");
    assert_eq!(symbols[1]["name"], "main");
    let folds = server.request("textDocument/foldingRange", params.clone());
    let folds = folds.as_array().unwrap();
    for (start, end) in [(0, 15), (1, 6), (8, 14), (10, 12)] {
        assert!(
            folds
                .iter()
                .any(|f| f["kind"] == "region" && f["startLine"] == start && f["endLine"] == end),
            "{folds:?}"
        );
    }
    assert!(
        folds
            .iter()
            .any(|f| f["startLine"] == 2 && f["endLine"] == 4),
        "ordinary struct fold missing: {folds:?}"
    );
    server.notify(
        "textDocument/didChange",
        json!({
            "textDocument":{"uri":uri,"version":2},
            "contentChanges":[{"text":"//@region Unfinished\nmain :: () {}\n"}]
        }),
    );
    let symbols = server.request("textDocument/documentSymbol", params.clone());
    assert_eq!(symbols[0]["name"], "Unfinished");
    assert_eq!(symbols[0]["range"]["end"]["line"], 0);
    assert_eq!(symbols[1]["name"], "main");
    let folds = server.request("textDocument/foldingRange", params);
    assert!(!folds
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["kind"] == "region"));
    server.request("shutdown", Value::Null);
    server.notify("exit", Value::Null);
    println!("Jacket proxy: nested region tree, fields, local variables, ordinary folds and edits passed");
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires local Jacket; run cargo test --test lsp -- --ignored --nocapture"]
fn local_jacket_language_features() {
    let mut server = Server::start();
    // Workspace references require a file on disk, not just an unsaved buffer.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lsp.jai");
    let uri = url::Url::from_file_path(path).unwrap().to_string();
    let root = url::Url::from_directory_path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
    )
    .unwrap()
    .to_string();
    let initialized = server.request(
        "initialize",
        json!({
            "processId": std::process::id(), "rootUri":root,
            "capabilities": {"workspace":{"configuration":true}, "textDocument":{
                "completion":{"completionItem":{"snippetSupport":true}},
                "publishDiagnostics":{"versionSupport":true}
            }},
            "initializationOptions":server_options(&LspSettings::default()).unwrap()
        }),
    );
    assert_eq!(initialized["capabilities"]["hoverProvider"], true);
    assert_eq!(
        initialized["capabilities"]["documentFormattingProvider"],
        true
    );
    server.notify("initialized", json!({}));
    let source = include_str!("fixtures/lsp.jai");
    server.notify(
        "textDocument/didOpen",
        json!({"textDocument":{
            "uri":uri, "languageId":"jai", "version":1, "text":source
        }}),
    );
    // References use the background compiler's results, so wait for its first publication.
    server.wait_for_diagnostic(&uri, false);
    let position = json!({"textDocument":{"uri":uri}, "position":{"line":2,"character":15}});
    let hover = server.request("textDocument/hover", position.clone());
    assert!(hover.to_string().contains("add"), "hover: {hover}");
    let definition = server.request("textDocument/definition", position.clone());
    assert!(
        !definition.is_null() && definition != json!([]),
        "definition: {definition}"
    );
    let completion = server.request("textDocument/completion", position.clone());
    let items = completion
        .as_array()
        .or_else(|| completion["items"].as_array())
        .unwrap();
    assert!(
        items.iter().any(|item| item["label"]
            .as_str()
            .is_some_and(|label| label.starts_with("add"))),
        "completion: {completion}"
    );
    let mut references = position.clone();
    references["context"] = json!({"includeDeclaration":true});
    let references = server.request("textDocument/references", references);
    assert!(
        references.as_array().is_some_and(|items| items.len() >= 2),
        "references: {references}"
    );
    let mut rename = position;
    rename["newName"] = json!("sum");
    let rename = server.request("textDocument/rename", rename);
    assert!(rename.to_string().contains("sum"), "rename: {rename}");
    let formatting = server.request(
        "textDocument/formatting",
        json!({
            "textDocument":{"uri":uri}, "options":{"tabSize":4,"insertSpaces":true}
        }),
    );
    assert!(
        formatting.as_array().is_some_and(|edits| !edits.is_empty()),
        "formatting: {formatting}"
    );
    server.notifications.clear();
    server.notify(
        "textDocument/didChange",
        json!({
            "textDocument":{"uri":uri,"version":2},
            "contentChanges":[{"text":"main :: () { value: int = \"wrong\"; }\n"}]
        }),
    );
    server.wait_for_diagnostic(&uri, true);
    server.notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}));
    assert!(server.request("shutdown", Value::Null).is_null());
    server.notify("exit", Value::Null);
    println!("Jacket: initialization, hover, definition, completion, references, rename, formatting and diagnostics passed");
}
