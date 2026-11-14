use zed::settings::LspSettings;
use zed::{
    serde_json::{Map, Value},
    Command, LanguageServerId, Result, Worktree,
};
use zed_extension_api as zed;

struct JacketExtension;

const REGION_PROXY: &str = include_str!("../resources/jai-region-proxy.cjs");
const REGIONS: &str = include_str!("../resources/regions.cjs");

pub fn region_proxy_command(node: String, directory: &std::path::Path, server: Command) -> Command {
    let mut args = vec![
        directory
            .join("jai-region-proxy.cjs")
            .to_string_lossy()
            .into_owned(),
        directory.to_string_lossy().into_owned(),
        server.command,
    ];
    args.extend(server.args);
    Command {
        command: node,
        args,
        env: server.env,
    }
}

// initialization_options 使用 jai 节的形状；settings 使用 { "jai": { ... } }。
// settings 优先，保证初始化和后续配置请求获得同一份选项。
pub fn server_options(settings: &LspSettings) -> Result<Value> {
    let mut options = Map::new();
    options.insert("trusted".into(), Value::Bool(false));
    if let Some(initial) = &settings.initialization_options {
        merge_options(&mut options, initial, "initialization_options")?;
    }
    if let Some(configuration) = &settings.settings {
        if !configuration.is_object() {
            return Err("jailsp: settings must be an object containing a jai object".into());
        }
        if let Some(jai) = configuration.get("jai") {
            merge_options(&mut options, jai, "settings.jai")?;
        }
    }
    if !options.get("trusted").is_some_and(Value::is_boolean) {
        return Err("jailsp: trusted must be a boolean (true or false)".into());
    }
    Ok(Value::Object(options))
}

fn merge_options(target: &mut Map<String, Value>, value: &Value, name: &str) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("jailsp: {name} must be an object"))?;
    for (key, value) in object {
        if let (Some(Value::Object(existing)), Value::Object(incoming)) =
            (target.get_mut(key), value)
        {
            merge_options(existing, &Value::Object(incoming.clone()), name)?;
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

impl zed::Extension for JacketExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        // Report invalid options before launching a server with an unintended configuration.
        server_options(&settings)?;
        let binary = settings.binary.unwrap_or(zed::settings::CommandSettings {
            path: None,
            arguments: None,
            env: None,
        });
        let command = match binary.path {
            Some(path) if !path.trim().is_empty() => path,
            _ => worktree.which("jailsp").ok_or_else(|| {
                "jailsp was not found. Install Jacket and add it to PATH, or set lsp.jailsp.binary.path."
                    .to_string()
            })?,
        };
        let server = Command {
            command,
            args: binary.arguments.unwrap_or_default(),
            env: binary.env.unwrap_or_default().into_iter().collect(),
        };
        let node = zed::node_binary_path()?;
        // WASI can write extension work, while Node runs in the project directory.
        std::fs::write("regions.cjs", REGIONS)
            .map_err(|error| format!("jailsp: cannot write region support: {error}"))?;
        std::fs::write("jai-region-proxy.cjs", REGION_PROXY)
            .map_err(|error| format!("jailsp: cannot write region proxy: {error}"))?;
        let directory = std::env::current_dir()
            .map_err(|error| format!("jailsp: cannot locate extension work: {error}"))?;
        Ok(region_proxy_command(node, &directory, server))
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(Some(server_options(&settings)?))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(Some(
            zed::serde_json::json!({ "jai": server_options(&settings)? }),
        ))
    }
}

zed::register_extension!(JacketExtension);
